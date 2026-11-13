/**
 * Reproducible benchmark for the main list view.
 *
 * Renders the real provider tree and list components against a fake terminal,
 * then sends arrow-key escape sequences through the real input path. Reports:
 *
 *  - wall time per keypress (input -> committed frame)
 *  - React commit time (Profiler actualDuration)
 *  - Ink output generation time (its own onRender metric)
 *  - `Todo.isOverdue()` calls per key (row-render proxy: TodoItem currently
 *    calls it exactly once per row render)
 *  - `Todo.getHash()` calls per key (proxy for selection bookkeeping work)
 *
 * Production render options come from `utils/ink-options.ts`, the same source
 * the app uses, so the benchmark cannot silently drift from the shipped
 * configuration. Color is forced to truecolor because piped output would
 * otherwise make focus changes byte-identical and hide their render cost.
 *
 * Usage: npx vite-node scripts/benchmark-list.tsx [--todos=3000] [--keys=200]
 *        [--warmup=20] [--runs=3] [--rows=40] [--debug] [--maxfps=120]
 */
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import chalk from "chalk";
import { Box, render } from "ink";
import { Profiler } from "react";

import { ActionBar } from "../components/ActionBar.tsx";
import { HiddenIndicator } from "../components/HiddenIndicator.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { TodoList } from "../components/TodoList.tsx";
import { FocusProvider } from "../contexts/focus-context.tsx";
import { ModalProvider } from "../contexts/modal-context.tsx";
import {
  NavigationProvider,
  useNavigation,
} from "../contexts/navigation-context.tsx";
import { SearchProvider } from "../contexts/search-context.tsx";
import { SuggestionProvider } from "../contexts/suggestion-context.tsx";
import { ToasterProvider } from "../contexts/toaster-context.tsx";
import { useTodo } from "../contexts/todo-context.tsx";
import { UpdateProvider } from "../contexts/update-context.tsx";
import { Todo } from "../logic/todo.ts";
import { INK_PERFORMANCE_OPTIONS } from "../utils/ink-options.ts";
import { Runtime } from "../utils/runtime.ts";
import { MockTodoProvider } from "../unit-tests/mock-todo-provider.tsx";

// Deterministic ANSI output regardless of how the benchmark is launched.
chalk.level = 3;

const DOWN = "\x1b[B";
const UP = "\x1b[A";

type FrameMetrics = { renderTime: number };

class BenchStdout extends EventEmitter {
  columns = 120;
  rows: number;
  isTTY = true;
  frames: string[] = [];

  constructor(rows: number) {
    super();
    this.rows = rows;
  }

  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
}

class BenchStdin extends EventEmitter {
  isTTY = true;
  private data: Buffer | null = null;

  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}

  read = () => {
    const data = this.data;
    this.data = null;
    return data;
  };

  write = (value: string) => {
    const data = Buffer.from(value);
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
}

const parseArg = (name: string, fallback: number) => {
  const arg = Runtime.args.find((value) => value.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(name.length + 3));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const makeTodos = (count: number): Todo[] => {
  const contexts = ["@home", "@work", "@errand", "@phone", "@computer"];
  const projects = ["+thar", "+site", "+admin"];
  const states = ["", "x ", "(A) ", "(B) ", "(C) ", "(D) ", "(E) ", "(F) "];
  const todos: Todo[] = [];

  for (let index = 0; index < count; index++) {
    const context = contexts[index % contexts.length];
    const project = projects[index % projects.length];
    const state = states[index % states.length];
    const due =
      index % 7 === 0
        ? `due:${index % 2 === 0 ? "2020-01-01" : "2099-01-01"}`
        : "";
    const threshold = index % 11 === 0 ? "t:2020-01-01" : "";
    const recurrence = index % 13 === 0 ? "rec:1w" : "";
    const text = [
      state,
      `Task ${index}`,
      `with enough text to make the row worth measuring`,
      context,
      project,
      due,
      threshold,
      recurrence,
    ]
      .filter(Boolean)
      .join(" ");
    todos.push(new Todo(text));
  }

  return todos;
};

const subtreeTimes = new Map<string, number[]>();
const recordSubtree = (id: string, duration: number) => {
  const times = subtreeTimes.get(id);
  if (times) {
    times.push(duration);
  } else {
    subtreeTimes.set(id, [duration]);
  }
};

const AppContent = ({ rows }: { rows: number }) => {
  const { todos } = useTodo();
  return (
    <Box flexDirection="column" height={rows}>
      <Profiler
        id="SearchInput"
        onRender={(id, _phase, duration) => recordSubtree(id, duration)}
      >
        <SearchInput todos={todos} />
      </Profiler>
      <Profiler
        id="TodoList"
        onRender={(id, _phase, duration) => recordSubtree(id, duration)}
      >
        <TodoList />
      </Profiler>
      <Profiler
        id="ActionBar"
        onRender={(id, _phase, duration) => recordSubtree(id, duration)}
      >
        <ActionBar />
      </Profiler>
      <Profiler
        id="HiddenIndicator"
        onRender={(id, _phase, duration) => recordSubtree(id, duration)}
      >
        <HiddenIndicator />
      </Profiler>
    </Box>
  );
};

const NavigationWrapper = ({ children }: { children: React.ReactNode }) => {
  const { todos } = useTodo();
  return <NavigationProvider todos={todos}>{children}</NavigationProvider>;
};

type SelectionRef = { current: symbol | undefined };

const SelectionProbe = ({ target }: { target: SelectionRef }) => {
  const { selectedTodoId } = useNavigation();
  target.current = selectedTodoId;
  return null;
};

type Counters = {
  overdueCalls: number;
  hashCalls: number;
};

const installTodoCounters = (): (() => void) => {
  const originalIsOverdue = Todo.prototype.isOverdue;
  const originalGetHash = Todo.prototype.getHash;

  Todo.prototype.isOverdue = function () {
    counters.overdueCalls++;
    return originalIsOverdue.call(this);
  };
  Todo.prototype.getHash = function () {
    counters.hashCalls++;
    return originalGetHash.call(this);
  };

  return () => {
    Todo.prototype.isOverdue = originalIsOverdue;
    Todo.prototype.getHash = originalGetHash;
  };
};

const counters: Counters = { overdueCalls: 0, hashCalls: 0 };

type Sample = {
  wallMs: number;
  reactMs: number;
  inkMs: number;
  commits: number;
  overdueCalls: number;
  hashCalls: number;
};

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];

  // Linear interpolation so p50 is a true median for even-sized samples.
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
};

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0);
const mean = (values: number[]) =>
  values.length === 0 ? 0 : sum(values) / values.length;

const run = async ({
  todosCount,
  keys,
  warmup,
  throttled,
  maxFps,
  rows,
}: {
  todosCount: number;
  keys: number;
  warmup: number;
  throttled: boolean;
  maxFps: number;
  rows: number;
}) => {
  const todos = makeTodos(todosCount);
  const stdout = new BenchStdout(rows);
  const stderr = new BenchStdout(rows);
  const stdin = new BenchStdin();
  const selectionRef: SelectionRef = { current: undefined };

  let frameWaiters: (() => void)[] = [];
  const frame = () =>
    new Promise<void>((resolve) => {
      frameWaiters.push(resolve);
    });

  const inkSamples: number[] = [];
  const reactSamples: number[] = [];
  let commitsThisKey = 0;

  const onRender = (metrics: FrameMetrics) => {
    inkSamples.push(metrics.renderTime);
    const waiters = frameWaiters;
    frameWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const onProfilerRender = (_id: string, _phase: string, duration: number) => {
    reactSamples.push(duration);
    commitsThisKey++;
  };

  const instance = render(
    <Profiler id="bench" onRender={onProfilerRender}>
      <ToasterProvider>
        <UpdateProvider options={{ enabled: false }}>
          <MockTodoProvider initialTodos={todos}>
            <FocusProvider>
              <SuggestionProvider>
                <SearchProvider>
                  <ModalProvider>
                    <NavigationWrapper>
                      <SelectionProbe target={selectionRef} />
                      <AppContent rows={rows} />
                    </NavigationWrapper>
                  </ModalProvider>
                </SearchProvider>
              </SuggestionProvider>
            </FocusProvider>
          </MockTodoProvider>
        </UpdateProvider>
      </ToasterProvider>
    </Profiler>,
    {
      ...INK_PERFORMANCE_OPTIONS,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: !throttled,
      maxFps,
      exitOnCtrlC: false,
      patchConsole: false,
      // The fake stdout reports a TTY, but Ink also checks CI. Force the
      // interactive path so the benchmark measures real frame output.
      interactive: true,
      onRender,
    },
  );

  const removeCounters = installTodoCounters();

  const press = async (sequence: string) => {
    // Claim the next frame before sending input so a synchronous render can
    // never slip past the waiter.
    const painted = frame();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      stdin.write(sequence);
      await Promise.race([
        painted,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("frame timeout")), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let cursorStep = 0;
  let direction: 1 | -1 = 1;

  const measure = async () => {
    if (todosCount <= 1) {
      throw new Error("--todos must be greater than 1 to measure navigation");
    }

    // Stay inside the list: walk down to the end, then reverse. This keeps a
    // low --todos/--keys ratio usable instead of timing out on a no-op key.
    if (cursorStep >= todosCount - 1) direction = -1;
    else if (cursorStep <= 0) direction = 1;

    const sequence = direction === 1 ? DOWN : UP;
    try {
      await press(sequence);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `no frame after ${direction === 1 ? "down" : "up"} at todo ${cursorStep}/${todosCount} (selected: ${String(selectionRef.current)}): ${reason}`,
      );
    }
    cursorStep += direction;
  };

  try {
    // Settle the initial mount and focus effects.
    await measure();

    for (let index = 0; index < warmup; index++) {
      await measure();
    }

    const samples: Sample[] = [];
    const subtreeTotals = new Map<string, number>();

    for (let index = 0; index < keys; index++) {
      counters.overdueCalls = 0;
      counters.hashCalls = 0;
      commitsThisKey = 0;
      reactSamples.length = 0;
      inkSamples.length = 0;
      subtreeTimes.clear();

      const startedAt = performance.now();
      await measure();
      const wallMs = performance.now() - startedAt;

      for (const [id, times] of subtreeTimes) {
        subtreeTotals.set(id, (subtreeTotals.get(id) ?? 0) + sum(times));
      }

      samples.push({
        wallMs,
        reactMs: sum(reactSamples),
        inkMs: sum(inkSamples),
        commits: commitsThisKey,
        overdueCalls: counters.overdueCalls,
        hashCalls: counters.hashCalls,
      });
    }

    const wall = samples.map((sample) => sample.wallMs);
    const react = samples.map((sample) => sample.reactMs);
    const ink = samples.map((sample) => sample.inkMs);

    return {
      todosCount,
      keys,
      wall: {
        mean: mean(wall),
        p50: percentile(wall, 50),
        p95: percentile(wall, 95),
        max: Math.max(...wall),
        total: sum(wall),
      },
      react: {
        mean: mean(react),
        p50: percentile(react, 50),
        p95: percentile(react, 95),
        total: sum(react),
      },
      ink: {
        mean: mean(ink),
        p50: percentile(ink, 50),
        p95: percentile(ink, 95),
        total: sum(ink),
      },
      commitsPerKey: mean(samples.map((sample) => sample.commits)),
      overdueCallsPerKey: mean(samples.map((sample) => sample.overdueCalls)),
      hashCallsPerKey: mean(samples.map((sample) => sample.hashCalls)),
      subtrees: Object.fromEntries(
        [...subtreeTotals].map(([id, total]) => [id, total / keys]),
      ),
      // Includes Ink's synchronized-output and cursor control writes, so this
      // is the number of stdout chunks, not strictly the number of frames.
      stdoutWrites: stdout.frames.length,
      outputBytes: sum(stdout.frames.map((value) => value.length)),
    };
  } finally {
    removeCounters();
    instance.unmount();
    instance.cleanup();
  }
};

const format = (value: number) => value.toFixed(2);

const todosCount = parseArg("todos", 3000);
const keys = parseArg("keys", 200);
const warmup = parseArg("warmup", 20);
const runs = parseArg("runs", 3);
const throttled = !Runtime.args.includes("--debug");
const maxFps = parseArg("maxfps", INK_PERFORMANCE_OPTIONS.maxFps);
const rows = parseArg("rows", 40);
type RunResult = Awaited<ReturnType<typeof run>>;

const results: RunResult[] = [];
for (let index = 0; index < runs; index++) {
  results.push(
    await run({ todosCount, keys, warmup, throttled, maxFps, rows }),
  );
}

const medianOf = (pick: (result: (typeof results)[number]) => number) =>
  percentile(results.map(pick), 50);

console.log(`\nList navigation benchmark — ${todosCount} todos, ${keys} keys`);
console.log(
  `mode: ${throttled ? `production (interactive, ${maxFps} fps throttle)` : "debug (unthrottled)"}`,
);
console.log(`color level: ${chalk.level} (forced truecolor)`);
console.log();
console.log(
  [
    "metric".padEnd(28),
    ...results.map((_, index) => `run ${index + 1}`.padStart(12)),
    "median".padStart(12),
  ].join(""),
);
console.log("-".repeat(28 + results.length * 12 + 12));

const tableRows: [string, (result: (typeof results)[number]) => string][] = [
  ["wall p50 (ms/key)", (r) => format(r.wall.p50)],
  ["wall mean (ms/key)", (r) => format(r.wall.mean)],
  ["wall p95 (ms/key)", (r) => format(r.wall.p95)],
  ["wall max (ms/key)", (r) => format(r.wall.max)],
  ["react mean (ms/key)", (r) => format(r.react.mean)],
  ["react p95 (ms/key)", (r) => format(r.react.p95)],
  ["ink output mean (ms/key)", (r) => format(r.ink.mean)],
  ["commits per key", (r) => format(r.commitsPerKey)],
  ["Todo.isOverdue calls/key", (r) => format(r.overdueCallsPerKey)],
  ["Todo.getHash calls/key", (r) => format(r.hashCallsPerKey)],
  ["stdout writes (ANSI)", (r) => String(r.stdoutWrites)],
  ["output bytes", (r) => String(r.outputBytes)],
];

for (const [label, pick] of tableRows) {
  console.log(
    label.padEnd(28) +
      results.map((result) => pick(result).padStart(12)).join("") +
      medianOf((result) => Number(pick(result)))
        .toString()
        .padStart(12),
  );
}

const subtreeIds = new Set<string>();
for (const result of results) {
  for (const id of Object.keys(result.subtrees)) subtreeIds.add(id);
}
for (const id of subtreeIds) {
  const values = results.map((result) => result.subtrees[id] ?? 0);
  console.log(
    `react ${id} mean (ms/key)`.padEnd(28) +
      values.map((value) => format(value).padStart(12)).join("") +
      format(medianOf((result) => result.subtrees[id] ?? 0)).padStart(12),
  );
}

console.log();
