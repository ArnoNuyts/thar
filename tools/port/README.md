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
  `tools/port/compare.ts` (diff engine), `tools/port/golden.ts` (CP0 check),
  `tools/port/candidate.ts` (shared candidate protocol).
- Rows contract (CP3b1): `tools/port/rows.ts` (oracle, import-safe),
  `tools/port/rows-cli.ts` (CLI), `tools/port/bench-rows.ts` (perf).
- Tests: [`unit-tests/port-contract.test.ts`](../../unit-tests/port-contract.test.ts),
  [`unit-tests/port-rows.test.ts`](../../unit-tests/port-rows.test.ts).
- WASM candidate (CP2b): `tools/port/candidates/wasm.mjs`.
- WASM rows candidate (CP3b1): `tools/port/candidates/wasm-rows.mjs`.

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

# CP3b1: the live rows contract (sort/filter/search/rows over WASM)
npm run port:contract:rows                  # TS only: candidate protocol + self-check
npm run port:contract:rows:wasm             # the WASM candidate (needs pkg/)
npx vite-node tools/port/bench-rows.ts      # perf table (needs pkg/)
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

## Rows contract (CP3b1)

The row model is the host's per-keystroke composition:

```ts
createIndexes(filterBySearch(filterHidden(sortByImportance(todos)), query));
```

CP3b1 pins it live against `thar-wasm`'s `buildRows` instead of keeping the
CP3a `crates/thar-core/tests/domain-expectations.json` snapshot.

- Oracle: `tools/port/rows.ts` (import-safe builder) + `tools/port/rows-cli.ts`
  (CLI).
- Candidate: `tools/port/candidates/wasm-rows.mjs`.
- Tests: [`unit-tests/port-rows.test.ts`](../../unit-tests/port-rows.test.ts).

```sh
npm run port:contract:rows        # TS only: oracle + candidate protocol + self-check
npm run port:contract:rows:wasm   # the WASM candidate (needs crates/thar-wasm/pkg)
npx vite-node tools/port/bench-rows.ts   # the perf table below (needs pkg/)
```

Coverage: every parseable `*.txt` fixture (the rejection fixtures are skipped;
the CP1 contract owns them) plus one generated 1 000-todo list, for a fixed
12-query set and `showHidden=false`/`true`. That is **504 records / 4 449 890
bytes**, and the WASM candidate reproduces them with **0 diffs** (the TS oracle
also passes its own candidate protocol via `--candidate-self`). The generated
list is built in TS and handed to the candidate in a temp manifest, so there is
no second committed corpus.

The query set is `""`, `"   "`, `work`, `@work`, `+project`, `alpha beta`,
`!!!`, `MILK`, `ΟΔΟΣ`, `aΣ.Α`, `aβ́Σ.`, `due:` — the CP3a set (empty,
whitespace-only, both prefixes, two terms, punctuation-only, uppercase, Unicode)
plus the reverse final-sigma shapes.

### Record format

One compact JSON object per (fixture, query, showHidden), fixture bytewise, then
the query list order, then `false` before `true`. Keys are in this fixed order:

```json
{
  "fixture": "tags.txt",
  "query": "MILK",
  "terms": ["milk"],
  "showHidden": false,
  "clockLocal": "2026-11-15T12:00:00",
  "todoCount": 12,
  "rows": [
    { "type": "context", "contextName": "None", "todoCount": 3 },
    { "type": "todo", "number": 1, "index": 5 }
  ],
  "order": [5, 0, 2]
}
```

- `terms` is the host-normalized `extractSearchTerms` output for `query`; the
  core never folds case, so the candidate must use this verbatim.
- `index` is the todo's position in the parsed fixture, `number` the 1-based
  todo-row number, `order` every todo row's index in row order.
- `todoCount` is the number of todo rows (headers excluded).
- Context headers keep their final group count (including the uncategorised
  `"None"` header).

### Candidate protocol

```sh
node tools/port/candidates/wasm-rows.mjs \
  --corpus <dir> --clock <iso> --manifest <file> --out <file>
```

The manifest carries the query list with its host-normalized terms, the
`showHidden` values, the effective read limits (from `getReadLimits`, so a
`THAR_MAX_*` override cannot make the two sides disagree about which fixture
parses) and the generated lines. The candidate:

1. parses each text with `parseFileWithLimits`;
2. derives one `searchView` per todo from the **WASM parse output** with
   JavaScript `toLowerCase` (this closes the parse→view gap: the oracle also
   lowercases the TS parse output);
3. calls `buildRows` once per (query, showHidden) with the manifest's terms and
   writes the oracle's record shape.

A missing `pkg/` is a loud failure, never a contract mismatch.

### Self-check

`--selftest` (part of `npm run port:contract:rows`) builds a reduced contract
twice — the bytes must be identical — and requires the comparator to catch every
seeded mutation. The mutations live in the oracle's composition, not in
`logic/**`:

| Mutation                | Simulated bug                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `drop-none-header`      | omits the uncategorised `"None"` header (treats it as a display detail)              |
| `miscount-headers`      | reports `todoCount: 1` on every header (counts headers instead of their group)       |
| `case-sensitive-search` | matches terms against raw, non-lowercased fields (folds only one side of the search) |
| `ignore-threshold`      | derives visibility from `h:` alone (drops the future `t:` threshold rule)            |

The self-check runs on a slice of the corpus plus a 120-todo generated list so
it stays fast; the full contract is the CI gate.

### Perf evidence (CP3b1)

`tools/port/bench-rows.ts` measures the same 120×40, whole-list row build as
`createIndexes` (the viewport does not change the work), from the generated
list at 50 / 3 000 / 10 000 todos, on Node 26.12.0 with the release WASM
package on the development machine (a snapshot, not a CI gate). Times are
milliseconds; p50/p95 of the full stateless call.

| todos  | path          | empty query   | one term (`work`) | multi term (`alpha beta`) |
| ------ | ------------- | ------------- | ----------------- | ------------------------- |
| 50     | TS oracle     | 0.44 / 0.84   | 0.42 / 0.78       | 0.41 / 0.45               |
| 50     | WASM boundary | 0.45 / 0.70   | 0.42 / 0.76       | 0.41 / 0.44               |
| 3 000  | TS oracle     | 126.9 / 133.4 | 128.7 / 158.3     | 128.1 / 133.3             |
| 3 000  | WASM boundary | 25.3 / 26.0   | 24.7 / 26.0       | 24.4 / 24.9               |
| 10 000 | TS oracle     | 523.7 / 532.6 | 530.9 / 553.2     | 528.4 / 593.9             |
| 10 000 | WASM boundary | 85.1 / 87.3   | 81.9 / 83.0       | 81.3 / 89.7               |

The stateless boundary is ~6.4× faster than the TypeScript pipeline at
10 000 todos, but it is not yet the PLAN's **≤ 5 ms** search-keystroke target.
`parse+views` (once per load, median of five) is 42.3 ms TS / 75.7 ms WASM at
10 000. The per-keystroke split at 10 000 (p50, 2 562 KB request):

| stage                                             |          p50 |
| ------------------------------------------------- | -----------: |
| `JSON.stringify` of the request (JS)              |   8.3–9.2 ms |
| `buildRows` (Rust JSON decode + row build + JSON) | 72.7–73.9 ms |
| `JSON.parse` of the response (JS)                 |   0.0–2.0 ms |

The core alone (`cargo test --release -p thar-core --test rows_perf --
--ignored --nocapture`) is **7.9–8.2 ms p50 / 8.6–10.9 ms p95** at 10 000
todos, of which `sort_by_importance` is 5.6 ms and `create_rows` 0.3 ms. So the
domain work is close to the target; the marshalling dominates. CP3b2 should:

- add a **stateful handle** (`load` once per list/mutation, `build` per
  keystroke) so the 2.5 MB request is decoded once, not per key;
- precompute collation ranks/sort keys once per load (the 5.6 ms sort), which
  also addresses PLAN §5 CP3's sort-key TODO;
- keep the stateless `buildRows` as the differential contract's entry point.

These are reported, not silently accepted: CP3b1 does not wire `THAR_CORE=rust`
(that is CP3b2), so no user path regresses.

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
- **UI and I/O.** Navigation, the TUI and the file-system layer (`Runtime`,
  atomic writes, file watching) are outside the contract. Indexes/rows are
  covered by the CP3b1 rows contract above, not by the CP1 record set.
- **Serialization of DTO-built todos.** The rows contract feeds the parse
  records back through `buildRows`; the two round-trip flags
  (`datesInText`, `completionDateInText`) are not in the CP1 record set, so the
  candidate leaves them `false`. Row building does not read them (only
  `toString` does), so the omission cannot change a row; CP3b2's stateful
  adapter will carry the real flags from its own parse.

## CI

`.github/workflows/ci.yml` has a `port-contract` job (ubuntu-latest, 10 minute
timeout) that runs `npm ci`, `npm run port:contract:check`,
`npm run port:selftest` and the TS-only half of the rows contract
(`npm run port:contract:rows`). It is independent of the existing matrix jobs
and is the oracle.

`.github/workflows/rust.yml`'s `wasm` job builds `thar-wasm`, enforces the size
budget, runs the Node smoke test, then runs `npm ci` and
`npm run port:contract:wasm` and the rows contract against the WASM candidate
(`npm run port:contract:rows:wasm`). Its path filter includes `crates/**`,
`testdata/port/**`, `tools/port/**`, `logic/core-wasm.ts`, `logic/limits.ts`,
`unit-tests/core-wasm.test.ts` and `package.json`, so a change to either
candidate, either adapter or their tests re-runs WASM parity. The Node matrix
does not require Rust or a built `pkg/`; the WASM job is the only place the WASM
candidates run in CI.

## Maintaining

Behaviour changes are deliberate: update `testdata/port/expected.json`, its
README and this document in the same reviewed commit. `--verify-golden` makes
CP0 and CP1 drift visible; the schema test in
`unit-tests/port-contract.test.ts` catches accidental field changes.
