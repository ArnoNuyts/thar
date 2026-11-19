# CP7 — editor workstream (create/edit, text editor, suggestions)

This is the editor slice of CP7: the write-side input validation, the one-line
text editor, the project/context suggestion list, and the two screens that own
them (`CreateTodo`, `EditTodo`). Everything else in CP7 (date picker, calendar,
menus, archive/copy/paste UI) stays in its own workstream.

The branch bases on `rust-port/cp7-foundation` (PR #75), uses the foundation's
`Action::{AddTodos, UpdateText}`, `modal::geometry` and `theme`, and adds no
third-party dependency.

## What landed

| Layer                     | Module                                     | Oracle                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write-side validation     | `crates/thar-core/src/input.rs`            | `logic/todo-input.ts`, `logic/limits.ts`                                                                                                                                                         |
| One-line editor           | `crates/thar-tui/src/editor.rs`            | `components/ControlledTextInput.tsx`                                                                                                                                                             |
| Tag sources + suggestions | `crates/thar-tui/src/suggest.rs`           | `logic/tag-sources.ts`, `logic/patterns.ts`, `hooks/useSuggestionInput.ts`                                                                                                                       |
| Create/edit screens       | `crates/thar-tui/src/modal/create_edit.rs` | `components/CreateTodoModal.tsx`, `components/EditTodoModal.tsx`, `components/ModalTodoInput.tsx`, `components/SuggestionInput.tsx`, `components/SuggestionOverlay.tsx`, `utils/search-utils.ts` |
| Registry                  | `crates/thar-tui/src/modal/registry.rs`    | the modal host's one exhaustive dispatch table                                                                                                                                                   |

### Validation (`thar-core`)

`validate_todo_text(text, max_chars)` rejects, in the oracle's order:

1. `empty` — empty or whitespace only (JavaScript `trim`, so `U+FEFF` counts);
2. `multiline` — `\n`, `\r`, `U+2028`, `U+2029`;
3. `control-character` — C0/C1, DEL and the Unicode separators; tab is allowed;
4. `too-long` — measured in UTF-16 code units, matching
   `String.prototype.length`;
5. `invalid-date`, `ambiguous-date`, `leading-date` — the leading
   `YYYY-MM-DD` rules from `scanTodoPrefix`.

`validate_todo_batch(texts, existing_count, max_batch)` adds `batch-too-large`
and `too-many-todos` and validates every line before any is accepted, so a
batch is atomic. `validate_default_batch` is the `MAX_PASTE_TODOS` wrapper.

`TodoInputError` is an enum whose `Display` is the bounded user-facing message
and never echoes the rejected payload — every message is asserted in a table
test.

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

- `TagSources::collect` walks **every** todo (hidden rows included),
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

- **Create** prefills `extractTagsAndContextsFromSearch(query)` (`+a @b`) with
  the cursor at offset 0.
- **Edit** starts at the cursor todo's `text` with the cursor at the end and
  caps at `max(MAX_TODO_CHARS, original UTF-16 length)`, so an unchanged
  overlong legacy line still saves while a growing value is rejected.
- Keys: printable/movement/delete keys edit; while the list is open Up/Down move
  the highlight, Enter/Tab/Shift+Tab apply it, Escape only closes the list;
  otherwise Tab/Shift+Tab toggle Save/Cancel, Enter activates the selected
  button, Escape closes.
- Mouse: hovering Save/Cancel highlights it and clicking activates it. The row
  is the shared `modal::buttons` row, so the screen looks and hit-tests like the
  confirmation and update screens.
- A rejected value returns `Outcome::Actions([Action::Toast(message)])` and the
  screen stays open.
- Rendering: `» ` prompt, the character under the cursor in an inverse cell,
  then the shared `‹ Save ›` / `« Save »` button row. Suggestions are a
  floating popup (`view::suggestion`) sized to the longest
  name and anchored under the typed `+`/`@`; it is painted after the modal, can
  cover the body and buttons like the Ink root-level overlay, and never changes
  the modal's fixed body height. The modal chrome itself is the Ink one: a left
  accent bar and a primary title chip, not a box border.

The single exhaustive registry in `modal/registry.rs` builds every screen id.
It returns `OpenError::Unavailable` only when the host did not supply the update
model, and `OpenError::NeedsRequest` for `Confirm`, which is opened with its
request after an `Action::Confirm`.

## Read-only contract

- The one keymap runs through `command_for_key`; a read-only process maps
  every `Command::mutates()` intent (including `n`/`e`) to
  `Command::Toast(READ_ONLY_MESSAGE)` and the `READ-ONLY` badge stays.
- `thar-tui` gained no I/O: the screens return `Action`s, and the host applies
  them. `crates/thar-cli/tests/no_write.rs` (the CP6 source scan) still scans
  every source file; `clipboard.rs` has its own forbidden list that allows only
  the child-pipe `write_all(`.
- The PTY suite's existing read-only tests still pass, including
  `a_real_pty_session_leaves_the_file_and_directory_untouched`.

## Tests

New tests, all passing:

| File                                         | Count         | Covers                                                                                                                                                                              |
| -------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/thar-core/src/input.rs`              | 6             | validation table (accepted + every code), exact messages, UTF-16 cap, batch atomicity/capacity                                                                                      |
| `crates/thar-tui/src/editor.rs`              | 6             | 27-row keymap table, consumed/not-consumed keys, paste rules, char cursor, replace-range clamping                                                                                   |
| `crates/thar-tui/src/suggest.rs`             | 5             | source collection, word-start shapes, prefix filtering, wrap, apply                                                                                                                 |
| `crates/thar-tui/src/modal/create_edit.rs`   | 20            | prefill, create/edit outcomes, empty/invalid/control/leading-date rejection, Tab/Shift+Tab, Escape ordering, suggestions + apply, paste, overlong grandfathering, suggestion window |
| `crates/thar-tui/src/modal/buttons.rs`       | 3             | shared row render + proportional hit map (two and three buttons)                                                                                                                    |
| `crates/thar-tui/tests/golden_cp7_editor.rs` | 4             | cell-exact frames at 80×24 (create + suggestions, create prefill) and 100×30 (edit), plus inverse cursor / selected suggestion / selected button styles                             |
| `crates/thar-cli/tests/pty/cp7_editor.rs`    | 2 + 1 ignored | real PTY: `n` → type → suggestion → apply → submit → file gained the todo; Escape cancels byte-identically; ignored screenshot generator                                            |

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

## Windows paste detection

Windows does not report a bracketed paste as `Event::Paste`: a paste arrives as
individual key events, so `crates/thar-cli/src/terminal.rs` coalesces a burst of
queued printable presses into one paste. The rule is deliberately narrow, and
these are its known limits:

- **A paste of one repeated character stays single keys.** `qqq` or three spaces
  is indistinguishable from auto-repeat, so a burst needs at least three presses
  and at least two distinct keys. Typing `qqq` by hand is unaffected; pasting it
  runs the single-key commands.
- **`Ctrl+Alt+letter` looks like AltGr.** Windows reports both the same way, so
  the host clears the pair and types the layout character (which is how `@`,
  `€`, `{`, `[`, `\`, `|` and `~` type on many layouts). A `Ctrl+Alt` shortcut
  therefore cannot be told apart from an AltGr character.
- **Keys typed during a blocking effect may become a paste.** Copy, paste and
  archive run synchronously on the event loop; the clipboard call spawns
  `powershell.exe` and takes roughly 440 ms. Keys typed during that stall are
  only drained afterwards, and three or more distinct keys arriving together are
  treated as a paste. Moving those effects off the event loop would remove the
  stall; the timing change is not part of this slice, so the burst rule keeps
  these bounds documented instead.

## Deliberate gaps

- **Ctrl+C inside a modal closes the modal, not the process.** The modal host
  owns every key while a screen is open and the foundation's `Action` vocabulary
  has no quit, so `Ctrl+C` cannot reach the app keymap. Closing the screen is
  the least surprising bounded behaviour; making `Ctrl+C` global needs a
  foundation change (`Action::Quit` or a pre-dispatch check).
- **No mouse on the suggestion list.** The list is keyboard-only, per the
  workstream scope; Save/Cancel use the shared button row, so hover and click
  work like the other screens.
- **No help line on the create/edit screen.** Ink's `ModalTodoInput.tsx` draws
  `HELP_TEXT` under the buttons and grows the body; the Rust screen keeps a
  fixed 3-row body (input, spacer, buttons).
- **The suggestion list is a floating, content-sized popup.** It is anchored
  two columns left of the typed marker (so the row prefix aligns with it), sized
  to the longest name plus prefix/padding/borders, clamped to the frame, and
  flips above the anchor when there is no room below. At most six rows are drawn
  at once; the window scrolls with the highlight. The search bar uses the same
  popup with its `" / "` prompt origin.
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
