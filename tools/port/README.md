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
- Write contract (CP4): `tools/port/write.ts` (oracle, import-safe),
  `tools/port/write-cli.ts` (CLI).
- Tests: [`unit-tests/port-contract.test.ts`](../../unit-tests/port-contract.test.ts),
  [`unit-tests/port-rows.test.ts`](../../unit-tests/port-rows.test.ts),
  [`unit-tests/port-write.test.ts`](../../unit-tests/port-write.test.ts),
  [`unit-tests/todo-file-write-safety.test.ts`](../../unit-tests/todo-file-write-safety.test.ts).
- WASM candidate (CP2b): `tools/port/candidates/wasm.mjs`.
- WASM rows candidate (CP3b1): `tools/port/candidates/wasm-rows.mjs`.
- WASM write candidate (CP4): `tools/port/candidates/wasm-write.mjs`.

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

# CP4: the write contract (serialize over WASM, byte-compared)
npm run port:contract:write                 # TS only: candidate protocol + mutation proof
npm run port:contract:write:wasm            # the WASM candidate (needs pkg/)

# CP3b2c: the parse contract (parseFile -> Todo.fromParts -> serialize)
npm run port:contract:parse                 # TS only: lossless factory + mutation proof
npm run port:contract:parse:wasm            # the wired THAR_CORE=rust read path (needs pkg/)
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
12-query set and `showHidden=false`/`true`. That is **504 records / 4 450 270
bytes**, and the WASM candidate reproduces them with **0 diffs** (the TS oracle
also passes its own candidate protocol via `--candidate-self`). The generated
list is built in TS and handed to the candidate in a temp manifest, so there is
no second committed corpus.

The skipped set is not a free-for-all: the builder narrows its `catch` to the
production validation error family and returns the skipped fixture names. A
unit test asserts that set is exactly CP1's eight `kind: "error"` records, so a
new unparseable fixture fails the suite instead of silently shrinking coverage.

The query set is `""`, `"   "`, `work`, `@work`, `+project`, `alpha beta`,
`!!!`, `MILK`, `ΟΔΟΣ`, `aΣ.Α`, `aβ́Σ.`, `due:` — the CP3a set (empty,
whitespace-only, both prefixes, two terms, punctuation-only, uppercase, Unicode)
plus the reverse final-sigma shapes. One generated line ends in
`aβ́Σ. aΣ.Α` (JS-lowercased to `aβ́ς. aσ.α`), so the extracted terms `aβ́ς.` and
`aσ.` now match at least one row. What that **does** pin: matching consumes the
host-lowercased views and the manifest's normalized terms verbatim, and a
candidate that re-folds (`Σ→σ` per character) or matches case-sensitively loses
that row. What it **does not** pin: a Rust-side case fold or a Rust
`extractSearchTerms` port — the core never folds and never splits, so those
pipeline stages are covered by the CP3a search-case table, not by this contract.

The rows harness asserts the host's default collator is en-US-equivalent before
it builds anything (PLAN §13 decision 8); the status lines print
`collator en-US`. Under `LANG=da_DK.UTF-8` it exits 1 with a readable message
instead of emitting genuine-looking row diffs.

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

### Perf evidence (CP3b1 / CP3b2b)

There are **two** row benchmarks with different scopes; quoting one as a
general speed-up is wrong, so both are recorded here.

`tools/port/bench-rows.ts` (`npm run port:bench:rows`) measures the rows
contract's own 1 000-line generated list (extended to 50 / 3 000 / 10 000),
120×40, the full stateless call: `JSON.stringify` of the request, the Rust JSON
decode + row build + JSON encode, and `JSON.parse` of the response. The
generated list has many distinct mixed-case contexts, so the TS `localeCompare`
sort dominates the oracle side. Times in milliseconds, p50/p95, Node 26.12.0,
release WASM, development machine (a snapshot, not a CI gate):

| todos  | path          | empty query   | one term (`work`) | multi term (`alpha beta`) |
| ------ | ------------- | ------------- | ----------------- | ------------------------- |
| 50     | TS oracle     | 0.46 / 0.87   | 0.70 / 0.85       | 0.43 / 0.79               |
| 50     | WASM boundary | 0.55 / 0.93   | 0.74 / 0.81       | 0.41 / 0.67               |
| 3 000  | TS oracle     | 129.8 / 146.4 | 130.7 / 142.2     | 127.5 / 135.3             |
| 3 000  | WASM boundary | 25.1 / 26.3   | 24.8 / 28.5       | 24.3 / 25.1               |
| 10 000 | TS oracle     | 524.5 / 591.5 | 534.6 / 542.3     | 532.6 / 562.5             |
| 10 000 | WASM boundary | 89.4 / 106.4  | 82.0 / 86.5       | 81.8 / 98.9               |

`parse+views` (once per load, median of five) is 43.0 ms TS / 84.1 ms WASM at
10 000. Request bytes at 10 000: **2 562 KB** (13 KB at 50, 766 KB at 3 000).
The 10 000 stateless call splits into `JSON.stringify` 9.5–10.5 ms,
`buildRows` 71.8–77.0 ms, `JSON.parse` 0.0–2.0 ms (p50).

`scripts/bench-rows.ts` (`npm run bench:rows`) measures the **app-shaped
adapter path**: `buildRowsWithCore` with the record/view cache warm (and a
cold-input variant), on a list built by that script. With the app's list shape
the TS sort is much cheaper, so the same release package is only modestly
ahead:

| todos  | query      | TS p50 / p95 | rust warm p50 / p95 | rust cold p50 / p95 |
| ------ | ---------- | ------------ | ------------------- | ------------------- |
| 3 000  | empty      | 23.5 / 30.7  | 22.6 / 25.8         | 25.6 / 34.9         |
| 3 000  | one-term   | 23.9 / 28.2  | 21.2 / 32.0         | 23.5 / 33.5         |
| 10 000 | empty      | 82.3 / 85.1  | 74.0 / 81.9         | 83.9 / 97.4         |
| 10 000 | one-term   | 84.6 / 129.8 | 66.5 / 68.9         | 77.0 / 85.4         |
| 10 000 | multi-term | 84.6 / 86.9  | 69.9 / 95.9         | 86.7 / 110.3        |

The core alone (`cargo test --release -p thar-core --test rows_perf --
--ignored --nocapture`) is **7.9–8.2 ms p50 / 8.6–10.9 ms p95** at 10 000, of
which `sort_by_importance` is 5.6 ms and `create_rows` 0.3 ms.

So the domain work is close to the target while marshalling dominates, and the
end-to-end gap depends entirely on the list shape (≈6× on the contract's
mixed-case list, ≈1.1–1.3× on the app-shaped one, at parity cold). The PLAN's
**≤ 5 ms** search-keystroke target is a **future optimization goal, not a
current claim**. CP3b2b records these numbers only; no caching or collation-rank
work is done here. The deferred optimization phase would add:

- a **stateful handle** (`load` once per list/mutation, `build` per keystroke)
  so the 2.5 MB request is decoded once, not per key;
- precomputed collation ranks/sort keys once per load (the 5.6 ms sort), which
  also addresses PLAN §5 CP3's sort-key TODO;
- host-computed context ranks as an alternative to the en-US assumption
  (PLAN §13 decision 8).

The stateless `buildRows` stays the differential contract's entry point.

## Write contract (CP4)

The write path is `serializeTodosForWrite`, the serializer inside
`writeTodosToFile`:

```ts
todos.map((todo) => todo.toString()).join("\n") + "\n";
```

CP4 also runs the same lines through `thar-wasm`'s `serializeFile` and compares
the bytes with the TypeScript output; the TypeScript bytes are written either
way, so the Rust serializer is a verification gate rather than a second writer.
The contract pins that boundary.

- Oracle: `tools/port/write.ts` (import-safe builder) + `tools/port/write-cli.ts`
  (CLI).
- Candidate: `tools/port/candidates/wasm-write.mjs`.
- Tests: [`unit-tests/port-write.test.ts`](../../unit-tests/port-write.test.ts);
  the data-safety matrix is
  [`unit-tests/todo-file-write-safety.test.ts`](../../unit-tests/todo-file-write-safety.test.ts).

```sh
npm run port:contract:write        # TS only: determinism + candidate protocol + mutation proof
npm run port:contract:write:wasm   # the WASM candidate (needs crates/thar-wasm/pkg)
```

### Record format

One compact JSON object per fixture, bytewise by name, with the guard probes in
the same order:

```json
{ "fixture": "tags.txt", "kind": "todos", "todoCount": 12,
  "serialized": { "sha256": "…", "bytes": 491 } }
{ "fixture": "guard-nul", "kind": "rejected", "lineNumber": 2, "codePoint": 0 }
```

- `kind: "todos"` is the exact file text the writer would produce: per-record
  `toString`, joined with `"\n"`, plus **one trailing `"\n"`**. An empty todo
  list is `"\n"` (one byte), never `""`, because `[].join("\n") + "\n"` is
  `"\n"`; `empty.txt` pins it.
- `kind: "rejected"` is the write-time guard: the first line with a rejected
  control code point and the first such code point on it. The TypeScript error
  calls the 1-based line `lineNumber`, the Rust envelope calls it `index`; the
  candidate maps it so both sides emit the same record.
- Only the SHA-256 and the byte length cross the contract, not the text: a
  one-byte change (the dropped trailing newline) is still a diff, and the file
  never appears in a commit or a log.

### Candidate protocol

```sh
node tools/port/candidates/wasm-write.mjs --manifest <file> --out <file>
```

The manifest carries the **structured records** the app's adapter sends
(`coreTodoRecord`: text, state, priority, both dates, projects, contexts, tags
including array-valued duplicates, and both round-trip flags). The candidate
does not read the corpus and does not re-derive the DTO: for each entry it calls
`serializeFile({"todos":[…]})` once and writes the record shape above. A request
the oracle accepted but the candidate rejects is a loud candidate error, not a
contract mismatch; a missing `pkg/` is a loud failure too.

### Self-check

`--selftest` builds a reduced contract twice (the bytes must be identical),
asserts the guard probes are rejected, and requires the comparator to catch every
seeded mutation. The mutations edit the oracle's own serialized bytes, never
`logic/**`:

| Mutation                | Simulated bug                                                     | Caught on                               |
| ----------------------- | ----------------------------------------------------------------- | --------------------------------------- |
| `drop-trailing-newline` | serializer forgets the final `"\n"` (`join` without the `+ "\n"`) | every fixture                           |
| `swap-date-order`       | completed line writes creation before completion date             | `leading-dates-done.txt`, `unicode.txt` |
| `drop-last-tag`         | serializer loses a tag instead of writing it last                 | `tags.txt`                              |

### Coverage

The **23 records / 3 566 bytes** are 20 parseable corpus fixtures (including the
empty list, CRLF, BOM, invalid UTF-8 and the 10 000-todo file) plus 3 synthetic
guard probes: `guard-nul` (control character on line 2, with a second one beside
it), `guard-esc` (line 1, `U+001B`) and `guard-tab` (the allow case). The WASM
candidate reproduces all 23 with **0 diffs**.

The eight rejection fixtures are skipped by the same narrowed catch as the rows
contract, and a unit test asserts the skipped set is exactly CP1's eight
`kind: "error"` records.

The self-candidate (`--candidate-self`) renders the manifest records in
TypeScript and must reproduce the oracle bytes for every fixture. That is the
DTO round-trip proof: if `coreTodoRecord` lost an array-valued tag or a
round-trip flag, the rendering would differ. It is **not** a second domain
implementation — no dates are computed and no text is scanned, only the
documented prefix/tag order — and it is not the oracle: the oracle is the
production writer over its own `Todo` objects.

The data-safety suite next to it (`todo-file-write-safety.test.ts`) proves the
dual write against real `fs`: TypeScript bytes on a mismatch, one bounded log,
the same `TodoControlCharacterError`, one append, and an atomic replace that
survives an injected `ENOSPC`, an injected rename failure, a read-only
directory, a concurrent external edit and a child process that crashes before the
rename. See `docs/rust-port/PLAN.md` §5 CP4 for the matrix.

## Parse contract (CP3b2c)

CP3b2c wires `THAR_CORE=rust` into `readTodosFromFile`: one `parseFile` call
replaces `validateTodoFileContent → filter(blank) → new Todo(line)`. The
contract pins that reconstruction:

```ts
parse_file records → Todo.fromParts → serializeTodosForWrite
```

against the TypeScript reader over every corpus fixture, and includes the
rejection records so read-error parity is part of the contract.

- Oracle and candidates: `tools/port/parse.ts`; CLI: `tools/port/parse-cli.ts`.
- Tests: [`unit-tests/todo-from-parts.test.ts`](../../unit-tests/todo-from-parts.test.ts)
  (the factory over every parseable corpus line) and the read-path tests in
  [`unit-tests/core-wasm.test.ts`](../../unit-tests/core-wasm.test.ts).

```sh
npm run port:contract:parse        # TS only: lossless factory + mutation proof
npm run port:contract:parse:wasm   # the wired THAR_CORE=rust read path (needs pkg/)
```

### Record format

One compact JSON object per fixture, with the CP1 fixture order:

```json
{
  "fixture": "tags.txt",
  "sha256": "…",
  "kind": "todos",
  "clockLocal": "2026-11-15T12:00:00",
  "readLimits": {
    "maxFileBytes": 1048576,
    "maxReadTodos": 10000,
    "maxLineChars": 8192
  },
  "todoCount": 12,
  "serialized": { "sha256": "…", "bytes": 491 },
  "todos": [
    {
      "text": "ship +thar",
      "state": "todo",
      "priority": "A",
      "completionDate": null,
      "creationDate": "2024-03-01",
      "projects": ["thar"],
      "contexts": [],
      "tags": [["beta", ["one", "two"]]],
      "datesInText": false,
      "completionDateInText": false,
      "isDone": false,
      "isHidden": false,
      "isVisibleInOverview": true,
      "isOverdue": false,
      "toString": "…",
      "hash": "…"
    }
  ]
}
```

`kind: "error"` carries the same name/code/numeric-fields/message record the CP1
contract pins; the candidate must reject the same fixture with the same error.

### The two candidates

- `--candidate-self` projects every oracle `Todo` back to a parse record
  (`coreTodoRecord` plus the derived getters and the load id), runs the
  production `parseRecordToTodoParts` normalizer, and rebuilds it with
  `Todo.fromParts`. It is the lossless-factory proof and needs no package.
- `--candidate-wasm` calls `parseTodosWithCore`, the wired read path. A fallback
  to TypeScript is a **harness error**, not a pass: the contract must prove the
  Rust path ran, not just that a todo list came back.

### Fallback and error mapping

`--selftest` builds the reduced contract twice (byte-identical), requires the
self candidate to equal the oracle, and requires the comparator to catch every
seeded reconstruction bug:

| Mutation                | Simulated bug                                | Caught on                        |
| ----------------------- | -------------------------------------------- | -------------------------------- |
| `drop-last-tag`         | reconstruction loses a tag                   | `tags.txt`                       |
| `swap-dates`            | completion and creation date slots exchanged | `leading-dates-done.txt`         |
| `lose-round-trip-flags` | flags reset because the line was re-parsed   | `leading-dates-done-invalid.txt` |
| `reverse-records`       | records lose file order                      | `crlf.txt`                       |

The read path itself falls back to the TypeScript reader (one bounded,
content-free log) on a missing package, a malformed envelope, a thrown error, a
record count that differs from the non-blank line count, a load id that is not
its array position, a record that cannot be rebuilt byte-identically, or a
rejection whose numeric fields/message the TypeScript error cannot reproduce. A
mappable rejection is thrown as the same `TodoFileValidationError` class, message
and fields the validator would have thrown.

Coverage: **28 records / 3 931 057 bytes, 0 diffs** for both the self and the
WASM candidate (20 parseable fixtures including the 10 000-todo file, plus CP1's
eight rejection fixtures compared as error records).

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
  runs for every fixture. No corpus fixture makes the guard throw, so CP4's
  write contract adds two synthetic probes (`guard-nul` on line 2, `guard-esc`
  on line 1) plus the allow case (`guard-tab`); both sides must name the same
  1-based line and code point. The line-length/line-count and byte-size
  re-validation in `writeTodosToFile` is **not** in the contract: the writer
  applies it to the chosen text, and
  [`unit-tests/todo-file-write-safety.test.ts`](../../unit-tests/todo-file-write-safety.test.ts)
  owns the file-level behaviour (atomic replace, limits, failure paths).
- **Byte-size guard.** `tools/port/build.ts` mirrors the reader's post-read
  byte check (`readTodosFromFile`), not `writeTodosToFile`'s write-size guard;
  committed fixtures are far below 1 MiB.
- **UI and I/O.** Navigation, the TUI and the file-system layer (`Runtime`,
  atomic writes, file watching) are outside the contract. Indexes/rows are
  covered by the CP3b1 rows contract above, not by the CP1 record set.
- **Serialization of DTO-built todos.** The rows contract feeds the parse
  records back through `buildRows`; the two round-trip flags
  (`datesInText`, `completionDateInText`) are not in the CP1 record set, so the
  rows candidate leaves them `false`. Row building does not read them (only
  `toString` does), so the omission cannot change a row. The **app's** adapter
  (CP3b2b) sends the real flags from its own `Todo` objects, so CP4 can rebuild
  an exact todo from a row request.
- **CP1 records stay frozen.** Since CP3b2c, `parseFile` records carry three
  fields beyond the CP1 set — `datesInText`, `completionDateInText` and the
  load-order `id` — because the read path rebuilds the todo without a second
  parse and rejects a reordered envelope. `tools/port/candidates/wasm.mjs`
  projects exactly the 14 CP1 fields, so the corpus contract is unchanged; the
  parse contract above covers the extra fields.

## CI

`.github/workflows/ci.yml` has a `port-contract` job (ubuntu-latest, 10 minute
timeout) that runs `npm ci`, `npm run port:contract:check`,
`npm run port:selftest`, the TS-only half of the rows contract
(`npm run port:contract:rows`), the TS-only half of the write contract
(`npm run port:contract:write`) and the TS-only half of the parse contract
(`npm run port:contract:parse`). It is independent of the existing matrix jobs
and is the oracle.

`.github/workflows/rust.yml`'s `wasm` job builds `thar-wasm`, enforces the size
budget, runs the Node smoke test, then runs `npm ci` and
`npm run port:contract:wasm`, the rows contract against the WASM candidate
(`npm run port:contract:rows:wasm`), the write contract against the WASM
candidate (`npm run port:contract:write:wasm`) and the parse contract against
the wired read path (`npm run port:contract:parse:wasm`). It also runs
`unit-tests/core-wasm.test.ts`, `unit-tests/todo-from-parts.test.ts` and
`unit-tests/todo-file-write-safety.test.ts` against the package it just built,
which is where the real-package parse/rows/serialize round-trips and the
byte-compared dual write are proven. Its path filter includes
`crates/**`, `testdata/port/**`, `tools/port/**`, `logic/core-wasm.ts`,
`logic/limits.ts`, `logic/todo-file-helpers.ts`, `utils/runtime.ts`,
`unit-tests/core-wasm.test.ts`, `unit-tests/port-write.test.ts`,
`unit-tests/todo-file-write-safety.test.ts` and `package.json`, so a change to
either candidate, either adapter, the writer or their tests re-runs WASM parity.
The rows oracle imports real production modules, so CP3b2b widened that filter to
include `logic/indexes.ts`, `logic/Todos.ts`, `logic/todo.ts`,
`logic/todo-file-validation.ts`, `utils/search-utils.ts`, `types/enums.ts` and
`unit-tests/port-rows.test.ts` as well; CP4 added the writer
(`logic/todo-file-helpers.ts`) and the atomic replace (`utils/runtime.ts`). A
change to just one of those now re-runs the relevant contract. The Node matrix
does not require Rust or a built
`pkg/`; the wasm job is the only place the WASM candidates run in CI. (The
Node `test` job in `ci.yml` has no path filters and always runs
`unit-tests/port-rows.test.ts` and `unit-tests/port-write.test.ts`.)

The rows diff lines name the record they belong to — `fixture [record 12
query="MILK" showHidden=false] rows[3].index` — because two records of one
fixture can hold identical rows.

## Maintaining

Behaviour changes are deliberate: update `testdata/port/expected.json`, its
README and this document in the same reviewed commit. `--verify-golden` makes
CP0 and CP1 drift visible; the schema test in
`unit-tests/port-contract.test.ts` catches accidental field changes.
