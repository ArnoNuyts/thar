# Code Smell Review — todotui

- **Date:** 2026-10-19
- **Reviewed snapshot:** `feature/ink-8` @ `d4e4413`
- **Scope:** all 81 TypeScript/TSX files (production code + tests)
- **Baseline:** `deno lint` clean, `deno check main.tsx` clean, `deno task test`
  → 202 passed
- **Methods:** manual review, four independent reproduction agents, and
  `npx react-doctor@latest`
- **Goal:** simplicity and DRY. No fixes are included in this document.

## Status legend

| Status        | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| **PROVEN**    | Reproduced at runtime with a script or temporary test.    |
| **STATIC**    | Confirmed by reading the code; not separately reproduced. |
| **RD**        | Reported by `react-doctor` (see appendix).                |
| **DISPROVEN** | Checked and found not to be a bug. Kept for the record.   |

React Doctor scored the repo **70 / 100 ("Needs work")** with **9 warnings, 0
errors**. It reported `reactDetected: false` / `framework: "unknown"`, so
React-specific hook rules were gated off. Absence of hook findings from that
tool is **not** evidence that those issues are absent.

---

## Summary

| Priority | Area                                | Count                |
| -------- | ----------------------------------- | -------------------- |
| P1       | Correctness bugs behind smells      | 6                    |
| P2       | DRY / duplicated logic              | 11                   |
| P3       | Simplicity, data model, performance | 11                   |
| P4       | Small cleanups                      | 16                   |
| RD       | Additional react-doctor findings    | 4 rules / 9 warnings |

---

## Fix progress

Updated 2026-10-20. Every item below landed through TDD: a failing test first, then the fix, then `deno lint`, `deno check main.tsx`, and the full suite.

| Item | Status | Commit | Test evidence |
| --- | --- | --- | --- |
| P1 #1 — completion date dropped | ✅ FIXED | `b330585` | `unit-tests/todo.test.ts` |
| P1 #2 — tags accumulate / cannot be removed | ✅ FIXED | `b330585`, `8ec2046` | `unit-tests/todo.test.ts`, `unit-tests/EditTodoModal.test.tsx` |
| P1 #3 — duplicate undo snapshots | ✅ FIXED | `d6b944a` | `unit-tests/todo-context-history.test.tsx` |
| P1 #4 — recurring todo duplicated in StrictMode | ✅ FIXED | `d6b944a` | `unit-tests/todo-context-history.test.tsx` |
| P1 #5 — no-op archive creates undo entry | ✅ FIXED | `d6b944a` | `unit-tests/todo-context-history.test.tsx` |
| P1 #6 — clipboard failure unhandled | ✅ FIXED | `3ef1688` | `unit-tests/todo-list.test.tsx` |

Current suite: **214 passed, 0 failed**.

---

## P1 — Correctness bugs hiding behind smells

### 1. Completion date is dropped when a done todo has no creation date — PROVEN

- **Location:** `logic/todo.ts:61-68`
- **Issue:** `_completionDate` is only set when **both** the completion-date and
  creation-date groups match. For `x 2024-01-01 buy milk`, the single date is
  captured as `creationDate`, so `completionDate` stays `undefined` and the
  completion date is reinterpreted as the creation date.
- **Evidence:**

  ```text
  input         : "x 2024-01-01 buy milk"
  text          : "buy milk"
  isDone        : true
  creationDate  : 2023-12-31   # local timezone rendering of 2024-01-01
  completionDate: undefined
  toString      : "x 2024-01-01 buy milk"
  ```

- **Fix:** Parse each date group independently. Only assign a completion date
  when the done marker and a completion date are present; do not use completion
  date as a creation-date fallback.

### 2. Tags accumulate on re-parse and cannot be removed via `setText` — PROVEN

- **Location:** `logic/todo.ts:210-245`
- **Issue:** `internalParseText` clears `_projects` and `_contexts` but never
  clears `_tags`. Re-parsing the same tag converts it to an array and appends
  duplicates. Removing the tag from the text leaves the old entry in `_tags`.
- **Evidence:**

  ```text
  t0.tags                          : {}
  t1.tags                          : { rec: "1d" }
  t2.tags (setText same tag again) : { rec: ["1d", "1d"] }
  t3.tags (tag removed from text)  : { rec: ["1d", "1d"] }
  t3.toString                      : "buy milk rec:1d,1d"
  after 3 setText calls            : { rec: ["1d", "1d", "1d"] }
  ```

- **Minimal repro:**
  `new Todo("a").setText("a rec:1d").setText("a rec:1d").tags`
- **Fix:** Make parsing pure and rebuild tag state on each parse. If tags must
  survive edits, pass them explicitly instead of merging into existing mutable
  state.

### 3. Undo history stores duplicate/stale snapshots — PROVEN

- **Location:** `contexts/todo-context.tsx:91-94` (`pushHistory`), used by
  `updateTodos` at line 173.
- **Issue:** `pushHistory()` captures `todos` from the render closure. When one
  event handler calls `updateTodos` twice before a re-render (as
  `AddTagContextModal.applyChanges` does in a loop), both calls push the same
  pre-change array. Undo then skips the intermediate state, and later undo steps
  are no-ops that still consume history.
- **Evidence:** two synchronous updates `text → "A" → "B"`:

  ```text
  after 1st undo -> text: Todo 1 | canUndo: true
  after 2nd undo -> text: Todo 1 | canUndo: true   # no-op
  after 3rd undo -> length: 0    | canUndo: false

  CONTROL (awaited between updates): after 1st undo -> text: A
  ```

- **Fix:** Push history inside the functional `setTodos(prev => ...)` update, or
  batch multiple edits into one update before pushing.

### 4. Recurring todos can be duplicated by an impure state updater — PROVEN

- **Location:** `contexts/todo-context.tsx:189-213` (`toggleTodos`)
- **Issue:** `newInstances` is declared outside the `setTodos` updater and
  mutated inside it, then appended inside the same updater and read for the
  toast. Updaters must be pure. When React invokes the updater twice (StrictMode
  / re-entrant render), the recurring todo is appended twice.
- **Evidence:**

  ```text
  CONTROL (no StrictMode): after toggle -> length = 2   # 1 done + 1 recurring
  StrictMode             : after toggle -> length = 3   # 1 done + 2 identical recurring
  ```

- **Fix:** Compute recurring instances before calling `setTodos`, or derive them
  once from `prev` inside the updater without mutating outer variables.

### 5. Archiving with nothing completed creates an undo entry — PROVEN

- **Location:** `contexts/todo-context.tsx:219-222`
- **Issue:** `pushHistory()` runs before the `completedTodos.length === 0` early
  return, so a no-op archive still adds history and clears redo.
- **Evidence:**

  ```text
  before archive       : todos = 0 | canUndo = false
  after no-op archive  :               canUndo = true
  ```

- **Fix:** Move `pushHistory()` after the empty check.

### 6. Clipboard failures are unhandled in the list view — STATIC

- **Location:** `components/TodoList.tsx:361-370` vs
  `components/TodoMenu.tsx:143-161`
- **Issue:** The list path calls `copyToClipboard(...)` without `await`/`try`,
  then always shows "Todo copied". `copyToClipboard` is async and can reject on
  spawn/write/status, producing an unhandled rejection. The menu path awaits
  inside `try/catch` and reports `Copy failed: …`.
- **Fix:** Share one command handler (see P2 #6) that awaits and reports
  failure.

---

## P2 — DRY: duplicated logic

### 7. Modal mouse/layout helpers are duplicated — STATIC

- `getHoveredButtonIndex` exists twice: `components/ModalTodoInput.tsx:201-235`
  and `components/ConfirmModal.tsx:150-183`.
- `countWrappedLines` exists twice: `components/ModalTodoInput.tsx:237-265` and
  `components/ConfirmModal.tsx:185-211`.
- **Fix:** Move both to `utils/modal-mouse.ts` (or a new
  `utils/modal-layout.ts`) and import.

### 8. Modal chrome-row constants are hardcoded three times — STATIC

- `utils/modal-mouse.ts:7-8` defines `MODAL_TOP_CHROME_ROWS` /
  `MODAL_BOTTOM_CHROME_ROWS`.
- `components/ConfirmModal.tsx:24-25` redefines them locally.
- `components/ModalTodoInput.tsx:208-209` hardcodes `3` / `2` again.
- **Fix:** Export the constants and use them everywhere.

### 9. Suggestion handling is copied between two inputs — STATIC

- `components/SearchInput.tsx:78-162`
- `components/SuggestionInput.tsx:141-222`
- Both duplicate the word-start regex, `updateSuggestions`, up/down/enter/escape
  handling, and suggestion insertion.
- **Fix:** Extract one `useSuggestionInput({ value, cursor, source, onApply })`
  hook plus shared regex constants.

### 10. Project/context matching regex is repeated 5+ times — STATIC

- `logic/todo.ts:17-18`
- `utils/search-utils.ts:14-20`
- `components/SearchInput.tsx:81,141`
- `components/SuggestionInput.tsx:144,206`
- **Fix:** Define `PROJECT_REGEX` / `CONTEXT_REGEX` (and a word-start matcher)
  in one shared module.

### 11. Selectable-list modals reimplement the same list behavior — STATIC

- `components/SetDateModal.tsx`
- `components/SetRecurrenceModal.tsx`
- `components/SetPriorityModal.tsx`
- `components/TodoMenu.tsx`
- Each reimplements index state, wrap-around up/down, enter/escape, list
  rendering, and `useModalMouseList`.
- **Fix:** One `SelectListModal` component or `useListSelection` hook with
  options, labels, and an `onSelect`.

### 12. Command logic is duplicated between list and menu, and has already drifted — PROVEN

- `components/TodoList.tsx:254-401`
- `components/TodoMenu.tsx:82-303`
- Sixteen actions are implemented twice: edit, delete, toggle, due, threshold,
  recurrence, priority, project, context, hidden toggle, show/hide, archive,
  copy, undo, redo, paste.
- Confirmed drift: copy error handling (P1 #6), priority UX (`A`–`F` inline vs
  `p` modal), archive confirmation (`await` vs floating promise).
- **Fix:** Extract `useTodoCommands()` (or a command registry) used by both the
  list and the menu.

### 13. Menu shortcut metadata is not the source of truth — PROVEN

- **Location:** `components/TodoMenu.tsx:38-55` (`MENU_ITEMS[].shortcut`) vs
  `238-300` (hand-written `if` chain).
- The `shortcut` field is only rendered at line 337. Dispatch is a parallel
  re-encoding. All shortcuts currently resolve, but Delete is handled as
  `key.delete` instead of the declared literal `"del"`, which is exactly the
  kind of drift the duplication permits.
- **Fix:** Build a `shortcut → action` map from `MENU_ITEMS` and look it up
  once.

### 14. Selection-range row calculation is copied three times — STATIC

- `contexts/navigation-context.tsx:370-383`
- `contexts/navigation-context.tsx:558-573`
- `contexts/navigation-context.tsx:699-712`
- **Fix:** `getSelectionRangeRows(indexes, rangeIds, fallbackRow)`.

### 15. Project/context aggregation is duplicated — STATIC

- `components/SearchInput.tsx:54-65` (memoized)
- `components/SuggestionInput.tsx:54-65` (IIFE, recomputed every render)
- **Fix:** One memoized selector/helper.

### 16. Modal rendering is a growing if-chain — STATIC

- `main.tsx:38-56` matches on `activeModal` string by string.
- **Fix:** A `Record<ModalId, Component>` registry so adding a modal is one
  entry.

### 17. The priority list is duplicated — STATIC

- `components/TodoList.tsx:385-398` (A–F inline)
- `components/SetPriorityModal.tsx:12-19` (A–F list)
- **Fix:** Export one `PRIORITIES` constant and one `applyPriority` helper.

---

## P3 — Simplicity, data model, performance

### 18. `Todos extends Array<Todo>` is a leaky abstraction — PROVEN

- **Location:** `logic/Todos.ts:3`
- **Evidence:**

  ```text
  new Todos(a, b).filter(x => true)  -> Todos instance
  new Todos(a, b).map(x => x.text)   -> Todos instance containing strings
  map result still has .sortByImportance() -> throws "b.isOverdue is not a function"
  new Todos(3).length                -> 3 holes, not [3]
  ```

- The subclass forces `new Todos(...arr)` in 23 places (8 in production), even
  where `filter` already returns a `Todos`.
- **Fix:** Use a plain `Todo[]` and pure helpers (`sortByImportance(todos)`,
  `filterHidden(todos)`).

### 19. `navigation-context.tsx` is a 1000-line multi-purpose module — STATIC

- **Location:** `contexts/navigation-context.tsx`
- It owns index creation, search filtering, selection reconciliation, scrolling,
  and the public API. `guesstimateSelection`, `validateSelection`, and
  `calculateScrollOffset` are already pure and can move to `logic/`.
- **Fix:** Move pure functions out; turn the provider into a thin reducer hook.

### 20. State is written during render — STATIC

- **Location:** `contexts/navigation-context.tsx:343-493`
- Two separate derived-state blocks call `setState` mid-render (prop sync and
  validation). This is hard to reason about and can trigger extra renders.
- **Fix:** Compute the reconciled state with `useMemo` / `useReducer` and commit
  it through events, not render.
- **Note:** `react-doctor` did **not** flag this because it did not detect React
  in this Deno project.

### 21. Hook-named functions are not hooks — STATIC

- **Location:** `contexts/navigation-context.tsx:922-932`
- `useSelectedTodo` / `useSelectedTodos` are plain selectors returned from
  context, but their names imply hook rules. They are called inside handlers and
  tests.
- **Fix:** Rename to `getSelectedTodo` / `getSelectedTodos`.

### 22. Unreachable fallback in `validateSelection` — PROVEN (reasoning)

- **Location:** `contexts/navigation-context.tsx:153-158`
- The forward scan (`[targetIndex, len-1]`) and backward scan
  (`[0, targetIndex-1]`) cover the whole array, and the no-todo case already
  returned at line 116. "Fallback 3: first todo" can never execute.
- **Fix:** Delete it and drop the redundant casts after `entry.type ===` checks.

### 23. `Todo` setters repeat the clone-and-assign pattern — STATIC

- **Location:** `logic/todo.ts:153-291`
- Ten setters are `const next = this.clone(); next._x = y; return next;`.
  `clone()` itself uses `Object.create` + `Object.assign`, which is fragile.
- **Fix:** Add one private `with(partial)` helper or a copy constructor.

### 24. `sortByImportance` performs four chained sorts — STATIC

- **Location:** `logic/Todos.ts:4-33`
- Four stable passes are harder to read and slower than one comparator with a
  precomputed key.
- Also note `isOverdue()` returns true when the due date is **today**; consider
  renaming or documenting.
- **Fix:** One comparator or decorate-sort-undecorate.

### 25. Todo numbering and React keys are O(n²) / weak — PROVEN

- **Location:** `components/TodoList.tsx:488-490` and `:497`
- Numbering slices and filters the full index list for every visible row:
  O(visible × n) per render.
- Key is `index + entry.todo.getHash()`, i.e. number + string concatenation with
  a non-unique content hash. `todo.id` is a unique symbol and is available.
- **Evidence:** warm benchmark of the numbering loop:

  ```text
  n=1000:   9 ms
  n=2000:  26 ms
  n=4000:  97 ms
  n=8000: 411 ms     # ~4x per doubling => quadratic
  ```

- **Fix:** Store the todo number in `createIndexes`, and use `String(todo.id)`
  as the key.

### 26. `guesstimateSelection` is O(n²) — PROVEN

- **Location:** `contexts/navigation-context.tsx:74-77`
- `prevTodos.find(...)` runs inside `todos.filter(...)`.
- **Evidence:** benchmark ratios ≈ 4× per doubling (`2000 → 4000 → 8000`).
- **Fix:** Build an `id → todo` Map once per reconciliation.

### 27. `createIndexes` mutates headers already pushed to the output — STATIC

- **Location:** `logic/indexes.ts:31-52`
- Back-fills `todoCount` by keeping a reference to the last header. Also uses
  unnecessary `todo?.` and loose `!=`.
- **Fix:** Build the list in one pass and set counts when closing each group.

### 28. Watcher/debounce lifecycle is not fully cleaned up — STATIC

- **Location:** `contexts/todo-context.tsx:73-133`
- The watcher is closed on cleanup, but the debounced save/read are not
  cancelled, and `processEvents()` is an unawaited floating promise. Pending
  callbacks can fire after unmount or after `filename` changes.
- **Fix:** Call the debounce `.cancel()`, guard the async loop with a cancelled
  flag, and catch iteration errors.

### 29. `useInput` rebuilds large lookup arrays per keystroke — STATIC / RD

- **Location:** `hooks/useInput.ts:407,438,474`
- Three literal arrays of escape sequences are allocated inside the per-input
  handler, then scanned with `.includes()`. `react-doctor` flags these as
  `js-set-map-lookups`.
- **Fix:** Hoist the arrays/modifier sets to module scope (or use `Set`s).

---

## P4 — Small cleanups

### 30. File helper exits the process — STATIC

- **Location:** `logic/todo-file-helpers.ts:22-25`
- `readTodosFromFile` logs and calls `Deno.exit(1)`. Library code should throw.
  The `stat` + `read` sequence is also a TOCTOU race; just read and create on
  `NotFound`.

### 31. Manual path concatenation for `done.txt` — STATIC

- **Location:** `contexts/todo-context.tsx:226-233`
- Detects separators by checking for `"\\"`. Use `@std/path` `dirname`/`join`.

### 32. Date-tag parsing is duplicated and inconsistent — STATIC

- **Location:** `components/SetDateModal.tsx:39-41` splits manually;
  `logic/todo.ts:191` uses `parseISO`.
- **Fix:** One `parseDateTag(value)` helper used by both.

### 33. Ref written during render — STATIC

- **Location:** `components/SearchInput.tsx:42` (`focusRef.current = focus`)
- Move the assignment into an effect or callback.
- **Note:** `react-doctor` did not flag this.

### 34. `SetPriorityModal` type annotation does not match its data — STATIC

- **Location:** `components/SetPriorityModal.tsx:12`
- Declared as `(UpperCaseLetter | "Unset")[]` but initialized with only `A`–`F`.
  The annotation implies `"Unset"` is present. Fix the type or include it.

### 35. Dead/commented code — STATIC

- `components/ControlledTextInput.tsx:46-47`
- `components/SuggestionInput.tsx:82-102`
- `components/Calendar.tsx:34-37`
- `logic/todo.ts:114-116`
- **Fix:** Delete.

### 36. Word-motion logic is copied three times — STATIC

- **Location:** `components/ControlledTextInput.tsx:120-129`, `180-188`,
  `213-248`
- Extract `moveWordLeft` / `moveWordRight`.

### 37. Hardcoded color — STATIC

- **Location:** `components/Button.tsx:43` uses `"#FFFFFF"`; use a `COLORS`
  entry.

### 38. Two input patterns coexist — STATIC

- `SearchInput`, `SuggestionInput`, `Calendar`, and `Button` use raw `useInput`
  with manual `isFocused` guards; other components use `useFocusedInput`.
- **Fix:** Standardize on `useFocusedInput`.

### 39. Broken `install-hooks` task — STATIC

- **Location:** `deno.json:7` references `scripts/install-hooks.ts`, which does
  not exist (`scripts/` only contains `capture-raw.ts` and
  `mouse-input-log.tsx`).
- **Fix:** Remove the task or add the script.

### 40. `constants.ts` is a pass-through — STATIC

- **Location:** `constants.ts:1-4`
- Only re-exports two colors. Import `COLORS` directly and delete the file.

### 41. `Modal` has a dead prop — STATIC

- **Location:** `components/Modal.tsx:8`
- `isFocused` is declared in `ModalProps` and passed by every modal, but never
  destructured or used. Remove it.

### 42. Calendar effect/typing nits — STATIC

- `components/Calendar.tsx:70-74`: effect reads `viewDate` but omits it from
  dependencies.
- `components/Calendar.tsx:87-95`: `weeks` / `currentWeek` are untyped.
- **Fix:** Add the dependency and type the arrays (`Date[][]`).

### 43. `SetDateModal` uses manual date arithmetic — STATIC

- **Location:** `components/SetDateModal.tsx:39-41,77-90`
- Manual `split("-")` plus `setMonth` can overflow (e.g. Jan 31 + 1 month) and
  behaves differently from `date-fns`. Use `addDays`/`addMonths`/`parseISO`
  consistently.

### 44. `utils/modal-mouse.ts` re-export wrapper — STATIC

- **Location:** `utils/modal-mouse.ts:32-35`
- `getTerminalSize` only forwards to the terminal-size helper. Import directly.

### 45. Tests use fixed sleeps — STATIC

- `unit-tests/todo-context-component.test.tsx:93` waits `600ms` for a `500ms`
  debounce.
- `unit-tests/todo-context-pasting.test.tsx:24-37` and
  `unit-tests/todo-context-undo.test.tsx:25-38` chain `delay(0)`.
- `agent.md` already says to prefer `waitFor` from `unit-tests/test-utils.ts`.

---

## Disproven claims (for the record)

### D1. The `H` toast is **not** reversed — DISPROVEN

- **Original claim:** `TodoList.tsx:374-377` shows the opposite message.
- **Runtime result:** with one hidden todo, after the first `H` the hidden todo
  becomes visible and the toast reads **"Hidden todos shown"**. After the second
  `H` it hides and reads **"Hidden todos hidden"**.
- **Why:** the ternary reads the pre-toggle `showHidden`, but because the toggle
  inverts it, `showHidden ? "hidden" : "shown"` describes the **new** state
  correctly.

### D2. `new Todo(todo.toString())` round-trips incorrectly — DISPROVEN

- **Runtime result:** a todo with `+project`, `@context`, `rec:1d`, `due:...`,
  and `h:1` re-serializes to an identical string; tags/projects/contexts are
  preserved. Only the `symbol` id changes, which is expected.

### D3. React Doctor's silence on hook issues is not proof

- React Doctor reported `reactDetected: false` and gated off framework-specific
  rules. It did **not** flag the setState-in-render, impure updater, or
  ref-write-in-render issues. That absence is not evidence.

---

## Appendix A — react-doctor output (verbatim)

Command: `cd /home/arno/todotui && npx --yes react-doctor@latest .` (exit
code 0)

```text
✔ Scanned 81 files in 3.0s

React Doctor — todotui
Score: 70 / 100 Needs work

9 issues
Bugs: 4 warnings
Performance: 5 warnings

⚠ Array index used as a key ×4
  react-doctor/no-array-index-as-key
  components/Button.tsx:138
  components/TodoList.tsx:29
  components/TodoList.tsx:38
  components/TodoList.tsx:47
⚠ array.find() inside a loop
  react-doctor/js-index-maps
  contexts/navigation-context.tsx:768
⚠ Array lookup inside a loop ×3
  react-doctor/js-set-map-lookups
  hooks/useInput.ts:407
  hooks/useInput.ts:438
  hooks/useInput.ts:474
⚠ await inside a loop
  react-doctor/async-await-in-loop
  unit-tests/test-utils.ts:11
```

Additional details from `--json`:

```json
"summary": {
  "errorCount": 0,
  "warningCount": 9,
  "affectedFileCount": 5,
  "totalDiagnosticCount": 9,
  "score": 70,
  "scoreLabel": "Needs work"
}
```

Interpretation notes:

- The four `no-array-index-as-key` findings are minor here.
  `TodoList.tsx:29/38/47` keys are for the inline text segments of a single
  todo; `Button.tsx:138` is a small static button group. They are still worth
  replacing with stable keys (`todo.id`, `button.props.label`).
- `navigation-context.tsx:768` is the `findIndex` in `doNavigate`; build an
  index map once per render/navigation.
- `hooks/useInput.ts` findings overlap with P3 #29 and are real allocations in a
  hot path.
- `unit-tests/test-utils.ts:11` is an intentional polling loop; this one is
  test-only noise.

---

## Appendix B — reproduction commands used

Baseline:

```sh
cd /home/arno/todotui
deno lint
deno check main.tsx
deno task test          # 202 passed
npx --yes react-doctor@latest .
```

Runtime proofs (scratch files were kept outside the repo):

```sh
# Todo parsing (claims 1 & 2)
cd /home/arno/todotui
deno run --allow-read --config ./deno.json /tmp/opencode/prove-todo.ts

# Todos Array subclass behavior
deno run --allow-read --config ./deno.json /tmp/opencode/claims.ts

# O(n^2) benchmarks
deno run --allow-read --config ./deno.json /tmp/opencode/bench-c.ts
deno run --allow-read --config ./deno.json /tmp/opencode/bench-d.ts

# Context history / StrictMode / archive (temporary ink test, deleted afterwards)
deno test -A unit-tests/.prove-history.test.tsx

# UI behavior / duplicate commands (temporary ink test, deleted afterwards)
deno test -A unit-tests/.prove-ui.test.tsx
```

No tracked files were changed by the proof runs; `git status --short` was clean
before this review document was added.
