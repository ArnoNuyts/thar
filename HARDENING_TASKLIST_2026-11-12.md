# Security Hardening Tasklist — todotui

> **Status:** implemented. The read-path, terminal-display, and read-only
> recovery hardening landed in [#24](https://github.com/ArnoNuyts/todotui/pull/24);
> the parser and write-input hardening landed in
> [#25](https://github.com/ArnoNuyts/todotui/pull/25). #10 (visual spoofing)
> remains deferred.
> **Source:** the fuzzing findings and security fixes landed in
> `todo-txt-mcp` between `aaa0808` and `b17687b` (PRs #45, #52–#55), reviewed
> against this TUI.
> **Scope:** `logic/todo.ts`, `logic/todo-file-helpers.ts`, `logic/dates.ts`,
> `contexts/todo-context.tsx`, `components/TodoList.tsx`,
> `components/ModalTodoInput.tsx`, `hooks/useTodoCommands.ts`, and new
> hardening tests.

## Threat model shift

`todo-txt-mcp` protects a server from remote MCP clients. `todotui` has no
network listener, so the server-only findings (auth, TLS, `/readyz`, WebDAV,
Compose memory, stdio framing) do **not** transfer.

The data path that does transfer is the **todo file itself**. `todo.txt` is
commonly synced, checked into a repo, copied from a clipboard, or produced by
another tool — including `todo-txt-mcp`. Treat every loaded line and every
pasted line as untrusted input. In a TUI the stakes are higher for one class of
bug: a todo line is written straight to the terminal, so control characters and
ANSI escapes become terminal injection, not merely bad data.

## What transfers

| Upstream change                                                                                   | Relevant here?            | TUI counterpart                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Read-side line-count and line-length bounds                                                       | **Yes**                   | `readTodosFromFile` calls `split("\n")` with no bounds ([`logic/todo-file-helpers.ts:10`](logic/todo-file-helpers.ts))             |
| Read-path control-character validation                                                            | **Yes — higher severity** | File text is rendered raw by Ink; ESC/SGR/OSC/C1 can reach the terminal ([`components/TodoList.tsx:181`](components/TodoList.tsx)) |
| File byte-size cap before parsing                                                                 | **Yes**                   | No `stat`/size check before `readTextFile`                                                                                         |
| Linear tag parsing                                                                                | **Yes**                   | `text.replace(tag[0], "")` per tag is quadratic ([`logic/todo.ts:253`](logic/todo.ts))                                             |
| Impossible dates readable, rejected on write                                                      | **Yes**                   | `parseISO` can yield an Invalid Date; `toString()` then throws ([`logic/todo.ts:67`](logic/todo.ts))                               |
| Recurrence clamping and year-range validation                                                     | **Yes**                   | `rec:999999999999y` throws on toggle ([`logic/todo.ts:143`](logic/todo.ts))                                                        |
| Whitespace-only todos rejected                                                                    | **Yes**                   | `new Todo("   ").toString()` is `""`; paste and API calls can create empty lines                                                   |
| Two-leading-date lines handled without dropping a date                                            | **Yes**                   | `new Todo("2026-01-01 2026-01-02 task").toString()` drops the first date                                                           |
| Total todo cap after recurrence expansion                                                         | **Adapt**                 | There is no total cap; if one is added, recurrence must be counted                                                                 |
| Bounded errors that do not echo content                                                           | **Yes**                   | New validation errors and toasts must report line/offset/code point only                                                           |
| CRLF handling (allow one trailing `\r`, reject bare `\r`)                                         | **Yes**                   | Windows files currently rely on the regex `\s*$`; bare `\r` survives into text                                                     |
| Byte-stable round-trip of untouched lines                                                         | **No (by design)**        | The TUI rewrites the whole file and already normalizes blank lines; keep the file canonical                                        |
| WebDAV redirects / HTML mislabel / TLS / readiness / proxy deny / container memory / stdio frames | **No**                    | No network, HTTP server, container, or MCP transport in this repo                                                                  |

## Evidence (reproduced against this checkout)

These are runtime results from temporary probe tests, not static guesses.
They were reproduced on Node 24 with the repo's Vitest/Vite toolchain.

| #   | Severity | Finding                                                        | Evidence                                                                                                                                                                                                                                                                  |
| --- | -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **P0**   | Untrusted file/clipboard text reaches the terminal unsanitized | A file containing `innocent\rFAKE ROW`, `ansi\u001b]0;pwned\u0007title`, `line\u2028sep`, and `nul\u0000byte` loads as four todos and serializes byte-for-byte. Ink emits SGR (`\u001b[31m`) and OSC 8 hyperlink sequences; C1 `\u009b31m` is normalized to `\u001b[31m`. |
| 2   | **P1**   | Tag parsing is quadratic                                       | One line with 10k tags: 83 ms; 20k: 879 ms; 40k: 4,811 ms. The MCP fuzz case (60k tags / 589 KB) took tens of seconds there; the same parser here blocks the event loop.                                                                                                  |
| 3   | **P1**   | An impossible calendar date crashes serialization              | `new Todo("2026-02-30 impossible").toString()` throws `RangeError: Invalid time value`; same for `x 2026-02-30 2026-01-01 done`. The save effect only `console.error`s, so edits silently fail to persist.                                                                |
| 4   | **P1**   | An out-of-range recurrence crashes completion                  | `new Todo("task rec:999999999999y").toggleState()` throws `RangeError: Invalid time value` (also for `m`).                                                                                                                                                                |
| 5   | **P1**   | The read path is unbounded                                     | A 500,000-line file parses in 1.3 s and adds ~260 MB RSS over the test baseline; there are no byte, line-count, or line-length caps before `split`/`new Todo`.                                                                                                            |
| 6   | **P2**   | Ambiguous or empty lines are silently rewritten                | `new Todo("2026-01-01 2026-01-02 two dates").toString()` returns `"2026-01-02 two dates"`; `new Todo("   ").toString()` returns `""`.                                                                                                                                     |
| 7   | **P2**   | A failed reload can still be overwritten                       | Initial load failure is safe (`hasLoadedFileRef` stays false), but a reload failure after a successful load only logs; the next edit saves the stale in-memory list over the rejected file ([`contexts/todo-context.tsx:215`](contexts/todo-context.tsx)).                |

## P0 — stop terminal and control-character injection

### 1. Validate every loaded line before it becomes a `Todo`

**Status:** implemented in
[#24](https://github.com/ArnoNuyts/todotui/pull/24).

- [x] Add `logic/limits.ts` with read limits and typed errors, mirroring
      `todo-txt-mcp` but with UI-appropriate defaults: - `TODOTUI_MAX_FILE_BYTES` — default **1 MiB**, checked via
      `Runtime.stat()` **before** `readTextFile`, and re-checked after the
      read with the actual UTF-8 byte length. - `TODOTUI_MAX_READ_TODOS` — default **10,000** (interactive budget; the
      MCP read cap of 50,000 exists to keep over-cap files deletable, which
      is less useful in a TUI that must render the list). - `TODOTUI_MAX_LINE_CHARS` — default **8,192** UTF-16 code units.
      Keep the values in one module; do not scatter literals.
- [x] Add a pure `validateTodoFileContent(data, limits): string[]` in a new
      `logic/todo-file-validation.ts`: - Count newlines with an `indexOf("\n")` loop **before** `split`. - Split only after the count is within the limit. - Strip exactly one trailing `\r` from each line (CRLF support), then
      reject any remaining `\r`. - Reject `\u0000-\u0008`, `\u000B-\u001F`, `\u007F-\u009F`,
      `\u2028`, and `\u2029`. Allow tab. - Error messages report only line number, length, or `U+XXXX`; never the
      line content.
- [x] Call the validator from `readTodosFromFile` before constructing `Todo`
      objects. Keep the missing-file behavior (`ENOENT` creates an empty file).
- [x] Add a defense-in-depth `sanitizeForDisplay(text)` used by
      `renderTodoText`, `ControlledTextInput`, `SearchInput`, and any
      toast/modal that shows file-supplied text: replace C0/C1/DEL and
      `\u2028/\u2029` with visible escapes or a
      placeholder, and neutralize ESC. This protects programmatic strings that
      bypass the file validator.
- [ ] Add a controlled escape hatch only if needed (`TODOTUI_ALLOW_UNSAFE_FILE=1`)
      and document that it disables terminal-injection protection.
      _Not needed; no escape hatch was added._

**Acceptance:** a file with CR, NUL, ESC, DEL, C1, U+2028, or U+2029 is refused
with a bounded error and the app does not write the file; a CRLF file loads and
round-trips with LF output; no rendered frame contains ESC, CR, NUL, or C1
controls.

**Tests:** new `unit-tests/todo-file-validation.test.ts` (generate large files
at runtime) and `unit-tests/todo-render-safety.test.tsx` using
`ink-testing-library`; assert the frame contains no `\u001b`, `\r`, `\u0000`,
or `\u009b`.

### 2. Do not let a rejected reload be overwritten

**Status:** implemented in
[#24](https://github.com/ArnoNuyts/todotui/pull/24).

- [x] Add a `loadError` / `readOnly` state to `TodoProvider`. On initial load
      or watcher reload failure, show a bounded toast and block the save
      effect until a later load succeeds.
- [x] Do not silently `console.error` and continue with stale state when a
      reload fails; the current behavior can clobber a file that the user is
      fixing externally.
- [x] Make the recovery explicit: a successful watcher reload clears
      `loadError`; `undo`/`redo` do not bypass the write block.
- [x] Surface the read-only state persistently in the status bar and warn on
      mutations/undo instead of silently dropping edits.

**Acceptance:** poison `todo.txt` while the app is running, then edit a todo;
the app reports the load error, leaves the file untouched, and resumes saving
only after the file is valid again.

**Tests:** extend `unit-tests/todo-context-lifecycle.test.tsx` and
`unit-tests/todo-context-history.test.tsx` with a failing reload and a
subsequent mutation.

## P1 — stop the crashes and freezes

### 3. Make tag parsing linear

**Status:** implemented in
[#25](https://github.com/ArnoNuyts/todotui/pull/25).

- [x] Replace the per-token `text.replace(tag[0], "")` loop in
      `internalParseText` with one `text.replace(TAG_REGEX, "")` pass after
      collecting values.
- [x] Keep the existing public tag shape (`string | string[]`) and the
      `preserveTags` behavior; do not change dedupe/order semantics as part of
      this fix.
- [x] Optionally add `TODOTUI_MAX_TAGS_PER_LINE` (default **1,024**) as
      defense in depth; the line-length cap already bounds the input.
- [x] Benchmark 60k tags on one line and keep it well under 1 s.

**Acceptance:** the 589 KB / 60k-tag line no longer blocks the UI; a 2,000-char
line with ~400 tags parses in a few milliseconds; tags are still removed from
`text` and remain visible in `tags`.

**Tests:** new `unit-tests/tag-parsing.test.ts` (perf guard plus duplicate,
whitespace, and `preserveTags` cases); keep `unit-tests/todo.test.ts` green.

### 4. Keep impossible dates readable and never throw on serialization

**Status:** implemented in
[#25](https://github.com/ArnoNuyts/todotui/pull/25).

- [x] Add a strict leading-date parser in `logic/dates.ts` that reuses
      `parseDateTag` (regex + `isValid` + `startOfDay`) instead of calling
      `parseISO` directly in the `Todo` constructor.
- [x] For a regex-valid but impossible date (`2024-13-01`, `2024-02-30`,
      `2024-00-00`, `2024-01-39`), keep the token as literal body text and
      record it as an invalid date token. `toString()` must always succeed and
      preserve the loaded bytes.
- [x] For an open todo with two leading dates, preserve **both** tokens in the
      body instead of silently dropping the first, or mark the line ambiguous
      and refuse mutation with a bounded message. Pick one and test it.
- [x] On **new** text (`addTodos`, create modal, edit modal, paste), reject
      impossible leading dates and two-date lines with a bounded toast; do not
      save a partially mutated list.
- [x] Never call `format()` / `formatDateTag()` with a Date that has not been
      checked with `isValid`.

**Acceptance:** all four impossible-date examples load, display, serialize, and
survive an unrelated edit without throwing; adding/editing a new todo with one
is refused and nothing is written; two-date lines no longer lose a token.

**Tests:** extend `unit-tests/todo.test.ts` and add a date matrix to the new
hardening suite; include open/done lines and a mixed valid+invalid pair.

### 5. Clamp recurrence and validate the resulting date

**Status:** implemented in
[#25](https://github.com/ArnoNuyts/todotui/pull/25).

- [x] Parse `rec:` with a strict whole-value pattern (optional `+`, positive
      amount, `d/w/m/y`) rather than matching a substring anywhere.
- [x] Compute the next date with `addDays/addWeeks/addMonths/addYears`, then
      verify `isValid(next)` and `1 <= year <= 9999` before calling
      `formatDateTag`.
- [x] If the result is out of range, do not create the recurring instance and
      show a bounded toast (or refuse the toggle, matching MCP); the app must
      not crash.
- [x] Keep the existing end-of-month/leap-day clamping (`date-fns` already
      clamps `Jan 31 +1m` and `Feb 29 +1y`).
- [x] If a total todo cap is added, count the recurrence expansion before
      saving and refuse the whole mutation when it would exceed the cap.

**Acceptance:** `rec:999999999999y` and `rec:999999999999m` complete the todo
without throwing and without creating an invalid `due:` value; `Jan 31 +1m`
lands on the last day of February; out-of-range values produce a readable
message.

**Tests:** extend `unit-tests/todo-recurrence.test.ts` with overflow, strict
parsing, month-end, leap-day, and post-expansion cap cases.

### 6. Bound the read path before it allocates

**Status:** implemented in
[#24](https://github.com/ArnoNuyts/todotui/pull/24).

- [x] Use `Runtime.stat()` to reject an oversized file before `readTextFile`.
      Handle `ENOENT` with an exclusive create so a concurrent writer is not
      truncated.
- [x] After reading, re-check the byte length and run the structural validator
      from task 1 before `split`/`new Todo`.
- [x] Reject at `MAX_READ_TODOS + 1` lines and at `MAX_LINE_CHARS + 1`
      characters; report counts/lengths only.
- [x] Do not render a partial list after a rejected load; keep the last known
      good state and enter read-only mode (task 2).
- [x] Keep error messages actionable, e.g.
      `Todo file has 500000 lines; the limit is 10000. Trim the file or raise
      TODOTUI_MAX_READ_TODOS. Nothing was changed.`

**Acceptance:** a 1 MB / 500k-line file is rejected in <100 ms without a large
line array; a 10,001-line file is rejected under the default cap; a 8,193-char
line is rejected with its line number; a normal file still loads.

**Tests:** new `unit-tests/read-limits.test.ts`; generate files at runtime.
Add a low-heap check only if the project has a stable way to spawn a child
process; otherwise document the manual check.

## P2 — consistency and defense in depth

### 7. Bound the write path (create, edit, paste, programmatic add)

**Status:** implemented in
[#25](https://github.com/ArnoNuyts/todotui/pull/25). #24 adds the final
write-time serialization invariant.

- [x] Enforce `TODOTUI_MAX_TODO_CHARS` (default **2,000**, or 2,100 including
      metadata) on create/edit/paste.
- [x] Cap a paste batch (default **100** items) and keep the existing >10
      confirmation prompt.
- [x] Reject empty/whitespace-only text in `addTodos` itself, not only in the
      modal.
- [x] Reject `\n`, `\r`, `\u2028`, `\u2029`, C0/C1 controls (tab allowed only
      if the write path already permits it), and unpaired surrogates
      (`String.prototype.isWellFormed()`).
- [x] Enforce a total todo cap (including recurrence expansion) before any
      save.
- [x] Show one bounded toast per rejected action; never echo the payload.

**Acceptance:** pasting 10,000 lines shows a rejected-action message and adds
nothing; a 2,001-character todo is refused; whitespace-only, multi-line, and
lone-surrogate input never reaches `writeTodosToFile`.

**Tests:** extend `unit-tests/todo-context-pasting.test.tsx`,
`unit-tests/CreateTodoModal.test.tsx`, and `unit-tests/EditTodoModal.test.tsx`.

### 8. Normalize line endings and blank lines explicitly

**Status:** implemented in
[#24](https://github.com/ArnoNuyts/todotui/pull/24).

- [x] Accept CRLF on read by stripping one trailing `\r`; reject bare `\r`.
- [x] Decide whether blank lines are preserved or dropped on save. The current
      reader drops them and the writer always rewrites the file, so document
      the normalization rather than pretending saves are byte-stable.
- [x] Add a Windows CRLF fixture and a round-trip test.

**Acceptance:** a CRLF file loads, edits, and saves as LF without stray `\r`
characters or duplicated blank lines; a bare CR is rejected by task 1.

### 9. Keep errors and toasts bounded

**Status:** implemented in
[#24](https://github.com/ArnoNuyts/todotui/pull/24).

- [x] Validation and load/save errors report line number, length, offset, and
      `U+XXXX` only; never the line or payload.
- [x] Treat error text as display text too: sanitize/truncate before passing it
      to `showToaster`.
- [x] Do not print raw file content through `console.error` when a typed error
      already contains a safe message.

### 10. Optional: harden against visual spoofing

**Status:** deferred.

- [ ] Consider rejecting or escaping bidi controls (`U+202A–U+202E`,
      `U+2066–U+2069`) and zero-width characters that can visually reorder a
      todo line in a terminal.
- [ ] Keep this separate from the P0 control-character fix so it can be
      evaluated for false positives on legitimate RTL text.

## Test and CI checklist

- [x] New suites: `todo-file-validation.test.ts`, `read-limits.test.ts`,
      `tag-parsing.test.ts`, `todo-render-safety.test.tsx`, and a
      `hardening-matrix.test.ts` for dates/recurrence/paste.
      (`tag-parsing` and `hardening-matrix` are in
      [#25](https://github.com/ArnoNuyts/todotui/pull/25).)
- [x] Generate large files at runtime; do not commit megabyte fixtures.
- [x] Include the control matrix: tab (allowed), NUL, SOH, ESC, DEL, C1,
      U+2028, U+2029, bare CR, CRLF.
- [x] Include ANSI cases: SGR, OSC 0 title, OSC 8 hyperlink, CSI clear/hide.
- [x] Run `npm test` and `npm run check` before opening a PR.

## Explicitly not porting from `todo-txt-mcp`

- MCP tool schemas, hashes, `LIMIT_EXCEEDED` envelopes, and structured errors.
- `/healthz`, `/readyz`, readiness caching, proxy deny rules, auth tokens.
- TLS termination, single-user deployment hardening, Compose memory limits.
- WebDAV redirect refusal, content-type validation, ETag/revision handling.
- stdio transport framing and MCP rate limiting.
- Byte-stable save semantics: this app is an editor that rewrites the file;
  the goal is a clean canonical file, not preservation of every original byte.

## Suggested order

1. #1 control-character validation + display sanitization (P0).
2. #2 read-only mode after a rejected load (prevents data loss).
3. #4 impossible dates and #5 recurrence overflow (crash/data-loss fixes).
4. #3 linear tags (UI freeze).
5. #6 read bounds (memory/CPU DoS).
6. #7 write bounds, #8 CRLF, #9 bounded errors.
7. #10 optional visual spoofing and the full hardening test matrix.

## Reproductions

These are the probes used for the evidence table. They are intentionally small
and can be turned into the new test suites.

```ts
// Impossible dates
new Todo("2026-02-30 impossible").toString(); // RangeError
new Todo("x 2026-02-30 2026-01-01 done").toString(); // RangeError

// Recurrence overflow
new Todo("task rec:999999999999y").toggleState(); // RangeError

// Dropped date / empty line
new Todo("2026-01-01 2026-01-02 task").toString(); // "2026-01-02 task"
new Todo("   ").toString(); // ""

// Tag bomb
const line = `task ${Array.from({ length: 40_000 }, (_, i) => `ka:v${i}`).join(" ")}`;
new Todo(line); // ~4.8s for 389 KB

// Poisoned file
await Runtime.writeTextFile(
  filename,
  "innocent\rFAKE ROW\nansi\u001b]0;pwned\u0007title\nline\u2028sep\nnul\u0000byte\n",
);
await readTodosFromFile(filename); // returns 4 todos
```

For the terminal check, render a `<Text>` containing `\u001b[31mred`,
`\u001b]8;;https://evil\u0007link\u001b]8;;\u0007`, and `\u009b31m` with
`ink-testing-library`; the emitted frame still contains SGR and OSC 8
sequences.
