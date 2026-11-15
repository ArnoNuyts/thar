# CP0 `todo.txt` corpus

Committed fixtures that freeze today's `todo.txt` behaviour before the Rust
port. CP0 is tests and documentation only: nothing under `logic/`,
`components/`, `contexts/`, `hooks/`, `types/`, `utils/` or `theme/` changed.

- Plan: [`docs/rust-port/PLAN.md`](../../docs/rust-port/PLAN.md) §5 (CP0),
  §6 Phase 0, §7 (parity checklist), §8 (testing strategy).
- Tests: [`unit-tests/port-corpus.test.ts`](../../unit-tests/port-corpus.test.ts).
- Expectations: [`expected.json`](expected.json).

## How the corpus is loaded

The tests read the fixtures as **raw bytes** and then run the production load
path from [`logic/todo-file-helpers.ts`](../../logic/todo-file-helpers.ts):

```ts
validateTodoFileContent(data, getReadLimits())
  .filter((line) => line.trim())
  .map((line) => new Todo(line));
```

The write path is `todos.map((todo) => todo.toString()).join("\n") + "\n"`,
exactly as in `writeTodosToFile`. The SHA-256 and byte length of that output is
committed per file in [`expected.json`](expected.json) and asserted for every
fixture, which catches CRLF normalization and trailing-newline drift.

`.gitattributes` in this directory is `* -text` and is **required**: the repo
root forces `eol=lf`, so without it the CRLF fixture, the bare-CR fixtures and
the missing-final-newline fixture would be rewritten on checkout.

Clock-dependent methods (`isOverdue`, `isPassedThreshold`,
`isVisibleInOverview`) read ambient time. Every test runs with the clock pinned
to local `2026-11-15T12:00:00` (`vi.useFakeTimers()`), which is the
`clockLocal` value in `expected.json`.

## `expected.json`

Per fixture:

| Field        | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `rawBytes`   | size of the committed file on disk                    |
| `kind`       | `todos` or `error`                                    |
| `todoCount`  | todos after blank-line filtering                      |
| `serialized` | `sha256` + `bytes` of the serialized output           |
| `todos`      | every field of every parsed todo (small/medium files) |
| `samples`    | `{ index, todo }` records for the 10 000-todo file    |
| `error`      | class name, `code`, numeric fields, exact message     |

`todos`/`samples` records contain `text`, `state`, `priority`,
`completionDate`, `creationDate`, `projects`, `contexts`, `tags` (ordered
`[key, value]` pairs, array values preserved), `isDone`, `isHidden`,
`isVisibleInOverview`, `isOverdue`, `toString` and `hash`.

The file was produced once with a throwaway dump script and every value was
reviewed by hand before committing. **Tests never regenerate it.** If behaviour
intentionally changes, update `expected.json` and this document in the same
commit so the diff is reviewed as a behaviour change.

`rawBytes` and `serialized.bytes` differ where the write path legitimately
reshapes a line:

- CRLF becomes LF (`crlf.txt`) and a missing final newline is added
  (`no-trailing-newline.txt`).
- Tags are moved to the end of the line, so a leading `alpha:one` becomes a
  trailing `alpha:one` (`tags.txt`, `recurrence.txt`).
- Duplicate tag keys become arrays and re-serialize comma-joined:
  `beta:one beta:two` → `beta:one,two` (`tags.txt`, `recurrence.txt`,
  `due-threshold-hidden.txt`).
- An empty todo list serializes as a single `\n` (`empty.txt`).

## Fixtures

`raw → serialized` is in bytes. `Outcome` is the parsed todo count or the
rejection class. `§7` refers to the PLAN.md §7 bullets below.

| File                             | raw → ser.      | Outcome      | Byte quirks                              | Rule pinned                                                                                                                                                     | §7        |
| -------------------------------- | --------------- | ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `real-world-lf.txt`              | 2518 → 2518     | 51 todos     | LF, final newline                        | Real-world mix: `x`, priorities, dates, projects, contexts, `due`/`t`/`h`/`rec`, unicode; exact order                                                           | B2–B4, B6 |
| `crlf.txt`                       | 156 → 150       | 4 todos      | CRLF throughout, blank CRLF line         | CRLF is stripped one CR per LF and normalizes to LF on save                                                                                                     | —         |
| `no-trailing-newline.txt`        | 68 → 69         | 3 todos      | no final newline                         | The last line is still a line; save adds the final LF                                                                                                           | —         |
| `empty.txt`                      | 0 → 1           | 0 todos      | zero bytes                               | An empty file loads as no todos and saves as a single `\n`                                                                                                      | —         |
| `blank-lines.txt`                | 126 → 111       | 4 todos      | blank, space-only and tab-only lines     | Blank lines are returned as-is by validation and dropped by the loader                                                                                          | B1        |
| `leading-dates-open.txt`         | 419 → 419       | 10 todos     | LF                                       | One valid leading date is a creation date; two valid dates stay literal; `0000`/`10000`/`13`/`02-29`/`04-31`/`2023-1-1` are not consumed; `2024-02-29` is valid | B4        |
| `leading-dates-done.txt`         | 289 → 289       | 8 todos      | LF                                       | Done lines take completion + optional creation date; `X` is not a done marker; `x` alone is open; dates later in the text stay literal                          | B2, B4    |
| `leading-dates-done-invalid.txt` | 199 → 199       | 4 todos      | LF                                       | Invalid or body-less leading dates stay in `text`; `_completionDateInText` stops serialization duplicating them                                                 | B2        |
| `priorities.txt`                 | 305 → 305       | 10 todos     | one line is `(A) ` with a trailing space | `(A)`..`(Z)` accepted; `(a)`, `(AB)`, bare `(A)` are not; a priority with no body keeps an empty text                                                           | —         |
| `projects-contexts.txt`          | 618 → 618       | 15 todos     | LF                                       | Word-boundary `+project`/`@context`; dedupe; `.`/`_`/`-`/digits in names; `+a/b` → `a`; `x@y` is not a context; emails are not contexts                         | —         |
| `tags.txt`                       | 496 → 491       | 12 todos     | LF                                       | `key:value` scan, duplicate keys → arrays, case-sensitive keys, `A-Za-z` key charset, value required, `http://` is a tag, tags re-serialize at the end          | B3        |
| `due-threshold-hidden.txt`       | 715 → 709       | 17 todos     | LF                                       | `due` past/today overdue, future/invalid/array not; `h:1`/`h:x` hide, `h:0` does not; future `t:` hides, past/today/invalid `t:` visible                        | B3, B7    |
| `recurrence.txt`                 | 308 → 304       | 11 todos     | LF                                       | `1d`/`2w`/`3m`/`1y`/`+1d` valid, `0d`/`10000d`/`abc`/`1D` invalid, duplicate `rec` → array (comma-joined on save)                                               | B8        |
| `unicode.txt`                    | 348 → 348       | 8 todos      | LF, combining mark, ZWJ emoji            | Accents, CJK, RTL, combining sequences, emoji values and a done line with dates round-trip                                                                      | —         |
| `tabs.txt`                       | 173 → 171       | 6 todos      | literal tabs                             | Tab is allowed inside a line, satisfies `x`/priority/date separators, and is trimmed at the edges                                                               | —         |
| `control-nul.txt`                | 31              | error        | NUL on line 2                            | `CONTROL_CHARACTER`, line 2, `U+0000`                                                                                                                           | —         |
| `control-bel.txt`                | 10              | error        | BEL                                      | `CONTROL_CHARACTER`, line 1, `U+0007`                                                                                                                           | —         |
| `control-esc.txt`                | 23              | error        | ANSI ESC sequence                        | `CONTROL_CHARACTER`, line 1, `U+001B`                                                                                                                           | —         |
| `control-del.txt`                | 9               | error        | DEL                                      | `CONTROL_CHARACTER`, line 1, `U+007F`                                                                                                                           | —         |
| `control-c1.txt`                 | 12              | error        | C1 control                               | `CONTROL_CHARACTER`, line 1, `U+0085`                                                                                                                           | —         |
| `control-u2028.txt`              | 17              | error        | U+2028 line separator                    | `CONTROL_CHARACTER`, line 1, `U+2028`                                                                                                                           | —         |
| `bare-cr-eof.txt`                | 27              | error        | CR at EOF, no LF                         | A CR that is not part of CRLF is `CONTROL_CHARACTER`, line 2, `U+000D`                                                                                          | —         |
| `bare-cr-inside.txt`             | 30              | error        | CR inside a line                         | Bare CR inside a line is `CONTROL_CHARACTER`, line 1, `U+000D`                                                                                                  | —         |
| `long-line-8192.txt`             | 8193 → 8193     | 1 todo       | one 8 192-char line                      | The read limit accepts exactly 8 192 chars; 8 193 is `LINE_TOO_LONG` (generated in the test)                                                                    | B5        |
| `large-10000.txt`                | 344779 → 344779 | 10 000 todos | LF, deterministic generator              | `MAX_TODOS`/`MAX_READ_TODOS` boundary, structural invariants, sampled records, exact bytes                                                                      | B5, B6    |

Total committed fixture bytes: 359 869 (≈ 352 KiB). The 8 193-char line
rejection, the 10 001-line file and the > 1 MiB file are generated inside
`unit-tests/port-corpus.test.ts` in temporary `fs.mkdtemp` directories (via
`Runtime.makeTempDir`, cleaned up afterwards) instead of being committed.

## §7 "subtle rules" coverage

Every bullet from [`PLAN.md` §7](../../docs/rust-port/PLAN.md#7-feature-parity-checklist)
("Subtle rules that must be covered by fixtures"):

| #   | Rule (PLAN.md §7)                                                                                                                        | Fixture(s)                                                                      | Assertion                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | The uncategorized `"None"` context header is part of the row model, not a display detail; row indexes and mouse coordinates depend on it | `blank-lines.txt`                                                               | `createIndexes` emits `{ contextName: "None", todoCount: 4 }` as entry 0                                                                                                                                       |
| B2  | Completed lines keep invalid/ambiguous leading dates in `text` and set `_completionDateInText` so serialization does not duplicate them  | `leading-dates-done.txt`, `leading-dates-done-invalid.txt`, `real-world-lf.txt` | `completionDate` exposed while `toString()` keeps exactly one literal date                                                                                                                                     |
| B3  | Duplicate tag keys become arrays; `due` as an array is not overdue                                                                       | `tags.txt`, `due-threshold-hidden.txt`, `recurrence.txt`                        | `tags.beta === ["one","two"]`, `tags.due` array ⇒ `isOverdue() === false`, save joins with commas                                                                                                              |
| B4  | `parseDateTag` rejects year 0000 and invalid calendar days                                                                               | `leading-dates-open.txt`, `leading-dates-done*.txt`                             | `0000-01-01`, `2023-13-01`, `2023-02-29`, `2023-04-31` stay literal; `2024-02-29` is valid                                                                                                                     |
| B5  | `MAX_TODOS = 10 000`, 1 MiB file, 8 192 read line chars, 2 000 edit chars, 100 paste items                                               | `large-10000.txt`, `long-line-8192.txt` + generated limit files                 | 10 000 accepted / 10 001 `TOO_MANY_LINES`; > 1 MiB `FILE_TOO_LARGE`; 8 193 chars `LINE_TOO_LONG`; edit/paste caps in `unit-tests/todo-input-validation.test.ts`                                                |
| B6  | Sort order and stability, overdue computed once per todo per day                                                                         | `real-world-lf.txt`, `large-10000.txt`                                          | Parse order pinned per todo; sorting/stability in `unit-tests/todos-sort.test.ts`; the once-per-day caching is measured by `npm run bench:list` (baseline recorded separately in `docs/rust-port/baseline.md`) |
| B7  | Missing/malformed threshold does not hide; missing/malformed due is not overdue                                                          | `due-threshold-hidden.txt`                                                      | `t:` absent/`t:` with no value/`2023-02-29` ⇒ visible; `due` absent/invalid ⇒ not overdue                                                                                                                      |
| B8  | Recurrence plans use the completion time, not the due date, and produce a new open todo with the next due date                           | `recurrence.txt`                                                                | Pinned clock gives `1d → 2026-11-16`, `2w → 2026-11-29`, `3m → 2027-02-15`, `1y → 2027-11-15`; the copy is open with no completion date                                                                        |
| B9  | Saves are debounced 50 ms; reloads 500 ms; a failed load makes the session read-only until a later read succeeds                         | — (timer policy, not file data)                                                 | `DEFAULT_SAVE_DEBOUNCE_MS`/`DEFAULT_RELOAD_DEBOUNCE_MS` asserted in `unit-tests/port-corpus.test.ts`; read-only recovery in `unit-tests/todo-context-lifecycle.test.tsx`                                       |

## §7 domain modules covered by this corpus

| §7 module                                                                                  | Pinned by                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logic/todo.ts` (`thar-core::model`)                                                       | Every fixture's `todos` records (`text`, `priority`, `state`, dates, sets, tags, `toString`, `getHash`)                                                                   |
| `logic/dates.ts`, `patterns.ts`, `recurrence.ts`                                           | `leading-dates-*`, `projects-contexts.txt`, `recurrence.txt`                                                                                                              |
| `logic/limits.ts`, `todo-file-validation.ts`, `control-characters.ts`                      | `control-*`, `bare-cr-*`, `long-line-8192.txt`, `empty.txt`, `crlf.txt` + generated limit files                                                                           |
| `logic/Todos.ts` (sort/filter)                                                             | `large-10000.txt` invariants (done/hidden/overdue/visible counts) and pinned parse order                                                                                  |
| `logic/indexes.ts`                                                                         | `blank-lines.txt` `"None"` header                                                                                                                                         |
| `logic/navigation.ts`, `todo-file-helpers.ts`, `todo-file-repository.ts`, UI/timers/update | Out of corpus scope for CP0; unchanged and covered by the existing Vitest suite (`navigation-*.test.ts*`, `todo-file-helpers.test.ts`, `todo-context-lifecycle.test.tsx`) |

## Maintaining the corpus

- Keep fixtures byte-exact; edit them with an editor that does not normalize
  line endings, and re-run `npx vitest run unit-tests/port-corpus.test.ts`.
- Do not "fix" a fixture to match new behaviour. A behaviour change is a
  deliberate change to `expected.json` plus this table, reviewed as such.
- New edge cases discovered while porting (PLAN.md Phase 1) are added here, not
  in a second corpus.
