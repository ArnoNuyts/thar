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
```

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
| `--max-diffs <n>`               | Print at most `n` diffs, default 20                                          |
| `--mutate <name>`               | **Test only.** Build a deliberately broken contract                          |
| `--list-mutations`              | Print the seeded mutations and their proof fixture as JSON                   |

The test-only hook can also be set with `THAR_PORT_MUTATION=<name>` in the
environment, for wrappers that cannot append arguments; `--mutate` wins when
both are set.

Exit codes: **0** match, **2** mismatch, **1** harness error (bad arguments,
unreadable corpus, candidate that could not be spawned). Diffs and status go to
stderr so stdout stays valid JSONL.

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
  (`todos.map(toString).join("\n") + "\n"`).
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
todos.map((todo) => todo.toString()).join("\n") + "\n";
```

## Determinism

- The clock is pinned by replacing `globalThis.Date` with a subclass: `new
  Date()` and `Date.now()` return `2026-11-15T12:00:00` (CP0's clock, UTC),
  while explicit constructors and `instanceof Date` keep working.
- Filenames are sorted with `Buffer.compare` (bytewise), never the host locale.
- Records are built with a fixed key order; no timestamps, absolute paths,
  host names, environment values or randomness appear in the output.
- Two runs over the same corpus are byte-identical; the self-test and
  `unit-tests/port-contract.test.ts` assert it.

## Candidate protocol

A candidate is any command that:

1. receives `--corpus <dir> --clock <iso> --out <file>`,
2. writes the JSONL contract above to `<file>`,
3. exits `0`.

Anything else fails: a non-zero exit, invalid UTF-8, CRLF, a missing final
newline, a subset/superset/reordered field, an extra or missing record, or a
differently ordered fixture list. The command string is split like a shell
(quotes and backslash escapes) but **not** run through a shell, so pipes,
globs and variables do not work; that keeps it identical on Linux, macOS and
Windows.

At CP2 the Rust crate can either implement the same CLI or write a precomputed
JSONL file that is compared with `--candidate-file`.

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
`--verify-golden` matches `testdata/port/expected.json` field by field, and
that the unmutated oracle passes the candidate protocol. It bundles the
harness once with Vite into a temp directory (startup with `vite-node` and
`date-fns` is ~2.4 s per process) so the ~14 spawned runs finish in about six
seconds.

## CI

`.github/workflows/ci.yml` has a `port-contract` job (ubuntu-latest, 10 minute
timeout) that runs `npm ci`, `npm run port:contract:check` and
`npm run port:selftest`. It is independent of the existing matrix jobs.

## Maintaining

Behaviour changes are deliberate: update `testdata/port/expected.json`, its
README and this document in the same reviewed commit. `--verify-golden` makes
CP0 and CP1 drift visible; the schema test in
`unit-tests/port-contract.test.ts` catches accidental field changes.
