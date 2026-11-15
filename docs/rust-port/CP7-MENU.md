# CP7 — menus, confirmations, archive, clipboard and the update screen

This is the menu workstream of CP7. It builds on the CP7 foundation (write mode,
save safety, undo/redo and the modal host) and fills the screens that the list
keymap already named: the two command menus, the generic confirmation, the
update screen, and the archive/copy/paste paths behind them.

The read-only contract is unchanged. Every key below lives only in the
`--write` keymap; the default binary still rejects it with one bounded toast.

## What landed

### `modal/menu.rs` — one list widget, two exact tables

- `MENU_ITEMS` is the 16-row single-todo table from `components/TodoMenu.tsx`,
  in order: Edit, Delete, Toggle Complete, Set Due Date, Set Threshold Date, Set
  Recurrence, Set Priority, Modify Projects, Modify Contexts, Toggle Hidden,
  Show/Hide Hidden, Archive Completed, Copy, Undo, Redo, Paste.
- `MULTI_SELECT_MENU_ITEMS` is the 10-row range table: Delete, Toggle, Due,
  Threshold, Recurrence, Priority, Projects, Contexts, Toggle Hidden, Copy.
  Edit and the global commands stay in the single-todo menu, matching the Ink
  table.
- Up/Down move the marker and wrap; Enter activates; Escape closes; a displayed
  shortcut dispatches immediately (`space` and `del` included). Return and
  Escape are named keys and never fall through to shortcut lookup.
- Mouse: a move over a body row moves the marker; a left click on a body row
  activates it.
- Every row maps to the foundation `Action` vocabulary: `Open` for the
  editor/date/meta screens, `Toggle`, `Delete`, `SetDue`, `SetThreshold`,
  `SetRecurrence`, `SetPriority`, `AddTag`, `ToggleHidden`,
  `ToggleHiddenView`, `ArchiveCompleted`, `Copy`, `Paste`, `Undo`, `Redo`.
- Delete and Archive open a `Confirm` first; the confirmation carries the
  follow-up action.

### `modal/confirm.rs` — generic confirmation with follow-up actions

`ConfirmRequest` is data, not a callback:

```rust
pub struct ConfirmRequest {
    pub title: String,
    pub message: String,
    pub confirm: Box<Action>,
    pub cancel: Option<Box<Action>>,
}
```

`Action::Confirm(ConfirmRequest)` is handled by `App`, which opens the screen.
On confirm the screen returns `Actions([Close, confirm])`, so the app applies
the follow-up only after the modal has released its borrow. Exact strings:

| Case | Title | Message |
| --- | --- | --- |
| delete one | `Delete Todo` | `Are you sure you want to delete this todo?` |
| delete many | `Delete Todos` | `Are you sure you want to delete N todos?` |
| archive | `Archive Completed` | `Archive all completed todos to done.txt?` |
| paste > 10 | `Paste Multiple Todos` | `Are you sure you want to paste N todos?` |

Keys: Enter/Space activate the hovered-or-selected button, Tab (and
Left/Right) navigate with wrap, Escape cancels. The buttons are centred in
equal halves of the modal width; a left-half click confirms and a right-half
click cancels (the Ink `bodyCell.column < modalWidth / 2` map). Hover is
label-exact, like `getHoveredButtonIndex`: only the `« Confirm »` / `« Cancel »`
cells set a hover, and the hover wins over the selection on Enter.

### `modal/update.rs` — the update screen

`App::update_model: Option<UpdateModel>` defaults to `None`. The screen renders
the model's four content rows:

```
Current: v0.4.0  →  Latest: v0.5.0
Install method: npm (global)
Command: npm install -g @arnoarnoarno/thar@latest
Release notes: https://github.com/ArnoNuyts/thar/releases/tag/v0.5.0
```

The width is 70%. Actions are dynamic: `Update now`, `Later`, `Skip this
version` when `can_self_update`, otherwise `Later`, `Skip this version`.
Enter/Space activate, Tab/Left/Right navigate, Escape closes. The mouse map
splits the button row proportionally across the visible actions.

"Update now" closes the screen and emits `Self-update arrives with CP8`; it
performs no network or process work. "Skip this version" closes and toasts the
version for this session.

### List-key wiring (`input.rs`)

| Key | Command | Result |
| --- | --- | --- |
| `x` / Enter | `Open(TodoMenu or MultiSelectMenu)` | command menu |
| `a` | `Archive` | archive confirmation |
| `Delete` | `DeleteSelected` | delete confirmation |
| `c` | `CopySelected` | `Effect::Copy` with canonical lines |
| `v` | `Paste` | `Effect::Paste`, then `App::receive_clipboard` |
| `u` | `Open(Update)` when the model exists, else one toast | update screen |

The clipboard read stays in `thar-cli` (`thar_store::clipboard::paste`), so
`thar-tui` still has no filesystem or process I/O. `App::receive_clipboard`
owns the splitting, the `MAX_PASTE_TODOS` (100) rejection and the >10
confirmation; it then applies `Action::PasteLines`, which adds the todos and
shows `Pasted N todo(s)`.

### Archive

The foundation terminal path is unchanged: `Effect::ArchiveCompleted` appends
the completed todos to `<file-dir>/done.txt` through `thar_store::append_done`
and only then removes their ids. The PTY test asserts both sides of the round
trip: `done.txt` gains the serialized line and `todo.txt` loses it.

### Foundation additions

- `Modal::resize` (default no-op) and `Stack::resize`; `App::resize` forwards a
  changed terminal size so wrapping and the mouse map follow a resize.
- `modal/text.rs`: the shared word wrapper (`countWrappedLines` port) used by
  the confirmation and update bodies. The renderer and the hit test read the
  same lines.
- `Action::PasteLines { lines }` splits "read the clipboard" from "add these
  lines", so the confirmation can carry the follow-up batch.
- `Session::open_write_with` in the PTY support module, used to point `PATH` at
  an empty directory for the clipboard-failure test.

## Evidence

- `thar-tui` unit tests: 99 (the menu tables, every shortcut dispatch, named
  keys not falling through, wrap/navigation, confirm keys and half-body mouse
  map, exact confirmation strings, update action set, >10 paste confirmation,
  delete/archive follow-ups, read-only key rejection).
- `crates/thar-tui/tests/golden_cp7_menu.rs`: six `TestBackend` goldens at
  80×24 and 100×30 — single menu (marker and shortcut colours, all 16 rows),
  multi-select menu (10 rows, absent commands), archive confirmation, delete
  confirmation, update screen, and the ephemeral-install update variant.
- `crates/thar-cli/tests/pty/cp7_menu.rs`: menu open + `space` toggle + saved
  bytes; archive `done.txt` / main-file round trip; delete confirmation and
  saved bytes; clipboard failure as one bounded toast; read-only run rejecting
  `x a c v u` and creating nothing.
- `docs/rust-port/assets/cp7-menu.png`: a real 100×30 PTY frame, generated by
  the `#[ignore]`d `cp7_menu_screenshot` test.

Gates: `cargo fmt --all --check`, `cargo clippy --locked --workspace
--all-targets --all-features -- -D warnings`, and `cargo test --locked
--workspace --all-features` are green.

## Deliberate gaps and deviations

- **No update check, no self-update.** CP7 renders a host-supplied model only.
  `u` is a bounded "No update available" toast until something sets it. The
  network check, skip cache, install detection and the updater are CP8.
- **Skip is session-only.** There is no persisted skipped-version cache yet, so
  the badge/announcement cannot be suppressed across restarts.
- **Content width uses the full-bordered box.** The Ink modal has only a left
  border, so it wraps at `modalWidth - 3`; the ratatui overlay draws a full
  border and wraps at `modalWidth - 4` (border plus one padding cell on each
  side). Both the renderer and the mouse map read the same wrapper, so rows and
  clicks stay aligned; only the break column differs from Ink.
- **Paste confirmation threshold is 10, cap is 100.** The Ink command confirms
  above ten lines and `validateTodoBatch` caps a batch at `MAX_PASTE_TODOS`.
  Bracketed paste into the list keeps its existing direct add + cap path; this
  workstream only changed the `v` command.
- **Modal chrome.** The shared overlay draws a four-sided `Block` (all CP7
  screens inherit it); the Ink modal uses an underline-only title and a left
  border.
- No performance or benchmark work was done.
