//! Terminal lifecycle and the event loop for `thar-rs`.
//!
//! The process owns exactly one terminal session. Raw mode, the alternate
//! screen, mouse capture, bracketed paste and cursor visibility are enabled
//! together and restored together: on a normal exit through
//! [`TerminalSession`]'s `Drop`, and on a panic through the installed hook. A
//! panic must never leave the user's terminal in raw mode, which is why the
//! restore path does not depend on unwinding reaching the end of the event
//! loop.
//!
//! The loop is deliberately small: draw, wait for one event (with a timeout for
//! the nearest toast expiry, save debounce, local midnight or file-watch poll),
//! apply it, repeat. All state transitions live in `thar-tui`; this module only
//! translates crossterm and the filesystem.
//!
//! # File sync
//!
//! The loop owns one [`FileSync`]: after every event (or timeout) it polls the
//! todo file, and a debounced external change replaces the list, clears the
//! undo history, refreshes the save baseline and toasts "File reloaded". A
//! failed reload keeps the last good list, cancels a pending save and enters
//! the read-only recovery state; the next successful reload clears it. The
//! policy is documented in `crates/thar-cli/src/sync.rs` and
//! `docs/rust-port/CP7-SYNC.md`.

use std::io::{self, Stdout};
use std::panic;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::Show;
use ratatui::crossterm::event::{
    self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event, KeyEventKind, MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use thar_core::{ReadLimits, TodoDate};
use thar_store::SaveGuard;
use thar_tui::event::{LastClick, MouseInput, MouseKind};
use thar_tui::input;
use thar_tui::{App, Effect, view};

use crate::clipboard::{copy, paste};
use crate::file::{get_read_limits, parse_bytes};
use crate::sync::{FileSync, RELOADED_MESSAGE, ReloadOutcome, bounded_message};

/// Poll timeout used only when the host clock cannot produce a midnight.
const CLOCK_FALLBACK: Duration = Duration::from_secs(60);

/// Never poll for exactly zero: a due timer must wake the loop, not spin it.
const MIN_POLL: Duration = Duration::from_millis(1);

/// Test-only trigger that panics after the session has entered.
///
/// A PTY test sets this to `1` to prove the panic hook restores the terminal.
/// It is inert unless the value is exactly `1`, and the trigger is compiled
/// out of release builds.
const PANIC_ENV: &str = "THAR_TUI_PANIC";

/// A panic hook owned by the session so it can be restored after the TUI exits.
type PanicHook = Arc<dyn Fn(&panic::PanicHookInfo<'_>) + Send + Sync>;

/// Today's local calendar day.
///
/// CP6 needs only `YYYY-MM-DD`, so the date is taken from the host's local
/// zone and converted into the strict domain type. The fallback is the epoch
/// only if the local zone reports an out-of-range year, which a correct host
/// clock cannot do.
#[must_use]
pub fn today_local() -> TodoDate {
    let date = jiff::Zoned::now().date();
    let year = u16::try_from(date.year()).unwrap_or(1970);
    let month = u8::try_from(date.month()).unwrap_or(1);
    let day = u8::try_from(date.day()).unwrap_or(1);
    TodoDate::new(year, month, day)
        .or_else(|| TodoDate::new(1970, 1, 1))
        .expect("the epoch is a valid date")
}

/// Time until the next local midnight, computed from the zone in `now`.
///
/// The result is an exact duration to the first instant of tomorrow in that
/// zone, including a DST transition. `None` means the host clock cannot
/// produce a representable instant (near the calendar bounds), not that there
/// is no midnight.
fn until_next_local_midnight(now: &jiff::Zoned) -> Option<Duration> {
    let tomorrow = now.date().tomorrow().ok()?;
    let midnight = tomorrow.to_zoned(now.time_zone().clone()).ok()?;
    let remaining = midnight.timestamp().duration_since(now.timestamp());
    Duration::try_from(remaining).ok()
}

/// Poll timeout: the nearest of the toast expiry, the save debounce, the file
/// watcher's next metadata check or reload deadline, and the next local
/// midnight.
fn next_poll_timeout(app: &App, now: Instant, sync: &FileSync) -> Duration {
    let midnight = until_next_local_midnight(&jiff::Zoned::now()).unwrap_or(CLOCK_FALLBACK);
    let timeout = app
        .toast_timeout(now)
        .map_or(midnight, |toast| midnight.min(toast));
    let timeout = app
        .save_timeout(now)
        .map_or(timeout, |save| timeout.min(save));
    timeout.min(sync.poll_timeout(now)).max(MIN_POLL)
}

/// Restore everything the TUI may have changed, including the cursor.
fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        Show,
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen
    );
}

/// True when the test-only panic trigger is set to exactly `1`.
fn panic_value_is_trigger(value: Option<&str>) -> bool {
    value == Some("1")
}

fn panic_trigger_requested() -> bool {
    let raw = std::env::var_os(PANIC_ENV);
    panic_value_is_trigger(raw.as_deref().and_then(std::ffi::OsStr::to_str))
}

/// A live terminal session; dropping it restores the terminal.
pub struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    previous_hook: Option<PanicHook>,
}

impl TerminalSession {
    /// Enter raw mode, the alternate screen, mouse capture, and bracketed
    /// paste, and install a restore-on-panic hook.
    ///
    /// # Errors
    ///
    /// Propagates terminal setup failures. A partially enabled session is
    /// restored before the error is returned.
    ///
    /// # Panics
    ///
    /// Panics only when the test-only `THAR_TUI_PANIC=1` trigger is set; the
    /// panic hook restores the terminal before the previous hook runs.
    pub fn start() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(
            stdout,
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        ) {
            restore_terminal();
            return Err(error);
        }

        // Build the terminal before installing the hook so a setup failure can
        // restore the modes without leaking a hook that points at a session
        // that was never constructed.
        let terminal = match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => terminal,
            Err(error) => {
                restore_terminal();
                return Err(error);
            }
        };

        let previous = panic::take_hook();
        let shared: PanicHook = Arc::from(previous);
        let hook = Arc::clone(&shared);
        panic::set_hook(Box::new(move |info| {
            restore_terminal();
            // The previous hook prints the message and backtrace; restoring
            // first keeps that output readable on a normal screen.
            hook(info);
        }));

        let session = Self {
            terminal,
            previous_hook: Some(shared),
        };

        // Debug builds only: the PTY suite needs a deterministic panic, but a
        // release binary must never crash because an environment variable is
        // set. CI runs the PTY tests in the development profile.
        if cfg!(debug_assertions) && panic_trigger_requested() {
            panic!("{PANIC_ENV}=1: deliberately panicking to test terminal restore");
        }

        Ok(session)
    }

    /// Draw one frame and wait for one event, without a write path.
    ///
    /// # Errors
    ///
    /// Propagates draw, event-read, and size failures.
    pub fn run(&mut self, app: &mut App) -> io::Result<()> {
        self.run_with_store(app, None)
    }

    /// Draw one frame and wait for one event, saving through `store` when it is
    /// present.
    ///
    /// # Errors
    ///
    /// Propagates draw, event-read, and size failures.
    pub fn run_with_store(
        &mut self,
        app: &mut App,
        mut store: Option<&mut SaveGuard>,
    ) -> io::Result<()> {
        // The reload path must use the same limits as the initial load, so an
        // environment override cannot make a reload accept a file the startup
        // read would reject (or the reverse). `run` already turned an invalid
        // override into exit code 2; the default is only a library-caller
        // fallback.
        let limits = get_read_limits().unwrap_or_default();
        let mut sync = FileSync::new(app.filename(), limits);
        let mut last_click: Option<LastClick> = None;

        loop {
            let size = self.terminal.size()?;
            app.resize(size.width, size.height);

            let now = Instant::now();
            app.expire_toast(now);
            if app.save_due(now) {
                flush_save(app, store.as_deref_mut(), &mut sync, now);
            }
            self.terminal.draw(|frame| view::render(frame, app))?;

            if app.should_quit() {
                // The Ink app can lose a save queued <50 ms before `q`; CP7
                // flushes it, because losing the last keystroke of an edit is
                // exactly the data-safety failure this checkpoint exists to
                // prevent.
                if app.is_dirty() {
                    flush_save(app, store.as_deref_mut(), &mut sync, now);
                }
                if app.is_dirty() {
                    return Err(io::Error::other(
                        "unsaved changes: the last save failed; the file was left untouched",
                    ));
                }
                return Ok(());
            }

            // The search cursor is painted as an inverse cell by the view, so
            // the terminal's own cursor stays hidden on every frame.
            self.terminal.hide_cursor()?;

            let timeout = next_poll_timeout(app, Instant::now(), &sync);
            if event::poll(timeout)? {
                match event::read()? {
                    Event::Key(key) => {
                        if key.kind != KeyEventKind::Release
                            && !app.handle_modal_key(key, now)
                            && let Some(command) = input::command_for_key_in(app, key)
                        {
                            input::apply(app, command, now);
                        }
                    }
                    Event::Mouse(mouse) => {
                        if let Some(kind) = mouse_kind(mouse.kind) {
                            let input = MouseInput {
                                kind,
                                x: mouse.column.saturating_add(1),
                                y: mouse.row.saturating_add(1),
                                shift: mouse
                                    .modifiers
                                    .contains(ratatui::crossterm::event::KeyModifiers::SHIFT),
                            };
                            if app.handle_modal_mouse(input, now) {
                                // The modal consumed the click.
                            } else {
                                let (next, command) =
                                    input::handle_mouse(app, input, last_click, now);
                                last_click = next;
                                if let Some(command) = command {
                                    input::apply(app, command, now);
                                }
                            }
                        }
                    }
                    Event::Resize(width, height) => app.resize(width, height),
                    Event::Paste(text) => {
                        if !app.handle_modal_paste(&text, now) {
                            paste_into_focused(app, &text, now);
                        }
                    }
                    // Focus does not change any read-only state. The next
                    // iteration redraws and re-checks the local day.
                    Event::FocusGained | Event::FocusLost => {}
                }
            }

            // After every event or timeout: reload an externally edited file.
            // A reload that lands while a save is pending drops the in-memory
            // edit (the external file wins) because `App::reloaded` clears the
            // pending save, which is the Ink hook's `onLoad` behaviour.
            apply_reload(
                app,
                &mut sync,
                store.as_deref_mut(),
                &limits,
                Instant::now(),
            );

            process_effects(app, store.as_deref_mut(), now);

            // A timeout at (or past) midnight lands here and re-derives the
            // local day, rebuilding overdue/threshold verdicts exactly once.
            app.set_today(today_local());
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        restore_terminal();
        let _ = self.terminal.show_cursor();
        // During unwinding std forbids changing the panic hook; the panic hook
        // installed by `start` already restored the terminal, and the default
        // hook stays in place for the rest of the unwind.
        if let Some(previous) = self.previous_hook.take()
            && !std::thread::panicking()
        {
            panic::set_hook(Box::new(move |info| previous(info)));
        }
    }
}

/// Enter the TUI, run it until quit, and restore the terminal.
///
/// # Errors
///
/// Propagates terminal setup and draw errors.
pub fn run_tui(app: &mut App) -> io::Result<()> {
    let mut session = TerminalSession::start()?;
    session.run(app)
}

/// Enter the TUI with a write path and restore the terminal on exit.
///
/// # Errors
///
/// Propagates terminal setup and draw errors.
pub fn run_tui_with_store(app: &mut App, store: &mut SaveGuard) -> io::Result<()> {
    let mut session = TerminalSession::start()?;
    session.run_with_store(app, Some(store))
}

/// Write the dirty list now and record the outcome on the app.
///
/// A successful save records the self-write window on the watcher and adopts
/// the written bytes as the comparison baseline, so the save's own metadata
/// change does not schedule a reload. A failed save (including
/// [`thar_store::StoreError::ChangedOnDisk`]) keeps the target untouched, shows
/// one bounded message, keeps the list dirty and retries after the app's
/// backoff. The watcher normally reloads the external file first, which clears
/// the dirty state and rebaselines both the guard and the watcher; a quit
/// before that happens exits non-zero rather than reporting a false save.
fn flush_save(app: &mut App, store: Option<&mut SaveGuard>, sync: &mut FileSync, now: Instant) {
    let Some(store) = store else {
        if app.is_read_only() {
            app.mark_saved();
        } else {
            // A write-enabled app must never report a successful save without
            // a store. This is a programming error, not a user error, but it
            // still must not drop the edit silently.
            app.mark_save_failed(now, "no write store is attached");
        }
        return;
    };
    match store.save(app.todos()) {
        Ok(_) => {
            // The window starts after the rename, not before the serialization,
            // so a slow filesystem cannot shorten it.
            sync.note_write(Instant::now());
            sync.adopt(store.last_bytes());
            app.mark_saved();
        }
        Err(error) => app.mark_save_failed(now, error.to_string()),
    }
}

/// Apply one watcher outcome: reload the list, or enter read-only recovery.
///
/// On success the parsed bytes become both the watcher baseline and the save
/// guard baseline in one step, so the bytes that were parsed are exactly the
/// bytes a later save compares against.
fn apply_reload(
    app: &mut App,
    sync: &mut FileSync,
    store: Option<&mut SaveGuard>,
    limits: &ReadLimits,
    now: Instant,
) {
    let outcome = match sync.poll(now) {
        Some(outcome) => outcome,
        None => return,
    };

    match outcome {
        ReloadOutcome::Changed(bytes) => match parse_bytes(&bytes, limits) {
            Ok(todos) => {
                app.reloaded(todos);
                if let Some(store) = store {
                    store.set_baseline(bytes.clone());
                }
                sync.adopt(&bytes);
                app.push_toast(RELOADED_MESSAGE);
            }
            Err(error) => app.reload_failed(bounded_message(&error.to_string())),
        },
        ReloadOutcome::Unchanged => {
            if app.load_error().is_some() {
                app.recovered();
                app.push_toast(RELOADED_MESSAGE);
            }
        }
        ReloadOutcome::Unreadable(message) => app.reload_failed(message),
    }
}

/// Drain the host effects queued by commands.
fn process_effects(app: &mut App, mut store: Option<&mut SaveGuard>, now: Instant) {
    for effect in app.take_effects() {
        match effect {
            Effect::ArchiveCompleted => archive(app, store.as_deref_mut(), now),
            Effect::Copy(text) => copy_to_clipboard(app, &text),
            Effect::Paste => paste_from_clipboard(app, now),
        }
    }
}

fn archive(app: &mut App, store: Option<&mut SaveGuard>, now: Instant) {
    let ids = app.completed_ids();
    if ids.is_empty() {
        return;
    }
    let Some(_store) = store else {
        app.push_toast(thar_tui::app::NOT_SAVED_MESSAGE);
        return;
    };
    // `done.txt` is a write. A session in read-only recovery must not append
    // to it either, matching the Ink provider's archive guard.
    if !app.writable() {
        app.push_toast(thar_tui::app::NOT_SAVED_MESSAGE);
        return;
    }

    let todos = app.todos_by_ids(&ids);
    let done = done_path(app.filename());

    match thar_store::append_done(&done, &todos) {
        Ok(()) => app.remove_ids(&ids, now),
        Err(error) => app.push_toast(format!("Archive failed: {error}")),
    }
}

fn copy_to_clipboard(app: &mut App, text: &str) {
    let count = text.lines().count();
    match copy(text) {
        Ok(()) => app.push_toast(match count {
            1 => "Todo copied".to_owned(),
            count => format!("{count} todos copied"),
        }),
        Err(error) => app.push_toast(format!("Copy failed: {error}")),
    }
}

fn paste_from_clipboard(app: &mut App, now: Instant) {
    match paste() {
        Ok(text) => app.receive_clipboard(&text, now),
        Err(error) => app.push_toast(format!("Paste failed: {error}")),
    }
}

fn done_path(filename: &std::path::Path) -> std::path::PathBuf {
    std::path::Path::new(filename)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("done.txt")
}

fn mouse_kind(kind: MouseEventKind) -> Option<MouseKind> {
    match kind {
        MouseEventKind::ScrollUp => Some(MouseKind::WheelUp),
        MouseEventKind::ScrollDown => Some(MouseKind::WheelDown),
        MouseEventKind::Down(MouseButton::Left) => Some(MouseKind::LeftClick),
        MouseEventKind::Moved => Some(MouseKind::Move),
        _ => None,
    }
}

/// True for a character that may be inserted by a bracketed paste.
///
/// Line breaks, tabs and the other C0/C1 controls (plus the two Unicode line
/// separators) are dropped: the search input is one line, and pasted terminal
/// control data must never reach the query.
fn is_pastable(character: char) -> bool {
    !thar_core::is_rejected_control(character)
}

/// Bracketed paste into the focused surface.
///
/// The search bar keeps its one-line filter. The list hands the raw text to
/// [`App::receive_clipboard`], which owns splitting, trimming, the core
/// validation (including control characters), the paste limit, the large paste
/// confirmation and the shared read-only gate. Modals receive their paste
/// through [`App::handle_modal_paste`] before this function runs.
///
/// There is deliberately no read-only early return here: the list paste must go
/// through [`App::receive_clipboard`] so the one mutation gate produces the
/// bounded toast instead of silently dropping the paste.
fn paste_into_focused(app: &mut App, text: &str, now: Instant) {
    if app.search_focused() {
        let text: String = text
            .chars()
            .filter(|character| is_pastable(*character))
            .collect();
        input::insert_query_text(app, &text);
        return;
    }

    app.receive_clipboard(text, now);
}

#[cfg(test)]
mod tests {
    use super::{
        is_pastable, panic_value_is_trigger, paste_into_focused, today_local,
        until_next_local_midnight,
    };
    use std::time::{Duration, Instant};

    use thar_core::TodoDate;
    use thar_tui::App;

    #[test]
    fn today_is_a_valid_calendar_date() {
        let date = today_local();
        assert!(date.year() >= 1970);
        assert!((1..=12).contains(&date.month()));
        assert!((1..=31).contains(&date.day()));
    }

    #[test]
    fn next_midnight_is_computed_exactly() {
        let now = jiff::civil::date(2026, 11, 15)
            .at(23, 59, 59, 0)
            .in_tz("UTC")
            .expect("valid zoned datetime");
        assert_eq!(
            until_next_local_midnight(&now),
            Some(Duration::from_secs(1))
        );
    }

    #[test]
    fn next_midnight_from_noon_is_twelve_hours() {
        let now = jiff::civil::date(2026, 11, 15)
            .at(12, 0, 0, 0)
            .in_tz("UTC")
            .expect("valid zoned datetime");
        assert_eq!(
            until_next_local_midnight(&now),
            Some(Duration::from_secs(12 * 60 * 60))
        );
    }

    #[test]
    fn only_the_exact_value_one_triggers_the_panic() {
        assert!(panic_value_is_trigger(Some("1")));
        for value in [None, Some(""), Some("0"), Some("true"), Some(" 1")] {
            assert!(!panic_value_is_trigger(value), "value {value:?}");
        }
    }

    #[test]
    fn paste_drops_controls_and_keeps_text() {
        assert!(is_pastable('a'));
        assert!(is_pastable('🚀'));
        assert!(!is_pastable('\n'));
        assert!(!is_pastable('\t'));
        assert!(!is_pastable('\u{001B}'));
        assert!(!is_pastable('\u{007F}'));
        assert!(!is_pastable('\u{2028}'));
    }

    #[test]
    fn a_read_only_list_paste_hits_the_shared_gate() {
        let mut app = App::new(
            "todo.txt",
            Vec::new(),
            TodoDate::new(2026, 11, 17).expect("valid date"),
        );
        let now = Instant::now();
        let text = (1..=11)
            .map(|index| format!("pasted {index}"))
            .collect::<Vec<_>>()
            .join("\n");

        paste_into_focused(&mut app, &text, now);
        assert!(app.todos().is_empty(), "a read-only paste adds nothing");
        assert!(!app.modals().is_open(), "no confirmation may open");
        assert_eq!(
            app.toast_message(now),
            Some(thar_tui::input::READ_ONLY_MESSAGE)
        );
        assert!(!app.is_dirty());
    }

    #[test]
    fn list_paste_delegates_splitting_and_validation_to_the_app() {
        let mut app = App::new(
            "todo.txt",
            Vec::new(),
            TodoDate::new(2026, 11, 17).expect("valid date"),
        );
        app.set_read_only(false);
        let now = Instant::now();

        paste_into_focused(&mut app, "  one  \n\n\ttwo\t\n", now);
        let texts: Vec<&str> = app.todos().iter().map(|todo| todo.text.as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
        assert!(app.is_dirty());

        // Control-character validation belongs to the app's core batch check.
        // The list branch must not keep a second, divergent pre-check, and a
        // rejected batch must add nothing.
        paste_into_focused(&mut app, "safe\na\u{001B}b", now);
        assert_eq!(app.todos().len(), 2);
    }
}
