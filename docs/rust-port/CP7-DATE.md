# CP7 — dates, calendar, priority, recurrence and tag editors

- **Branch:** `rust-port/cp7-date`
- **Base:** `rust-port/cp7-foundation` (`0bb4189`, PR #75)
- **Status:** implemented and green; no performance work, no new dependencies.

This workstream ports the date/threshold screens, the month calendar, the
priority screen, the two-step recurrence screen and the project/context tag
editor. It fills the matching arms of `modal/registry_date.rs` and
`modal/registry_meta.rs`, so the list keymap's `d`, `t`, `A`..`F`, `r`, `+` and
`@` now open real screens instead of the foundation's bounded "not available"
toast.

## What landed

### `thar-core::date` — public calendar arithmetic

The private `add_days`/`add_months` helpers from `recurrence.rs` (and their
Hinnant civil-day conversions) moved into `date.rs` and are now the one copy:

| Function                          | Semantics                                                                  |
| --------------------------------- | -------------------------------------------------------------------------- |
| `add_days(base, i64)`             | whole calendar days, negative allowed                                      |
| `add_weeks(base, i64)`            | seven calendar days per week                                               |
| `add_months(base, i64)`           | date-fns `addMonths`, **clamping** the day: `2024-01-31 + 1m = 2024-02-29` |
| `add_years(base, i64)`            | twelve months, so `2024-02-29 + 1y = 2025-02-28`                           |
| `start_of_month` / `end_of_month` | first/last day of the same month                                           |
| `days_in_month(year, month)`      | now public; `0` for an invalid month                                       |
| `weekday(date)`                   | Monday `0` … Sunday `6`                                                    |
| `start_of_week_monday(date)`      | `startOfWeek(date, { weekStartsOn: 1 })`                                   |

Every operation returns `None` when the result leaves years 1..=9999, and
overflowing counts are `None` rather than a panic. `Recurrence::plan` now calls
these functions instead of keeping a second implementation; its existing
month-end, leap-day and year-bound tests are unchanged and still pass.

Tests added: a day/week/month/year table (leap years, `Jan 31 + 1 month`,
`Feb 29 + 1 year`, year boundaries), out-of-range and overflow cases, month
bounds, `weekday == 0` for a Monday across centuries, and the Monday week start
at the first supported day.

### `thar-tui::calendar`

`Calendar` owns the value, the viewed month and the value that last moved the
view (the TypeScript component's render-time `isSameMonth` sync). It is
Monday-first, renders four to six whole weeks, and handles:

| Key                       | Action        |
| ------------------------- | ------------- |
| Up / Down                 | −1 / +1 week  |
| Left / Right              | −1 / +1 day   |
| Shift/Ctrl + Left / Right | −1 / +1 month |
| Enter                     | submit        |
| anything else             | ignored       |

There is no mouse handling, matching `Calendar.tsx`. The renderer draws the
`MMMM yyyy` title, the `Mo Tu We Th Fr Sa Su` header, three-column cells, the
success background on the selected day, and muted+dim out-of-month days.

**Year bounds:** a navigation key that would leave 1..=9999 is ignored (the
TypeScript `Date` could go out of range and `isValidTodoDate` would reject it
later). The trailing cells of the last week of December 9999 cannot be
represented and render blank.

### `modal/date.rs` — `Set Due Date` / `Set Threshold Date`

Options are Today, Tomorrow, Next Week, Next Month and Custom, plus Reset when
the reference todo (`selected_todos()[0]`, load order) already carries the tag.
Relative days resolve from `App.today` with the new date arithmetic. Custom
switches to the calendar at the existing tag date (or today when the tag is
malformed or absent); Enter applies and Escape from the calendar returns to the
list step. The list rows accept hover and click; the calendar is keyboard-only.
The screen emits `Action::SetDue` / `Action::SetThreshold`, with `None` for
Reset, so the app keeps one undo step per apply.

### `modal/priority.rs` — `Set Priority`

`A`..`F` in shortcut order, plus Unset only when the reference todo has a
priority. Up/Down wrap, Enter applies, Escape closes, and clicking a row applies
it while hover moves the marker. Emits `Action::SetPriority`.

### `modal/recurrence.rs` — `Set Recurrence`

Step one is Daily, Weekly, Monthly, Yearly, plus Reset only when the reference
todo has a `rec:` tag. Step two is the amount: digits only, starting at `"1"`,
where the first typed digit replaces the default and choosing a base resets it.
Enter validates `amount + unit` with `is_valid_recurrence`; a rejection shows
the bounded toast `Recurrence must be a whole number from 1 to 9999` and keeps
the screen open. Escape returns to the base step, then closes. The amount step's
chrome names the chosen base (`Set Recurrence Interval (Weekly)`). Base rows
accept hover and click; the amount step is keyboard-only.

### `modal/tag.rs` — project/context editor

The universe is the sorted union of every todo's projects (or contexts). Each
row is tri-state for the selection and Space cycles exactly like the Ink
component:

- `some` → add → remove → clear pending;
- `all` → remove → clear pending;
- `none` → add → clear pending.

The first row is the custom input with the ASCII `[\w.\-_]` character set;
backspace deletes the last character, and cursor movement and paste are
deliberately absent (matching the component). Enter applies the trimmed custom
value first and then every pending change as a **separate**
`Action::{AddTag,RemoveTag}`; the app therefore records one undo step for the
custom value plus one per changed tag. Escape discards. Mouse row 0 focuses the
custom input, row 1 is the separator (a no-op), and rows 2.. toggle tags.

### Registries

`registry_date::open` builds the two date screens and `registry_meta::open`
builds priority, recurrence and the two tag editors. `modal/mod.rs` gains the
four private module declarations; `lib.rs` exports `calendar`. The update
screen belongs to its own workstream and stays unavailable.

## Tests and evidence

- **Date arithmetic table** — `thar-core/src/date.rs` unit tests (leap years,
  month-end clamping, leap-day years, year bounds, overflows, weekday/week
  start).
- **Calendar** — navigation table, view-follows-value sync, reset-on-base
  behaviour, out-of-range moves, grid shape (four to six weeks), and a
  `TestBackend` render asserting the title, header, selected-cell colours and
  out-of-month colour.
- **Each screen** — key and mouse outcome tests for both date steps, priority,
  both recurrence steps, and the tag editor; tag tri-state cycles for `some`,
  `all` and `none`; a history-grouping test proving the custom value plus two
  pending changes produce **3** undo steps and undo restores the original
  serialized lines.
- **Goldens** — `crates/thar-tui/tests/golden_cp7_date.rs`, eight frames:
  exact 80×24 due list and 100×30 calendar blocks, plus pinned 80×24 priority,
  recurrence base/amount, context editor and 100×30 project editor frames
  (dimensions, centring, markers `»`, `[x]`/`[?]` colours and the `WRITE`
  badge).
- **PTY** — `crates/thar-cli/tests/pty/cp7_calendar.rs`:
  - a non-ignored real-PTY test opens `--write`, presses `d`, moves to Custom,
    opens the calendar, moves one day right and Enter, exits with `q`, and
    asserts the file now contains `due:2024-05-07` and not `due:2024-05-06`
    (the fixture's fixed due date makes it independent of the wall clock);
  - an `#[ignore]`d `cp7_calendar_screenshot` generator captures the live
    100×30 calendar frame to
    [`assets/cp7-calendar.png`](./assets/cp7-calendar.png) with
    `crate::screenshot::{asset_path, rasterize, svg}`;
  - an escape test proves the first Escape returns from the calendar to the
    list step and a second closes without writing.

### Gates

Run from the repository root with Node `26.12.0` selected:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-features
```

- `cargo fmt --all --check`: clean.
- Clippy (`-D warnings`, every target and feature): clean.
- `cargo test --locked --workspace --all-features`: **515 passed, 0 failed,
  4 ignored** (the three manual screenshot generators and the manual row-perf
  report). The new targets are 148 `thar-core` unit tests, 114 `thar-tui` unit
  tests, 8 `golden_cp7_date` frames, and the PTY target at 15 passed with 3
  ignored. `tests/no_write.rs` and `tests/read_only.rs` still pass unchanged:
  `thar-tui` gained no filesystem or process I/O.

### Screenshot

`docs/rust-port/assets/cp7-calendar.png` is a real 100×30 PTY frame: the list
behind the `Set Due Date` modal, the May 2024 calendar opened on the existing
`due:2024-05-06`, the selected day moved to 7, and `Selected: 2024-05-07` below
the grid. It is regenerated only on demand:

```sh
cargo test -p thar-cli --test pty -- --ignored cp7_calendar_screenshot
```

## Deliberate gaps and deviations

- **Mouse rectangles are taken when the screen opens.** `Modal::handle_mouse`
  receives no terminal geometry, so each screen stores `App::width/height` at
  construction and resolves its box from that. Rendering still uses the live
  frame, so a resize with a modal open re-centres the drawing but leaves the
  stored hit-test rectangle stale until the screen is reopened. The Ink app
  reads the live window size on every mouse event.
- **Calendar out-of-range policy** is "ignore the key" (documented above)
  rather than building a year-10000 `TodoDate`; the last week of December 9999
  renders its unrepresentable trailing cells blank.
- **Recurrence amount editing is a simplified text field.** It has no cursor,
  selection or paste; non-digit keys are ignored and do not consume the
  "first digit replaces the default" slot. That reproduces the oracle's
  documented outcome (`a1b2` → `12`, hence `12d`) without porting the Ink text
  input's ref/state interactions.
- **The custom tag input** likewise has no cursor movement and accepts no
  bracketed paste, matching `AddTagContextModal.tsx`.
- **The calendar is keyboard-only**, matching the TypeScript component; the
  date list, priority list, recurrence base list and tag rows are clickable.
- **The Update screen** (`ModalId::Update`) is not part of this workstream and
  still answers with the foundation's bounded message.
- **No performance work** was done and no benchmark claim is made, per the
  checkpoint instruction. No third-party dependency was added.
