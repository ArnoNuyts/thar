import { spawn } from "node:child_process";
import { watch } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export type RuntimePlatform = "windows" | "darwin" | "linux";

export type FsEventKind =
  | "any"
  | "access"
  | "create"
  | "modify"
  | "remove"
  | "rename"
  | "other";

export type FsEvent = {
  kind: FsEventKind;
  paths: string[];
  flag?: string;
};

export interface FsWatcher extends AsyncIterable<FsEvent> {
  close(): void;
}

export type WriteFileOptions = {
  append?: boolean;
  create?: boolean;
  mode?: number;
  signal?: AbortSignal;
};

export type CommandOptions = {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: "piped" | "inherit" | "null";
  stdout?: "piped" | "inherit" | "null";
  stderr?: "piped" | "inherit" | "null";
};

export type CommandOutput = {
  success: boolean;
  code: number;
  signal: NodeJS.Signals | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export type SpawnedCommand = {
  stdin: {
    getWriter(): {
      write(data: Uint8Array): Promise<void>;
      close(): Promise<void>;
    };
  };
  status: Promise<{ success: boolean; code: number }>;
};

const toPath = (path: string | URL) => path;

const toStdio = (value: CommandOptions["stdin"]) => {
  if (value === "inherit") return "inherit";
  if (value === "null") return "ignore";
  return "pipe";
};

export class RuntimeCommand {
  readonly command: string;
  readonly options: CommandOptions;

  constructor(command: string, options: CommandOptions = {}) {
    this.command = command;
    this.options = options;
  }

  async output(): Promise<CommandOutput> {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: [toStdio(this.options.stdin), "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) =>
        resolve({ code: exitCode, signal: exitSignal }),
      );
    });

    return {
      success: code === 0,
      code: code ?? 1,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  }

  spawn(): SpawnedCommand {
    const child = spawn(this.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: [
        toStdio(this.options.stdin),
        toStdio(this.options.stdout),
        toStdio(this.options.stderr),
      ],
    });

    if (!child.stdin) {
      throw new Error(
        `Command "${this.command}" was not spawned with piped stdin`,
      );
    }

    const stdin = child.stdin;
    stdin.on("error", () => {
      // The command may close stdin early; callers observe the exit status.
    });
    child.stdout?.resume();
    child.stderr?.resume();

    return {
      stdin: {
        getWriter() {
          return {
            async write(data: Uint8Array) {
              if (!stdin.write(data)) {
                await new Promise<void>((resolve) =>
                  stdin.once("drain", resolve),
                );
              }
            },
            async close() {
              stdin.end();
            },
          };
        },
      },
      status: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ success: code === 0, code: code ?? 1 }),
        );
      }),
    };
  }
}

export function watchFs(filename: string): FsWatcher {
  const directory = dirname(filename);
  const target = basename(filename);
  const watcher = watch(directory, { persistent: true });
  const queue: FsEvent[] = [];
  const waiters: ((event: FsEvent | undefined) => void)[] = [];
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    while (waiters.length > 0) {
      waiters.shift()?.(undefined);
    }
  };

  const push = (event: FsEvent) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      queue.push(event);
    }
  };

  watcher.on("change", (eventType, changed) => {
    if (changed && String(changed) !== target) return;
    // Editors often replace a file atomically, which Node reports as
    // "rename" rather than "change". Treat both as content changes so the
    // reload path is not silently skipped.
    push({
      kind: eventType === "rename" ? "rename" : "modify",
      paths: [filename],
    });
  });
  watcher.on("error", close);

  return {
    close,
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const event =
          queue.shift() ??
          (await new Promise<FsEvent | undefined>((resolve) => {
            waiters.push(resolve);
          }));
        if (!event) return;
        yield event;
      }
    },
  };
}

export const Runtime = {
  platform: (process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux") as RuntimePlatform,
  args: process.argv.slice(2),
  cwd: process.cwd,
  exit: process.exit,
  consoleSize: () => ({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }),
  readTextFile: (path: string | URL) => readFile(toPath(path), "utf8"),
  writeTextFile: async (
    path: string | URL,
    data: string,
    options?: WriteFileOptions,
  ) => {
    await writeFile(toPath(path), data, {
      flag: options?.append ? "a" : options?.create === false ? "r+" : "w",
      mode: options?.mode,
      signal: options?.signal,
    });
  },
  stat: async (path: string | URL) => {
    const info = await stat(toPath(path));
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymlink: info.isSymbolicLink(),
      size: info.size,
      mtime: info.mtime,
      atime: info.atime,
      birthtime: info.birthtime,
    };
  },
  readDir: async function* (path: string | URL) {
    const entries = await readdir(toPath(path), { withFileTypes: true });
    for (const entry of entries) {
      yield {
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      };
    }
  },
  mkdir: (path: string | URL, options?: { recursive?: boolean }) =>
    mkdir(toPath(path), { recursive: options?.recursive ?? false }),
  makeTempDir: () => mkdtemp(join(tmpdir(), "todotui-")),
  remove: (path: string | URL, options?: { recursive?: boolean }) =>
    rm(toPath(path), { recursive: options?.recursive ?? false, force: false }),
  watchFs,
  unrefTimer: (timer: unknown) => {
    if (
      typeof timer === "object" &&
      timer !== null &&
      "unref" in timer &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  },
  Command: RuntimeCommand,
};

export type RuntimeApi = typeof Runtime;
