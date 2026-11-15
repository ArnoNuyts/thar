# CP1 differential contract harness

A deterministic, TypeScript-only snapshot of the current `todo.txt`
implementation, plus a candidate runner and a seeded-bug proof. It is the
oracle the Rust port is checked against from CP2 onwards; no Rust is involved
here.

- Plan: [`docs/rust-port/PLAN.md`](../../docs/rust-port/PLAN.md) §5 (CP1), §8.
- Corpus and expectations: [`testdata/port/`](../../testdata/port/README.md)
  (CP0).
- Contract: `tools/port/contract.ts` (CLI), `tools/port/build.ts` (builder),
  `tools/port/adapter.ts` (parse/serialize adapter + mutations),
  `tools/port/compare.ts` (diff engine), `tools/port/golden.ts` (CP0 check).
- Tests: [`unit-tests/port-contract.test.ts`](../../unit-tests/port-contract.test.ts).
- WASM candidate (CP2b): `tools/port/candidates/wasm.mjs`.

## Commands

Run from the repository root. CI sets `TZ=UTC` and the CLI also forces
`process.env.TZ = "UTC"` in its own process, so `clockLocal` names one instant
on every host; the pinned clock is built from UTC calendar components and the
contract bytes are timezone-independent (verified with UTC, New York and
Kolkata).

```sh
npm run port:contract                       # JSONL to stdout (~3.4 MB)
npx vite-node tools/port/contract.ts --out /tmp/contract.jsonl

npm run port:contract:check                 # build twice + golden + oracle candidate
npx vite-node tools/port/contract.ts --check --verify-golden --candidate-self
npx vite-node tools/port/contract.ts --check --candidate "cargo run --bin contract --quiet"
npx vite-node tools/port/contract.ts --check --candidate-file candidate.jsonl

npm run port:selftest                       # seeded-bug proof

# CP2b: the Rust core compiled to WASM as the candidate (needs wasm-pack)
wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg
npm run port:contract:wasm                  # golden + the WASM candidate
```

`npm run port:contract` prints npm's own `> thar@0.6.1 port:contract` banner on
**stdout**, which would corrupt the JSONL. For a machine-readable stream use
`npm run --silent port:contract`, `npx vite-node tools/port/contract.ts`, or
`--out <file>` (the contract goes to the file and the status line to stderr).
When stdout is a terminal the CLI also prints a one-line hint on stderr.

Options (`vite-node tools/port/contract.ts --help`):

| Flag                            | Meaning                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `--corpus <dir>`                | Fixture directory, default `testdata/port`                                   |
| `--clock <yyyy-MM-ddTHH:mm:ss>` | Pinned wall-clock time, UTC, default `2026-11-15T12:00:00`                   |
| `--out <file>`                  | Write the oracle contract to a file instead of stdout                        |
| `--check`                       | Compare a candidate contract with a freshly built oracle                     |
| `--candidate <command>`         | Candidate command (spawned with `--corpus <dir> --clock <iso> --out <file>`) |
| `--candidate-file <file>`       | Compare with a precomputed JSONL contract (CP2's Rust crate)                 |
| `--candidate-self`              | Use this harness as the candidate (exercises the protocol)                   |
| `--verify-golden`               | Also compare the contract with `testdata/port/expected.json`                 |
| `--max-diffs <n>`               | Print at most `n` diffs, default 20, minimum 1                               |
| `--mutate <name>`               | **Test only.** Build a deliberately broken contract                          |
| `--list-mutations`              | Print the seeded mutations and their proof fixture as JSON                   |

`--max-diffs 0` is rejected: a cap of 0 would make every difference invisible
and turn a tampered candidate into a false pass. `--candidate`,
`--candidate-file` and `--candidate-self` require `--check`, and `--out` must
not name the same file as `--candidate-file` (the oracle would be compared with
itself). `--check` on a corpus without any `*.txt` fixture is an error, not an
empty match.

The test-only hook can also be set with `THAR_PORT_MUTATION=<name>` in the
environment, for wrappers that cannot append arguments; `--mutate` wins when
both are set. The variable is stripped from the spawned candidate's
environment, otherwise a globally exported hook would mutate both sides and a
wrong candidate would pass.

Exit codes:

- **0** — the contracts match (and, with `--verify-golden`, the golden file
  matches too).
- **2** — mismatch: at least one difference, or candidate output that is not
  valid UTF-8.
- **1** — harness error: bad arguments (including `--max-diffs 0`), a corpus
  directory that cannot be read, an empty corpus, an unreadable fixture, an
  invalid `--clock`, a candidate that could not be spawned, exited non-zero or
  wrote no output, or a `--check` that cannot run (no candidate, or `--out`
  naming the same file as `--candidate-file`).

Diffs and status go to stderr so stdout stays valid JSONL. Harness errors are
one bounded line, never a stack trace. When the diff walk stops at the
`--max-diffs` cap the header says `at least N diff(s)` instead of implying that
the list is complete.

## Contract format

JSONL: one compact JSON object per fixture, UTF-8, LF, final newline, sorted
bytewise by filename. Keys are always in the order below — the schema is part
of the contract, so a candidate that emits a subset, a superset or reordered
keys fails.

Parsed fixture:

```json
{
  "fixture": "tags.txt",
  "sha256": "<sha256 of the raw file bytes>",
  "kind": "todos",
  "readLimits": {
    "maxFileBytes": 1048576,
    "maxReadTodos": 10000,
    "maxLineChars": 8192
  },
  "clockLocal": "2026-11-15T12:00:00",
  "todoCount": 12,
  "serialized": { "sha256": "...", "bytes": 491 },
  "todos": [
    {
      "text": "single tag",
      "state": "todo",
      "priority": null,
      "completionDate": null,
      "creationDate": null,
      "projects": [],
      "contexts": [],
      "tags": [["alpha", "one"]],
      "isDone": false,
      "isHidden": false,
      "isVisibleInOverview": true,
      "isOverdue": false,
      "toString": "single tag alpha:one",
      "hash": "single tag alpha:one"
    }
  ]
}
```

Rejected fixture:

```json
{
  "fixture": "control-nul.txt",
  "sha256": "...",
  "kind": "error",
  "readLimits": {
    "maxFileBytes": 1048576,
    "maxReadTodos": 10000,
    "maxLineChars": 8192
  },
  "clockLocal": "2026-11-15T12:00:00",
  "error": {
    "name": "TodoControlCharacterError",
    "code": "CONTROL_CHARACTER",
    "lineNumber": 2,
    "codePoint": 0,
    "message": "Todo file line 2 contains ..."
  }
}
```

- `todos` is **every** parsed todo, including all 10 000 rows of the runtime
  `large-10000.txt` fixture; `expected.json` pins only samples for that file,
  the contract does not sample.
- `tags` is an ordered `[key, value]` pair list; a duplicate key keeps its
  insertion order and its `string[]` value.
- Dates are `yyyy-MM-dd` or `null`.
- `toString`/`hash` are the production serializer output (`getHash()` is
  `toString()`); `serialized` is the whole-file write path
  (`serializeTodosForWrite(todos)`, i.e.
  `todos.map(toString).join("\n") + "\n"` plus the write-time guard).
- Error records contain `name`, `code`, the numeric fields the production
  error carries (`lineNumber`, `length`, `maxLineChars`, `lineCount`,
  `maxReadTodos`, `actualBytes`, `maxBytes`, `codePoint`) in that fixed order,
  and `message` last. Absent numeric fields are omitted.
- `readLimits` and `clockLocal` are repeated per record so a candidate cannot
  silently run with different limits or clock.

The contract mirrors the production read/write path exactly:

```ts
validateTodoFileContent(raw.toString("utf8"), getReadLimits())
  .filter((line) => line.trim())
  .map((line) => new Todo(line));
// ...
serializeTodosForWrite(todos); // writeTodosToFile's serializer + guard
```

## Determinism

- The clock is pinned by replacing `globalThis.Date` with a subclass: `new
  Date()` and `Date.now()` return `2026-11-15T12:00:00` (CP0's clock, UTC),
  while explicit constructors and `instanceof Date` keep working. Pinning is
  idempotent: pinning the same wall time again leaves the installed constructor
  untouched (no nested subclasses), and a different time replaces it with a
  fresh subclass of the real `Date`.
- Filenames are sorted with `Buffer.compare` (bytewise), never the host locale.
- Records are built with a fixed key order; no timestamps, absolute paths, host
  names or randomness appear in the output.
- Two runs over the same corpus are byte-identical; the self-test and
  `unit-tests/port-contract.test.ts` assert it.

### Read limits come from the environment

`readLimits` is not hard-coded: it is the production `getReadLimits()`
(`logic/limits.ts`), which starts from the committed defaults
(`maxFileBytes: 1048576`, `maxReadTodos: 10000`, `maxLineChars: 8192`) and
honours `THAR_MAX_FILE_BYTES`, `THAR_MAX_READ_TODOS` and `THAR_MAX_LINE_CHARS`.
Those defaults are part of the contract — `testdata/port/expected.json` pins
them — and an override is caught rather than silently accepted:

```sh
THAR_MAX_READ_TODOS=500 npx vite-node tools/port/contract.ts --verify-golden
# port-contract: 2 diff(s)
#   <corpus> readLimits.maxReadTodos: expected 10000, actual 500
#   large-10000.txt kind: expected "todos", actual "error"
```

An invalid override (non-numeric, zero, negative) is a harness error (exit 1)
carrying the production `InvalidLimitError` message. A candidate must implement
the same defaults and the same three variables; the contract repeats
`readLimits` on every record so a candidate running with different limits
cannot match.

## Candidate protocol

A candidate is any command that:

1. receives `--corpus <dir> --clock <iso> --out <file>` appended to its own
   tokens,
2. writes the JSONL contract above to `<file>`,
3. exits `0`.

### CP2 execution contract

How the harness runs a candidate (`--candidate` and `--candidate-self`):

| Aspect            | Behaviour                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working directory | `process.cwd()`, the directory the harness was started in. Run it from the repository root; the default corpus is `testdata/port` under that root, and a candidate that resolves fixtures relatively depends on it too.                              |
| Command line      | Split on whitespace with quotes and backslash escapes (never through a shell: no pipes, globs or variables), then `--corpus <absolute dir> --clock <iso> --out <temp file>` is appended.                                                             |
| Environment       | Inherited from the harness, minus `THAR_PORT_MUTATION`.                                                                                                                                                                                              |
| Output channel    | stdout is ignored; the contract must be written to `--out`. stderr is discarded on success and its first 2 000 characters are shown when the candidate fails.                                                                                        |
| Buffer cap        | 16 MiB for the captured stdout and stderr of one run.                                                                                                                                                                                                |
| Timeout           | 120 s for one run; a timeout is reported as "candidate could not run".                                                                                                                                                                               |
| Exit code         | A candidate that cannot be spawned, exits non-zero, or exits 0 without writing the file is a **harness error** (exit 1). Content problems (invalid UTF-8, CRLF, missing final LF, wrong keys, extra or missing records) are **mismatches** (exit 2). |

`--clock` is pinned by the golden file: `testdata/port/expected.json` records
`clockLocal: "2026-11-15T12:00:00"`, so `--check --verify-golden --clock X`
always fails for any other `X`. Drop `--verify-golden` when you deliberately
want a different instant on both sides.

Anything else fails: a non-zero exit, invalid UTF-8, CRLF, a missing final
newline, a subset/superset/reordered field, an extra or missing record, or a
differently ordered fixture list. Invalid UTF-8 is reported as "candidate
output is not valid UTF-8" for both `--candidate-file` and a spawned candidate,
instead of decoding to U+FFFD and blaming the JSON.

At CP2 the Rust crate can either implement the same CLI or write a precomputed
JSONL file that is compared with `--candidate-file`.

### WASM candidate (CP2b)

`tools/port/candidates/wasm.mjs` is a plain Node ESM candidate over the Rust
core; no build step and no TypeScript loader:

```sh
wasm-pack build crates/thar-wasm --release --target nodejs --out-dir pkg
npm run port:contract:wasm
# equivalent:
npx vite-node tools/port/contract.ts --check --verify-golden \
  --candidate "node tools/port/candidates/wasm.mjs"
```

- It loads `crates/thar-wasm/pkg/thar_wasm.js` (resolved from the repository
  root, not the working directory) and exits 1 with the build command when the
  package is missing, so a forgotten `wasm-pack build` is never mistaken for a
  contract mismatch.
- Fixtures are read as raw bytes and decoded with `Buffer#toString("utf8")`
  (lossy), exactly like the reader; the raw-file SHA-256 comes from
  `node:crypto` over those bytes.
- `--clock` supplies the pinned day for `isOverdue`/`isVisibleInOverview`
  (`YYYY-MM-DD` prefix); an invalid value is a candidate error, not a panic.
- The three read limits come from `THAR_MAX_FILE_BYTES`,
  `THAR_MAX_READ_TODOS` and `THAR_MAX_LINE_CHARS` with the production defaults
  and validation, and are passed to `parseFileWithLimits` so a candidate running
  with different limits cannot match.
- TODO: those defaults, the variable names and the positive-integer validation
  are now duplicated in `logic/limits.ts`, this candidate and the Rust
  `ReadLimits`. A shared limits manifest — the harness writing the effective
  limits next to the contract, or one small generated module both sides import —
  would remove the drift risk. Not done at CP2b: it would add a file to
  `testdata/port/**` and change the candidate protocol.
- The whole-file `serialized` field is derived from the records as CP1 defines
  it: `todos.map(toString).join("\n") + "\n"`. The write-time control-character
  guard is not part of that definition (see "Coverage limits").

`npm run port:contract:check -- --candidate "…"` cannot be used for this: that
script already passes `--candidate-self`, and the CLI accepts exactly one
candidate selector. Use `port:contract:wasm` (or drop `--candidate-self` from an
explicit `vite-node` invocation).

## Seeded bugs (`tools/port/self-test.mjs`)

Mutations are applied in `tools/port/adapter.ts` — in the harness's
parse/serialize adapter, never by editing `logic/**` at runtime. Each one
simulates a specific porting mistake, and the self-test requires the comparator
to report the listed fixture and field:

| Mutation                  | Simulated bug                                                                                                    | Caught on                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `drop-done-marker`        | serializer forgets the leading `x ` of a completed todo while still parsing the done state                       | `crlf.txt` `serialized.sha256`                   |
| `accept-invalid-date`     | date parser rolls an impossible leading date forward (`2023-02-29` → `2023-03-01`) instead of leaving it literal | `leading-dates-done-invalid.txt` `todos[0].text` |
| `collapse-duplicate-tags` | duplicate tag keys serialize only their first value (`beta:one,two` → `beta:one`) while parsing keeps the array  | `due-threshold-hidden.txt` `serialized.sha256`   |
| `ignore-hidden`           | drops the `h:` rule: `isHidden` is always false and visibility ignores hidden                                    | `due-threshold-hidden.txt` `todos[7].isHidden`   |
| `reorder-tags`            | tags are kept in a map and serialized in reverse key order instead of insertion order                            | `due-threshold-hidden.txt` `serialized.sha256`   |

The self-test also proves two unmutated runs are byte-identical, that
`--verify-golden` matches `testdata/port/expected.json` field by field, that
the unmutated oracle passes the candidate protocol, that `--max-diffs 0` is a
usage error while a capped walk over a tampered candidate still fails, and that
a globally exported `THAR_PORT_MUTATION` does not reach the candidate. It
bundles the harness once with Vite into a temp directory (startup with
`vite-node` and `date-fns` is ~2.4 s per process) so a dozen spawned runs
finish in about ten seconds.

The mutated candidate is **the harness itself** rerun with `--mutate <name>`,
not a second implementation. The proof shows that the comparator catches a
contract that is wrong for the documented reason; it does not prove that a Rust
port behaves like the TypeScript one.

`--verify-golden` on its own is not silent: on success it prints
`port-contract: match (golden, 28 fixture record(s), 3432008 bytes)`, and with
`--check` the header names both checks (`golden + candidate`).

## Coverage limits

This is a differential check: it proves a candidate agrees with the TypeScript
oracle on this corpus, not that it is a complete port.

- **Write-time validation.** The oracle's `serialized` field is produced by the
  production `serializeTodosForWrite` (the serializer inside `writeTodosToFile`),
  so that exact code path — including its write-time control-character guard —
  runs for every fixture. No fixture makes the guard throw, though: a port that
  skips write-time validation still matches, because parsed todos are always
  safe to serialize. CP2 must implement the write-time rules
  (`TodoControlCharacterError`, the line-length/line-count re-validation and
  the byte-size guard in `writeTodosToFile`) on its own evidence, such as the
  CP0 tests in `unit-tests/port-corpus.test.ts`.
- **Byte-size guard.** `tools/port/build.ts` mirrors the reader's post-read
  byte check (`readTodosFromFile`), not `writeTodosToFile`'s write-size guard;
  committed fixtures are far below 1 MiB.
- **UI and I/O.** Indexes, navigation, the TUI and the file-system layer
  (`Runtime`, atomic writes, file watching) are outside the contract.

## CI

`.github/workflows/ci.yml` has a `port-contract` job (ubuntu-latest, 10 minute
timeout) that runs `npm ci`, `npm run port:contract:check` and
`npm run port:selftest`. It is independent of the existing matrix jobs and is
the oracle.

`.github/workflows/rust.yml`'s `wasm` job builds `thar-wasm`, enforces the size
budget, runs the Node smoke test, then runs `npm ci` and
`npm run port:contract:wasm`. Its path filter includes `crates/**`,
`testdata/port/**`, `tools/port/**`, `logic/core-wasm.ts`, `logic/limits.ts`,
`unit-tests/core-wasm.test.ts` and `package.json`, so a change to the candidate,
the adapter or its tests re-runs WASM parity. The Node matrix does not require
Rust or a built `pkg/`; the WASM job is the only place the candidate runs in CI.

## Maintaining

Behaviour changes are deliberate: update `testdata/port/expected.json`, its
README and this document in the same reviewed commit. `--verify-golden` makes
CP0 and CP1 drift visible; the schema test in
`unit-tests/port-contract.test.ts` catches accidental field changes.
