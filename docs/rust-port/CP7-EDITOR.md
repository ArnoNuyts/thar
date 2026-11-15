# CP7 — editor workstream (create/edit, text editor, suggestions)

This is the editor slice of CP7: the write-side input validation, the one-line
text editor, the project/context suggestion list, and the two screens that own
them (`CreateTodo`, `EditTodo`). Everything else in CP7 (date picker, calendar,
menus, archive/copy/paste UI) stays in its own workstream.

The branch bases on `rust-port/cp7-foundation` (PR #75), uses the foundation's
`Action::{AddTodos, UpdateText}`, `modal::geometry` and `theme`, and adds no
third-party dependency.

## What landed

| Layer | Module | Oracle |
| --- | --- | --- |
| Write-side validation | `crates/thar-core/src/input.rs` | `logic/todo-input.ts`, `logic/limits.ts` |
| One-line editor | `crates/thar-tui/src/editor.rs` | `components/ControlledTextInput.tsx` |
| Tag sources + suggestions | `crates/thar-tui/src/suggest.rs` | `logic/tag-sources.ts`, `logic/patterns.ts`, `hooks/useSuggestionInput.ts` |
| Create/edit screens | `crates/thar-tui/src/modal/create_edit.rs` | `components/CreateTodoModal.tsx`, `components/EditTodoModal.tsx`, `components/ModalTodoInput.tsx`, `components/SuggestionInput.tsx`, `components/SuggestionOverlay.tsx`, `utils/search-utils.ts` |
| Registry | `crates/thar-tui/src/modal/registry_editor.rs` | the modal host's dispatch table |

### Validation (`thar-core`)

`validate_todo_text(text, max_chars)` rejects, in the oracle's order:

1. `empty` — empty or whitespace only (JavaScript `trim`, so `U+FEFF` counts);
2. `multiline` — `\n`, `\r`, `U+2028`, `U+2029`;
3. `control-character` — C0/C1, DEL and the Unicode separators; tab is allowed;
4. `unpaired-surrogate` — see the note below;
5. `too-long` — measured in UTF-16 code units, matching
   `String.prototype.length`;
6. `invalid-date`, `ambiguous-date`, `leading-date` — the leading
   `YYYY-MM-DD` rules from `scanTodoPrefix`.

`validate_todo_batch(texts, existing_count, max_batch)` adds `batch-too-large`
and `too-many-todos` and validates every line before any is accepted, so a
batch is atomic. `validate_default_batch` is the `MAX_PASTE_TODOS` wrapper.

`TodoInputError` exposes the stable `code` (the TypeScript
`TodoInputErrorCode` string), `code_str`, and a bounded `message`/`Display` that
never echoes the rejected payload — every message is asserted in a table test.

**Unpaired surrogates.** A Rust `&str` is always well-formed UTF-16, so
`validate_todo_text` can never produce that code. The variant stays in the
vocabulary and `validate_utf16(&[u16], max_chars)` makes it reachable: it takes
the raw code units a JavaScript host already holds, reports
`unpaired-surrogate` for a lone surrogate, and keeps the oracle's ordering (a
blank buffer is `empty`, a line feed is `multiline`, a C0 byte is
`control-character` even when it sits next to the stray surrogate).

### Editor (`thar-tui/src/editor.rs`)

`Editor { chars, cursor }` is a pure state machine:

- Left/Right/Home/End; `Ctrl`/`Meta` make Left/Right move by word;
- Backspace/Delete, and `Ctrl`/`Meta` Backspace/Delete remove a word (Delete
  skips a space run first, like `moveWordRight(value, offset, true)`);
- printable characters insert at the cursor; keys with `Ctrl`/`Alt`/`Meta`/
  `Super`/`Hyper` are commands, not text;
- Enter, Tab, Escape and Up/Down are **not** consumed, so the modal owns them;
- bracketed paste strips `\r`/`\n` and trims a multi-character insert, exactly
  like `insertAtCursor`; a single character is inserted verbatim;
- there is no length cap in the editor; the modal validates on submit.

**Cursor unit.** The cursor is a `char` index (`0..=len`), not a byte offset and
not a UTF-16 offset. Rendering maps it to a terminal cell, so one astral
character is one cursor step and one cell. The validation cap deliberately uses
UTF-16 units instead, because that is what `String.prototype.length` reports.
The two measures differ only for astral characters, and the reason is documented
in the module header.

### Suggestions (`thar-tui/src/suggest.rs`)

- `TagSources::collect(&[Todo])` walks **every** todo (hidden rows included),
  de-duplicates projects and contexts, and sorts them (the `[\w.\-_]` alphabet
  is ASCII, so byte order is the JavaScript default sort order).
- `match_tag_word_start(left)` reproduces the two oracle shapes —
  `^[+@][\w.\-_]*$` and `\s[+@][\w.\-_]*$` — and reports the character index of
  the prefix and the term after it. A bare `+` or `@` is a valid word start that
  lists everything.
- `Suggestions::update` filters case-insensitively with `starts_with` (no fuzzy
  ranking, no scoring) and resets the selection to the first match.
- `select_previous`/`select_next` wrap at both ends.
- `apply(text, cursor)` replaces the typed word with `prefix + name + " "` and
  leaves the cursor after the inserted space; the text after the cursor is
  preserved, exactly like `applySuggestion`.
- No mouse handling.

### Screens (`modal/create_edit.rs`)

One `TextModal` with a `Create`/`Edit` mode:

- **Create** prefills `extractTagsAndContextsFromSearch(query)` (` +a @b `) with
  the cursor at offset 0.
- **Edit** starts at the cursor todo's `text` with the cursor at the end and
  caps at `max(MAX_TODO_CHARS, original UTF-16 length)`, so an unchanged
  overlong legacy line still saves while a growing value is rejected.
- Keys: printable/movement/delete keys edit; while the list is open Up/Down move
  the highlight, Enter/Tab/Shift+Tab apply it, Escape only closes the list;
  otherwise Tab/Shift+Tab toggle Save/Cancel, Enter activates the selected
  button, Escape closes.
- A rejected value returns `Outcome::Actions([Action::Toast(message)])` and the
  screen stays open.
- Rendering: `» ` prompt, the character under the cursor in an inverse cell, the
  suggestion rows below the input, then a bordered Save/Cancel row and the Ink
  help line. The suggestion list is inline, so `body_rows` grows with it (capped
  at six visible rows with a scrolling window) and the centred modal stays
  centred.

The registry returns `Some` for `CreateTodo`/`EditTodo` and `None` for every
other id, so the host keeps its bounded "not available" toast for the screens
other workstreams own.

## Read-only contract

- The new keymap is only reachable through `writable_list_key`; a read-only
  process still maps `n`/`e` to `Command::Rejected(READ_ONLY_MESSAGE)` and the
  `READ-ONLY` badge stays.
- `thar-tui` gained no I/O: the screens return `Action`s, and the host applies
  them. `crates/thar-cli/tests/no_write.rs` (the CP6 source scan) is unchanged
  and green.
- The PTY suite's existing read-only tests still pass, including
  `a_real_pty_session_leaves_the_file_and_directory_untouched`.

## Tests

New tests, all passing:

| File | Count | Covers |
| --- | --- | --- |
| `crates/thar-core/src/input.rs` | 6 | validation table (accepted + every code), exact messages, UTF-16 cap, unpaired surrogate, batch atomicity/capacity |
| `crates/thar-tui/src/editor.rs` | 6 | 27-row keymap table, consumed/not-consumed keys, paste rules, char cursor, replace-range clamping |
| `crates/thar-tui/src/suggest.rs` | 5 | source collection, word-start shapes, prefix filtering, wrap, apply |
| `crates/thar-tui/src/modal/create_edit.rs` | 16 | prefill, create/edit outcomes, empty/invalid/control/leading-date rejection, Tab/Shift+Tab, Escape ordering, suggestions + apply, paste, overlong grandfathering, suggestion window |
| `crates/thar-tui/tests/golden_cp7_editor.rs` | 3 | cell-exact frames at 80×24 (create + suggestions, create prefill) and 100×30 (edit), plus inverse cursor / selected suggestion / selected button styles |
| `crates/thar-cli/tests/pty/cp7_editor.rs` | 2 + 1 ignored | real PTY: `n` → type → suggestion → apply → submit → file gained the todo; Escape cancels byte-identically; ignored screenshot generator |

Gates run from the branch head:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

All three are green. No benchmark or performance work was done.

## Screenshot

`docs/rust-port/assets/cp7-editor.png` is a real 100×30 PTY frame: `--write`,
`n` for the create screen, `buy oat milk for the week +th` typed, the `+thar`
row highlighted and `+thar-tui` below it. Nothing is mocked; the image comes
from the parsed `vt100` screen (`crate::screenshot::{svg, rasterize}`).

Regenerate with:

```sh
cargo test -p thar-cli --test pty -- --ignored cp7_editor_screenshot
```

`ffmpeg` with the librsvg decoder is required for the SVG → PNG step, the same
as the CP6/CP7-write assets.

## Deliberate gaps

- **Ctrl+C inside a modal closes the modal, not the process.** The modal host
  owns every key while a screen is open and the foundation's `Action` vocabulary
  has no quit, so `Ctrl+C` cannot reach the app keymap. Closing the screen is
  the least surprising bounded behaviour; making `Ctrl+C` global needs a
  foundation change (`Action::Quit` or a pre-dispatch check).
- **No mouse in the create/edit screens.** The suggestion list is
  keyboard-only, per the workstream scope; Ink also supports hover and click on
  the Save/Cancel buttons.
- **The suggestion list is inline, not a floating overlay.** `Modal::body_rows`
  has no frame geometry, so reserving rows is what keeps the modal centred
  deterministically. At most six suggestions are drawn at once; the window
  scrolls with the highlight.
- **The help line is clipped at the modal width** instead of wrapping like
  `countWrappedLines`, because `body_rows` cannot know the terminal width.
- **The input scrolls horizontally** instead of wrapping. A wrapped input would
  change `body_rows` per frame and make the cursor cell ambiguous at a soft
  wrap.
- **Paste trimming uses `thar_core::js_trim`**, the same JavaScript
  `String.prototype.trim()` set the parsers use, so `U+FEFF` is trimmed and
  `U+0085` (NEL) is kept. A pasted control character is not silently dropped:
  it stays visible via `sanitize_for_display` and the submit is rejected with
  the bounded `control-character` toast, exactly like the oracle.
- **`extract_tags_and_contexts` keeps the search-token alphabet**, which
  includes a literal backslash (`[\w.\\_\-]`) that the todo parser itself does
  not accept. That is the oracle's `SEARCH_TAG_NAME_PATTERN`, not a typo.
- **No edit screen for a todo without a cursor row**: it opens empty and
  submits `UpdateText` with no ids, which the host treats as a no-op — the same
  shape as `initialValue={todo?.text || ""}`.
