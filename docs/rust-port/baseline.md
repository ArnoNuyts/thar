# CP0 — measured performance baseline

- **Date:** 2026-11-15
- **Branch / commit:** `rust-port/cp0-baseline` @ `a419fcf013aa06aa5e1c9691442f071bef97c3c0`
- **Base:** `origin/feature/rust-port` (which contains `origin/release/next` plus the port docs)
- **Purpose:** record what this machine measures **before** any Rust code exists, so
  every later checkpoint in [`PLAN.md`](./PLAN.md) §5 can be compared against a
  number produced by the same commands.
- **Scope:** documentation only. No production code, tests, `package.json` or CI
  were changed by this checkpoint.

## 1. Summary

- **A keypress costs ~23 ms at 50 todos and ~25 ms at 3 000 todos** (wall p50,
  production Ink options, 120×40 fake terminal, 200 keys × 3 runs). Navigation
  cost does not grow with list size between these two points.
- **Ink's frame output is the dominant cost** (~17–20 ms per key, 70–80 % of
  the keypress). React commit is ~2.6–3.0 ms (~11 %). The domain model
  (`isOverdue`/`getHash`) is 2.3–2.9 and 1.0 calls per key respectively, i.e.
  noise.
- **Startup is 2.02 s p50** for `node dist/main.js --help`; **76 % of it is
  loading `date-fns`** (~1.55 s, measured by ablation), **22 % is Ink**
  (~0.45 s), **2 % is Node itself** (~43 ms).
- **Peak RSS is 218 MB** for that same command at default V8 flags, and
  **94 MB** for `import("ink") + import("react")` alone. V8 young-generation
  sizing accounts for a large part of the difference: the same run peaks at
  **120 MB** with `--max-semi-space-size=1`.
- The plan's numbers reproduce within ±10 % on this machine, with three
  exceptions recorded in §6: 3 000-todo keypress and React time are _lower_ here
  than in the plan, `isOverdue` is called **2.3–2.9×** per key rather than the
  plan's flat "×3", and the plan's 89 MB memory figure covers only
  `ink`+`react`, not a full app process (218 MB).

## 2. Headline table

Production configuration throughout: `INK_PERFORMANCE_OPTIONS`
(`incrementalRendering: true`, `maxFps: 120`), 120 columns × 40 rows fake
terminal, truecolor forced, 200 measured keys per run after 20 warmup keys,
3 runs per invocation, two invocations per list size. Values are medians of
those 3 runs unless noted; "spread" is the difference between the two
invocations' medians.

| Metric                                      |     50 todos |               3 000 todos | Notes                        |
| ------------------------------------------- | -----------: | ------------------------: | ---------------------------- |
| Wall p50 per key                            | 23.2–23.5 ms |              24.6–25.0 ms | spread 0.3–0.4 ms            |
| Wall mean per key                           | 23.9–24.1 ms |              26.4–26.6 ms |                              |
| Wall p95 per key                            | 27.2–27.9 ms |              31.8–31.9 ms |                              |
| Wall max per key                            | 74.8–76.7 ms |              77.4–81.8 ms | single-key outliers, see §7  |
| Ink output generation (mean)                |      16.9 ms |                   19.7 ms | 70–74 % of wall              |
| React commit (mean, dev build)              |       2.6 ms |                    3.0 ms | 11 % of wall                 |
| React commit p95                            |       3.5 ms |                    3.8 ms |                              |
| React commits per key                       |         1.00 |                      1.00 |                              |
| `Todo.isOverdue` calls per key              |         2.27 |                      2.93 | render-count proxy           |
| `Todo.getHash` calls per key                |         1.00 |                      1.00 |                              |
| stdout writes per run (ANSI chunks)         |          668 |                       668 | output size, not frame count |
| output bytes per run                        |      778 712 |                 1 852 288 |                              |
| Startup, `node dist/main.js --help` (p50)   |              |              **2 018 ms** | 7 interleaved rounds         |
| Startup min / max                           |              |          1 955 / 2 334 ms |                              |
| Peak RSS, same command (p50)                |              |                **218 MB** | min 216, max 251 MB          |
| Peak RSS, `import("ink") + import("react")` |              |                     94 MB | matches the plan's ~89 MB    |
| Built bundle `dist/main.js`                 |              | 207.07 kB / 52.20 kB gzip | Vite SSR build               |

## 3. Environment

| Item          | Value                                                                                                                                                                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date (UTC)    | 2026-11-15T05:03Z                                                                                                                                                                                                                               |
| Kernel        | `Linux ece9795806d7 6.18.59-0-lts #1-Alpine SMP PREEMPT_DYNAMIC 2026-10-27 14:58:36 x86_64 GNU/Linux`                                                                                                                                           |
| Userland      | Debian GNU/Linux 13 (trixie) — container on the kernel above, not bare metal                                                                                                                                                                    |
| CPU           | Intel(R) Core(TM) i3-7100U CPU @ 2.40 GHz, 2 cores/socket × 2 threads, 1 socket → **4 logical CPUs**                                                                                                                                            |
| RAM           | 7.6 GiB visible (8 GB nominal); swap 4.0 GiB, 3.0 GiB already used                                                                                                                                                                              |
| Load at start | `2.15 0.90 0.53` (5-min/1-min); other worktrees and agents share this host                                                                                                                                                                      |
| Node          | v26.12.0 (`.nvmrc`, resolved via mise)                                                                                                                                                                                                          |
| npm           | 11.20.0                                                                                                                                                                                                                                         |
| App version   | `@arnoarnoarno/thar` 0.6.1 (built from this commit)                                                                                                                                                                                             |
| Terminal      | **No TTY in this agent.** All app measurements use the benchmark's fake stdout/stdin at **120×40** with `isTTY = true`; startup measurements discard stdout entirely. Truecolor is forced (`chalk.level = 3`) so focus changes are byte-visible |

## 4. Methodology

### 4.1 List navigation

`npm run bench:list` runs `scripts/benchmark-list.tsx` through `vite-node`. The
script renders the real provider tree plus `TodoList`, `SearchInput`,
`ActionBar` and `HiddenIndicator` against a fake 120×40 terminal, then sends
real arrow-key escape sequences through Ink's input path. Per key it records
wall time from input write to committed frame, React `Profiler`
`actualDuration`, Ink's own `onRender` time, commit count, and the number of
`Todo.isOverdue()` / `Todo.getHash()` calls. Ink options come from
`utils/ink-options.ts`, the same module the app uses, so the benchmark cannot
drift from the shipped configuration.

Defaults used unchanged: `--todos=<N> --keys=200 --warmup=20 --runs=3 --rows=40`,
production throttle (interactive, 120 fps). Each size was run twice; a third,
earlier 50-todo invocation was discarded as a warmup for the `vite-node`
transform cache.

### 4.2 Startup

`node dist/main.js --help` as a fresh child process, measured from
`child_process.spawn()` to the child's `exit` event with `perf_hooks`, stdout
and stderr discarded. Seven rounds were run **round-robin** across four
variants (full app, `import("date-fns")`, `import("ink")`, bare `node -e ''`)
so that concurrent load on the host affects every variant equally.

`/usr/bin/time` is not installed in this container, so peak RSS comes from a
`--import` probe that prints `process.resourceUsage().maxRSS` (KiB, identical
to `/usr/bin/time -v`'s "Maximum resident set size") at process exit. The
app figure was cross-checked by sampling `/proc/<pid>/status:VmHWM` every 2 ms
during three further runs: 217 MB, 217 MB, 217 MB — consistent with 218 MB.

### 4.3 Attribution

Two supporting measurements, both cheap:

- `node --cpu-prof dist/main.js --help`: 47 % of sampled CPU is
  `node:internal/modules/package_json_reader` (1.28 s of 2.71 s sampled) and
  13 % is GC — i.e. ESM resolution of a large dependency graph, not app code.
- Ablation in a throwaway copy of `dist/` (never committed; `dist/` is
  gitignored): replacing the `import ... from "date-fns"` specifier with a
  throwing stub drops startup from 2 018 ms to **464 ms** p50 (5 runs:
  536, 540, 458, 461, 464 ms) and peak RSS from 218 MB to **96 MB**. That is
  the 1.55 s / 122 MB attributed to `date-fns` above.

### 4.4 Gate

`npm test` and `npm run check` (`typecheck`, `lint`, `fmt:check`) — CP0 gate.
See §8.

## 5. Raw runs

### 5.1 List navigation, 50 todos — invocation A

```text
List navigation benchmark — 50 todos, 200 keys
mode: production (interactive, 120 fps throttle)
color level: 3 (forced truecolor)

metric                             run 1       run 2       run 3      median
----------------------------------------------------------------------------
wall p50 (ms/key)                  22.90       23.56       23.45       23.45
wall mean (ms/key)                 23.86       24.87       24.06       24.06
wall p95 (ms/key)                  27.08       29.74       27.92       27.92
wall max (ms/key)                  73.29       76.72       77.61       76.72
react mean (ms/key)                 2.57        2.66        2.64        2.64
react p95 (ms/key)                 3.32        3.56        3.56        3.56
ink output mean (ms/key)           16.86       17.63       16.94       16.94
commits per key                     1.00        1.00        1.00           1
Todo.isOverdue calls/key            2.27        2.27        2.27        2.27
Todo.getHash calls/key              1.00        1.00        1.00           1
stdout writes (ANSI)                 668         668         668         668
output bytes                      778712      778712      778712      778712
react SearchInput mean (ms/key)        0.05        0.04        0.04        0.04
react TodoList mean (ms/key)        2.34        2.42        2.40        2.40
react HiddenIndicator mean (ms/key)        0.01        0.01        0.01        0.01
```

### 5.2 List navigation, 50 todos — invocation B

```text
metric                             run 1       run 2       run 3      median
----------------------------------------------------------------------------
wall p50 (ms/key)                  23.17       22.63       23.44       23.17
wall mean (ms/key)                 23.89       23.70       24.63       23.89
wall p95 (ms/key)                  27.19       26.47       34.85       27.19
wall max (ms/key)                  73.08       74.77       79.52       74.77
react mean (ms/key)                 2.61        2.57        2.68        2.61
react p95 (ms/key)                 3.52        3.53        3.82        3.53
ink output mean (ms/key)           16.87       16.76       17.54       16.87
commits per key                     1.00        1.00        1.00           1
Todo.isOverdue calls/key            2.27        2.27        2.27        2.27
Todo.getHash calls/key              1.00        1.00        1.00           1
stdout writes (ANSI)                 668         668         668         668
output bytes                      778712      778712      778712      778712
react TodoList mean (ms/key)        2.37        2.34        2.45        2.37
```

### 5.3 List navigation, 3 000 todos — invocation A

```text
metric                             run 1       run 2       run 3      median
----------------------------------------------------------------------------
wall p50 (ms/key)                  25.30       24.62       24.61       24.62
wall mean (ms/key)                 26.56       25.86       26.43       26.43
wall p95 (ms/key)                  31.78       29.38       32.31       31.78
wall max (ms/key)                  73.19       77.40       81.65        77.4
react mean (ms/key)                 3.01        2.93        3.11        3.01
react p95 (ms/key)                 3.84        3.72        3.84        3.84
ink output mean (ms/key)           19.70       19.24       19.66       19.66
commits per key                     1.00        1.00        1.00           1
Todo.isOverdue calls/key            2.93        2.93        2.93        2.93
Todo.getHash calls/key              1.00        1.00        1.00           1
stdout writes (ANSI)                 668         668         668         668
output bytes                     1852288     1852288     1852288     1852288
react TodoList mean (ms/key)        2.78        2.71        2.89        2.78
```

### 5.4 List navigation, 3 000 todos — invocation B

Run 1 of this invocation is visibly contaminated by host load (p95 72 ms,
max 93 ms); run 3 shows the same in `react p95`. The medians below are still
the honest medians, but treat the p95 as an upper bound.

```text
metric                             run 1       run 2       run 3      median
----------------------------------------------------------------------------
wall p50 (ms/key)                  27.33       24.96       25.01       25.01
wall mean (ms/key)                 35.63       26.49       26.64       26.64
wall p95 (ms/key)                  72.15       31.91       30.89       31.91
wall max (ms/key)                  92.91       77.43       81.75       81.75
react mean (ms/key)                 4.11        3.10        3.10         3.1
react p95 (ms/key)                 8.70        4.20        3.77         4.2
ink output mean (ms/key)           26.70       19.60       19.94       19.94
commits per key                     1.00        1.00        1.00           1
Todo.isOverdue calls/key            2.93        2.93        2.93        2.93
Todo.getHash calls/key              1.00        1.00        1.00           1
react TodoList mean (ms/key)        3.83        2.87        2.87        2.87
```

### 5.5 Startup and peak RSS (7 interleaved rounds)

```text
app (dist/main.js --help)
  wall ms: min 1955 | p50 2018 | max 2334
  peak RSS MB: min 216 | p50 218 | max 251
  samples: 2334, 1955, 2099, 2018, 2031, 1967, 1976

import("date-fns")
  wall ms: min 1581 | p50 1630 | max 1830
  peak RSS MB: min 393 | p50 422 | max 424
  samples: 1830, 1581, 1692, 1596, 1630, 1712, 1614

import("ink")
  wall ms: min 431 | p50 452 | max 515
  peak RSS MB: min 90 | p50 94 | max 95
  samples: 431, 515, 436, 433, 452, 500, 477

bare node (-e '')
  wall ms: min 39 | p50 43 | max 47
  peak RSS MB: min 43 | p50 45 | max 46
  samples: 39, 44, 44, 42, 41, 47, 43
```

An independent earlier batch of 11 app startups (same method, no RSS probe)
gave p50 1974.5 ms, min 1942.8 ms, max 2379.3 ms — consistent with the table.

### 5.6 Supporting measurements

```text
CPU profile attribution, node --cpu-prof dist/main.js --help (2 714 ms sampled):
  1 280 ms  47.2 %  node:internal/modules/package_json_reader
    356 ms  13.1 %  (garbage collector)
    188 ms   6.9 %  node:internal/modules/esm/utils (compileSourceTextModule)
    174 ms   6.4 %  node:internal/modules/helpers (getPackageScopeConfig)

date-fns ablation (throwaway dist copy, 5 runs):
  wall p50 464 ms (536, 540, 458, 461, 464)
  peak RSS 93–97 MB
```

Bundle: `dist/main.js` 207.07 kB (gzip 52.20 kB), sourcemap 448.22 kB, built
from 83 modules in 98 ms.

## 6. Comparison with PLAN.md §2

"Confirmed" = within ±10 % of the plan. Both numbers are kept; nothing is
dropped silently.

| Plan §2 claim                               |  Plan (this repo) |                      Measured here | Verdict                                                                                   |
| ------------------------------------------- | ----------------: | ---------------------------------: | ----------------------------------------------------------------------------------------- |
| Wall p50 per key, 50 todos                  |           22.1 ms |                       23.2–23.5 ms | confirmed (+5 %)                                                                          |
| Wall p50 per key, 3 000 todos               |           29.9 ms |                       24.6–25.0 ms | **materially different** (−17 %); this host/keypress mix is faster                        |
| Ink output generation, 50 / 3 000           |    16.4 / 23.5 ms |                     16.9 / 19.7 ms | 50 confirmed; 3 000 **materially lower** (−16 %)                                          |
| React commit, 50 / 3 000                    |      2.5 / 3.8 ms |                       2.6 / 3.0 ms | 50 confirmed; 3 000 **materially lower** (−20 %)                                          |
| Ink share of keypress                       |             ~75 % |                            70–74 % | confirmed                                                                                 |
| React share of keypress                     |             ~12 % |                               11 % | confirmed                                                                                 |
| `isOverdue` ×3 per key, `getHash` ×1        |       3 / 1 calls |         **2.27** / 1.00 (50 todos) | **materially different**: 2.93/key at 3 000, so not a fixed "×3"                          |
| `Todo` calls cost ~0.007–0.008 ms per key   | ~0.007 / 0.008 ms |                       not measured | call counts only; cost not re-measured at CP0                                             |
| Todos parsed/sorted/filtered 0.25 / 58.9 ms |    0.25 / 58.9 ms |                       not measured | outside the required CP0 set (navigation-only benchmark)                                  |
| Flat from 3 k to 10 k todos                 |              flat |                       not measured | 10 k not re-measured at CP0                                                               |
| Startup, `node dist/main.js --help`         |            ~2.0 s |                       2 018 ms p50 | confirmed                                                                                 |
| Startup dominated by `import("date-fns")`   |            ~1.5 s |                  1.55 s (ablation) | confirmed                                                                                 |
| `import("ink")` share                       |         0.4–0.5 s |                         0.45 s p50 | confirmed                                                                                 |
| Node itself                                 |            ~0.1 s |                        0.043 s p50 | confirmed (lower)                                                                         |
| `import("ink") + import("react")` peak RSS  |            ~89 MB |                          94 MB p50 | confirmed                                                                                 |
| Resident memory baseline row ("90 MB+")     |            90 MB+ | **218 MB** peak for a real app run | **materially different**: the plan's 89–90 MB is the ink+react import, not a full process |
| Built bundle                                |         207 KB JS |          207.07 kB / 52.20 kB gzip | confirmed                                                                                 |

### 6.1 Targets (§2) with this baseline filled in

Targets are unchanged; the "Baseline here" column is what CP0 measured on this
machine, so Phases 3/4/7 can be gated against it.

| Metric (release build, 120×40, 40 rows) |                                       Baseline here |            Plan baseline |                 Target |
| --------------------------------------- | --------------------------------------------------: | -----------------------: | ---------------------: |
| Keypress CPU                            |                      16.9–19.7 ms (Ink output mean) |                 16–24 ms |                 ≤ 1 ms |
| Keypress end-to-end, local              |                 23.2–25.0 ms p50 / 27.2–31.9 ms p95 |                 22–30 ms | ≤ 3 ms p50, ≤ 8 ms p95 |
| Startup, warm cache                     |                                        2 018 ms p50 |                  0.2–2 s |                ≤ 20 ms |
| Load 10 000 todos                       |                                        not measured |                    56 ms |                ≤ 10 ms |
| Search keystroke, 10 000 todos          |                                        not measured |                   317 ms |                 ≤ 5 ms |
| Resident memory                         | 218 MB peak (120 MB with `--max-semi-space-size=1`) |                   90 MB+ |                ≤ 20 MB |
| Core WASM (raw / gzip)                  |                                  n/a (no crate yet) |                        — |    ≤ 250 KB / ≤ 100 KB |
| Release binary per target               |    207.07 kB JS + `node_modules` (365 MB installed) | 207 KB JS + node_modules |                ≤ 10 MB |

## 7. Caveats

- **Shared host.** Load average was `2.15` at the start of the run and other
  worktrees/agents were active; several individual keys exceeded 70 ms and one
  3 000-todo run reached p95 72 ms. Medians of 3 runs per invocation are stable
  (0.3–0.4 ms spread on p50), but **p95/max and peak RSS are upper bounds** on
  this machine, not clean-room numbers.
- **No TTY.** The benchmark drives a fake 120×40 stdout/stdin with
  `isTTY = true` and forces truecolor. Real terminal size, font and terminal
  emulator are not part of these numbers.
- **React commit times come from a dev-mode build** (no minification, dev
  `react-dom`), and are therefore an upper bound on production commit cost — as
  PLAN.md §2 already notes ("~0 in prod").
- **Peak RSS is process-shape dependent.** The full app peaks at 218 MB with
  default V8 flags, but at 120 MB with `--max-semi-space-size=1`; a standalone
  `node -e 'await import("date-fns")'` peaks at 422 MB by itself for the same
  reason (95 MB with the small semi-space). Compare RSS only between runs made
  the same way. The 218 MB figure excludes app state (no todo file is loaded
  for `--help`) and is _not_ a live-heap measurement.
- **`/usr/bin/time` is not installed.** Peak RSS was taken from
  `process.resourceUsage().maxRSS` at exit via an `--import` probe and
  cross-checked with `/proc/<pid>/status:VmHWM` sampling; the two agree within
  1 MB.
- **`isOverdue` count differs from the plan** (2.27/key at 50 todos, 2.93/key
  at 3 000). It is a render-count proxy, not a cost; the discrepancy is a doc
  correction, not a regression — it is one call per rendered row plus the
  sort/filter pass, so it tracks visible/overdue rows rather than a constant 3.
- **Not re-measured at CP0:** 10 000-todo scaling, visible-row scaling
  (10/40/80), parse/sort/filter cost, search keystroke cost, and per-call
  `Todo` method cost. They remain the plan's numbers (§2) and are repeated in
  §6 as unverified here.
- **Bundle size is from this commit** (Vite 8.3.7, 83 modules); it will move as
  the port lands, which is exactly why it is recorded.

## 8. Reproduction

Run from the repository root, in this order:

```bash
# 0. Toolchain: Node 26.12.0 from .nvmrc, npm from packageManager
node -v   # v26.12.0
npm -v    # 11.20.0
npm ci

# 1. List navigation (2 invocations per size; 3 runs each inside)
npm run bench:list -- --todos=50
npm run bench:list -- --todos=50
npm run bench:list -- --todos=3000
npm run bench:list -- --todos=3000

# 2. Production bundle (207.07 kB / 52.20 kB gzip in this run)
npm run build

# 3. Startup, 7 interleaved rounds. Equivalent to /tmp/opencode/startup-matrix.mjs:
#    spawn(node, ["dist/main.js", "--help"]) measured from spawn() to "exit",
#    stdout discarded. Any Node script using child_process + perf_hooks works.
node dist/main.js --help

# 4. Peak RSS: /usr/bin/time if available, otherwise a --import probe that
#    prints process.resourceUsage().maxRSS at exit:
#    process.on("exit", () => console.error(process.resourceUsage().maxRSS))
node --import ./rss-probe.mjs dist/main.js --help

# 5. CPU attribution (optional)
node --cpu-prof --cpu-prof-dir=/tmp/prof dist/main.js --help

# 6. Gate
npm test
npm run check
```

`bench:list` accepts `--todos=`, `--keys=`, `--warmup=`, `--runs=`, `--rows=`,
`--debug` (unthrottled) and `--maxfps=`. Defaults are the ones used here:
200 keys, 20 warmup, 3 runs, 40 rows, production 120 fps throttle.
