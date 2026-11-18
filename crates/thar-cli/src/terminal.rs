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
    Event, MouseButton, MouseEventKind,
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

    /// Run the event loop until the app quits, saving through `store` when it
    /// is present.
    ///
    /// `baseline` is the exact bytes the caller loaded and parsed; the watcher
    /// compares the first poll against it.
    ///
    /// # Errors
    ///
    /// Propagates draw, event-read, and size failures.
    pub fn run(
        &mut self,
        app: &mut App,
        mut store: Option<&mut SaveGuard>,
        baseline: Vec<u8>,
    ) -> io::Result<()> {
        // Write mode has one source of truth: the presence of the store. The
        // caller opens a store exactly when `--write` is active.
        app.set_read_only(store.is_none());

        // The reload path must use the same limits as the initial load, so an
        // environment override cannot make a reload accept a file the startup
        // read would reject (or the reverse). `run` already turned an invalid
        // override into exit code 2; the default is only a library-caller
        // fallback.
        let limits = get_read_limits().unwrap_or_default();
        let mut sync = FileSync::new(app.filename(), limits, baseline);
        let mut last_click: Option<LastClick> = None;

        loop {
            let size = self.terminal.size()?;
            app.resize(size.width, size.height);

            let now = Instant::now();
            app.expire_toast(now);
            if app.save_due(now)
                && let Some(store) = store.as_deref_mut()
            {
                flush_save(app, store, &mut sync, now);
            }
            self.terminal.draw(|frame| view::render(frame, app))?;

            if app.should_quit() {
                // The Ink app can lose a save queued <50 ms before `q`; CP7
                // flushes it, because losing the last keystroke of an edit is
                // exactly the data-safety failure this checkpoint exists to
                // prevent.
                if app.is_dirty()
                    && let Some(store) = store.as_deref_mut()
                {
                    flush_save(app, store, &mut sync, now);
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
            let event_now = if event::poll(timeout)? {
                let event = event::read()?;
                // Timestamp the event after the read: `poll` may have waited
                // most of the timeout, and an early stamp would misjudge
                // double clicks, the save debounce and toast expiry. The
                // earlier `now` stays the frame clock for draw and timers.
                let event_now = Instant::now();
                handle_event(app, event, event_now, &mut last_click)?;
                event_now
            } else {
                now
            };

            // Apply the effects queued by this event before the reload: an
            // effect was gated by the app state when the key was handled, and
            // a reload first could flip the session into read-only recovery
            // between the queue and the host step (for example, archiving to
            // `done.txt` after the file became unreadable).
            process_effects(app, event_now);

            // After every event or timeout: reload an externally edited file.
            // A reload that lands while a save is pending drops the in-memory
            // edit (the external file wins) because `App::reloaded` clears the
            // pending save, which is the Ink hook's `onLoad` behaviour.
            apply_reload(app, &mut sync, &limits, Instant::now());

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
/// `store` is the write path; `None` is read-only. `baseline` is the exact
/// bytes the caller loaded, used as the watcher's first comparison target.
///
/// # Errors
///
/// Propagates terminal setup and draw errors.
pub fn run_tui(app: &mut App, store: Option<&mut SaveGuard>, baseline: Vec<u8>) -> io::Result<()> {
    let mut session = TerminalSession::start()?;
    session.run(app, store, baseline)
}

/// Write the dirty list now and record the outcome on the app.
///
/// The watcher's accepted bytes are the one save baseline: the guard compares
/// the target against them, and the bytes it returns become the new baseline.
/// A successful save also records the self-write window, so the save's own
/// metadata change does not schedule a reload. A failed save (including
/// [`thar_store::StoreError::ChangedOnDisk`]) keeps the target untouched, shows
/// one bounded message, keeps the list dirty and retries after the app's
/// backoff. The watcher normally reloads the external file first, which clears
/// the dirty state and rebaselines the watcher; a quit before that happens
/// exits non-zero rather than reporting a false save.
fn flush_save(app: &mut App, store: &mut SaveGuard, sync: &mut FileSync, now: Instant) {
    match store.save(app.todos().iter(), sync.baseline()) {
        Ok(bytes) => {
            // The window starts after the rename, not before the serialization,
            // so a slow filesystem cannot shorten it.
            sync.note_write(Instant::now());
            sync.adopt(bytes);
            app.mark_saved();
        }
        Err(error) => app.mark_save_failed(now, error.to_string()),
    }
}

/// Apply one watcher outcome: reload the list, or enter read-only recovery.
///
/// On success the parsed bytes become the watcher baseline in one step, so the
/// bytes that were parsed are exactly the bytes a later save compares against.
fn apply_reload(app: &mut App, sync: &mut FileSync, limits: &ReadLimits, now: Instant) {
    let outcome = match sync.poll(now) {
        Some(outcome) => outcome,
        None => return,
    };

    match outcome {
        ReloadOutcome::Changed(bytes) => match parse_bytes(&bytes, limits) {
            Ok(todos) => {
                sync.adopt(bytes);
                app.reloaded(todos);
                app.push_toast(RELOADED_MESSAGE);
            }
            Err(error) => app.reload_failed(bounded_message(&error.to_string())),
        },
        ReloadOutcome::Unchanged => {
            // The file was rewritten with the bytes this session already
            // accepts. After a failed reload that is the recovery signal, but
            // the in-memory list may hold unsaved edits made while writes were
            // blocked: re-parse the accepted bytes instead of marking those
            // edits as saved.
            if app.load_error().is_some() {
                match parse_bytes(sync.baseline(), limits) {
                    Ok(todos) => {
                        app.reloaded(todos);
                        app.push_toast(RELOADED_MESSAGE);
                    }
                    Err(error) => app.reload_failed(bounded_message(&error.to_string())),
                }
            }
        }
        ReloadOutcome::Unreadable(message) => app.reload_failed(message),
    }
}

/// Drain the host effects queued by commands.
fn process_effects(app: &mut App, now: Instant) {
    for effect in app.take_effects() {
        match effect {
            Effect::Archive(todos) => archive(app, todos, now),
            Effect::Copy(text) => copy_to_clipboard(app, &text),
            Effect::Paste => paste_from_clipboard(app, now),
        }
    }
}

/// Append the completed todos to `done.txt` and remove them from the list.
///
/// `App` owns the archive gate (write mode and healthy recovery state) and
/// passes the completed todos in the effect; this host half only performs the
/// file append and reports a failure.
fn archive(app: &mut App, todos: Vec<thar_core::Todo>, now: Instant) {
    let ids: Vec<_> = todos.iter().map(|todo| todo.id).collect();
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
    filename
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

/// Apply one crossterm event at `now`.
///
/// On Windows `crossterm` does not report a bracketed paste as
/// [`Event::Paste`], so a paste arrives as individual key presses and would
/// otherwise run the single-key list commands (`q` quits, space toggles, …).
/// A key press is therefore extended with the events already queued: a burst
/// of three or more distinct printable presses is delivered as one paste.
///
/// # Errors
///
/// Propagates event-read failures from draining the queue on Windows.
fn handle_event(
    app: &mut App,
    event: Event,
    now: Instant,
    last_click: &mut Option<LastClick>,
) -> io::Result<()> {
    #[cfg(windows)]
    if matches!(&event, Event::Key(key) if burst::is_burst_key(key)) {
        let mut queued = vec![event];
        queued.extend(burst::drain_queued()?);
        for event in burst::coalesce_burst(&queued) {
            dispatch_event(app, event, now, last_click);
        }
        return Ok(());
    }
    dispatch_event(app, event, now, last_click);
    Ok(())
}

/// Apply one event to the app.
fn dispatch_event(app: &mut App, event: Event, now: Instant, last_click: &mut Option<LastClick>) {
    match event {
        Event::Key(key) => input::handle_key(app, key, now),
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
                *last_click = input::handle_mouse_event(app, input, *last_click, now);
            }
        }
        Event::Resize(width, height) => app.resize(width, height),
        Event::Paste(text) => input::handle_paste(app, &text, now),
        // Focus does not change any read-only state. The next iteration
        // redraws and re-checks the local day.
        Event::FocusGained | Event::FocusLost => {}
    }
}

/// Windows paste-burst detection, compiled in for unit tests on every host.
#[cfg(any(windows, test))]
mod burst {
    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

    /// Windows: the minimum printable presses in one burst that are a paste.
    pub(super) const BURST_PASTE_MIN: usize = 3;

    /// True for a key press that can be part of a Windows paste.
    ///
    /// Enter qualifies only without Ctrl or Alt. A printable character
    /// qualifies unless Ctrl or Alt is held, except that both together is
    /// AltGr and must stay a typed character. Releases, navigation keys and
    /// function keys stay single keys.
    pub(super) fn is_burst_key(key: &KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        match key.code {
            KeyCode::Enter => !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT),
            KeyCode::Char(character) => {
                if character.is_control() {
                    return false;
                }
                if key
                    .modifiers
                    .contains(KeyModifiers::CONTROL | KeyModifiers::ALT)
                {
                    // AltGr is reported as Ctrl+Alt; it types a character, not
                    // a command.
                    true
                } else {
                    !key.modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                }
            }
            _ => false,
        }
    }

    /// Windows: the events that are already queued, without waiting.
    #[cfg(windows)]
    pub(super) fn drain_queued() -> std::io::Result<Vec<Event>> {
        let mut queued = Vec::new();
        while ratatui::crossterm::event::poll(std::time::Duration::ZERO)? {
            queued.push(ratatui::crossterm::event::read()?);
        }
        Ok(queued)
    }

    /// Coalesce a burst of key presses into one paste event.
    ///
    /// A run of at least [`BURST_PASTE_MIN`] presses with a second distinct
    /// [`KeyCode`] becomes `Event::Paste(text)` with `\n` for Enter; shorter
    /// runs, auto-repeat of one key, and every other event pass through
    /// unchanged. Releases are dropped without ending the run, because
    /// crossterm reports one for every key-up on Windows.
    pub(super) fn coalesce_burst(events: &[Event]) -> Vec<Event> {
        let mut coalesced = Vec::with_capacity(events.len());
        let mut run = Vec::new();
        for event in events {
            match event {
                Event::Key(key) if key.kind == KeyEventKind::Release => {}
                Event::Key(key) if is_burst_key(key) => run.push(*key),
                event => {
                    flush_burst(&mut run, &mut coalesced);
                    coalesced.push(event.clone());
                }
            }
        }
        flush_burst(&mut run, &mut coalesced);
        coalesced
    }

    /// Append one run of burst keys, as a paste when it is long enough.
    pub(super) fn flush_burst(run: &mut Vec<KeyEvent>, coalesced: &mut Vec<Event>) {
        // Auto-repeat of one key is not a paste: a real burst types at least
        // two different characters.
        let coalesce =
            run.len() >= BURST_PASTE_MIN && run.iter().skip(1).any(|key| key.code != run[0].code);
        if coalesce {
            let mut text = String::with_capacity(run.len());
            for key in run.drain(..) {
                match key.code {
                    KeyCode::Enter => text.push('\n'),
                    KeyCode::Char(character) => text.push(character),
                    _ => unreachable!("is_burst_key admits only Enter and Char"),
                }
            }
            coalesced.push(Event::Paste(text));
        } else {
            coalesced.extend(run.drain(..).map(Event::Key));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::burst::coalesce_burst;
    use super::{apply_reload, panic_value_is_trigger, today_local, until_next_local_midnight};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
    use thar_core::{ReadLimits, Todo, TodoDate, TodoId};
    use thar_store::{BackupPolicy, SaveGuard, StoreError};
    use thar_tui::{Action, App};

    use crate::file::load_with_limits;
    use crate::sync::{FileSync, POLL_INTERVAL};

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
    fn a_burst_of_three_or_more_presses_is_one_paste() {
        let events = [
            key('q'),
            key('u'),
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            key('x'),
        ];
        assert_eq!(
            coalesce_burst(&events),
            [Event::Paste("qu\nx".to_owned())],
            "a pasted 'qu\\nx' must not run 'q' or Enter as list commands"
        );
    }

    #[test]
    fn a_lone_press_stays_a_key() {
        let events = [key('z')];
        assert_eq!(coalesce_burst(&events), events, "one key is not a paste");
    }

    #[test]
    fn a_short_burst_stays_keys() {
        let events = [key('h'), key('i')];
        assert_eq!(coalesce_burst(&events), events, "two keys are not a paste");
    }

    #[test]
    fn a_burst_ends_at_the_first_non_key_event() {
        let events = [
            key('a'),
            key('b'),
            key('c'),
            Event::Resize(80, 24),
            key('d'),
            key('e'),
            key('f'),
        ];
        assert_eq!(
            coalesce_burst(&events),
            [
                Event::Paste("abc".to_owned()),
                Event::Resize(80, 24),
                Event::Paste("def".to_owned()),
            ]
        );
    }

    #[test]
    fn modified_keys_and_navigation_stay_single_keys() {
        let events = [
            Event::Key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL)),
            key('b'),
            Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)),
            Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::ALT)),
        ];
        assert_eq!(coalesce_burst(&events), events);
    }

    #[test]
    fn releases_do_not_break_a_burst() {
        // crossterm emits a Release for every key-up on Windows; it must be
        // dropped without ending the run.
        let events = [p('a'), r('a'), p('b'), r('b'), p('c'), r('c')];
        assert_eq!(coalesce_burst(&events), [Event::Paste("abc".to_owned())]);
    }

    #[test]
    fn auto_repeat_is_not_a_paste() {
        // Holding one key produces a run of the same character, not a paste.
        let events = [p('z'), p('z'), p('z')];
        assert_eq!(coalesce_burst(&events), events);
    }

    #[test]
    fn altgr_characters_join_a_burst() {
        let events = [p('a'), altgr('@'), p('b')];
        assert_eq!(coalesce_burst(&events), [Event::Paste("a@b".to_owned())]);
    }

    /// A uniquely named scratch directory, removed on drop.
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| duration.as_nanos());
            let path = std::env::temp_dir().join(format!(
                "thar-rs-terminal-{label}-{}-{nanos}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create scratch dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Advance the clock in poll-sized steps, driving the real `apply_reload`,
    /// until `condition` holds. `apply_reload` owns the `FileSync::poll` call,
    /// so the test observes the resulting app state instead of the outcome.
    fn reload_until(
        app: &mut App,
        sync: &mut FileSync,
        limits: ReadLimits,
        start: Instant,
        condition: impl Fn(&App) -> bool,
    ) -> Instant {
        let mut now = start;
        for _ in 0..64 {
            apply_reload(app, sync, &limits, now);
            if condition(app) {
                return now;
            }
            now += POLL_INTERVAL;
        }
        panic!(
            "apply_reload never reached the expected state; load_error: {:?}",
            app.load_error()
        );
    }

    #[test]
    fn recovery_replaces_unsaved_edits_with_the_restored_bytes() {
        let directory = ScratchDir::new("recovery");
        let path = directory.path().join("todo.txt");
        std::fs::write(&path, b"a\n").expect("seed the file");
        let limits = ReadLimits::DEFAULT;

        let mut app = App::new(
            path.clone(),
            vec![Todo::parse_line("a", TodoId::new(0))],
            "2026-11-15".parse::<TodoDate>().expect("valid date"),
        );
        app.set_read_only(false);
        let mut sync = FileSync::new(
            path.clone(),
            limits,
            std::fs::read(&path).unwrap_or_default(),
        );
        let start = Instant::now();

        // The file disappears: the first successful reload is a failure, so the
        // session enters read-only recovery.
        std::fs::remove_file(&path).expect("delete the file");
        reload_until(&mut app, &mut sync, limits, start, |app| {
            app.load_error().is_some()
        });
        assert!(!app.writable(), "a failed reload blocks writes");

        // A mutation still lands in memory while recovery blocks its save.
        let id = app.todos()[0].id;
        app.apply_action(Action::Toggle { ids: vec![id] }, start);
        assert!(app.todos()[0].is_done(), "the toggle is in memory");
        assert!(!app.is_dirty(), "recovery does not schedule a save");

        // Restoring the accepted bytes is the recovery signal: the reload must
        // replace the list, not report the in-memory toggle as saved.
        std::fs::write(&path, b"a\n").expect("restore the file");
        reload_until(&mut app, &mut sync, limits, start, |app| {
            app.load_error().is_none()
        });

        assert!(!app.is_dirty());
        assert!(app.writable(), "recovery re-enables writes");
        assert_eq!(app.todos().len(), 1);
        assert_eq!(app.todos()[0].text, "a");
        assert!(
            !app.todos()[0].is_done(),
            "the list must match the disk again, not keep the unsaved toggle"
        );
        assert_eq!(std::fs::read(&path).expect("read the file"), b"a\n");
    }

    #[test]
    fn a_change_between_load_and_watcher_construction_is_detected() {
        let directory = ScratchDir::new("startup-race");
        let path = directory.path().join("todo.txt");
        std::fs::write(&path, b"a\n").expect("seed the file");
        let limits = ReadLimits::DEFAULT;

        // The load succeeds, then another program changes the file before the
        // watcher is constructed. The baseline comes from the load, not from a
        // second read, so the save must see the mismatch.
        let loaded = load_with_limits(&path, &limits).expect("load");
        std::fs::write(&path, b"external\n").expect("external edit");
        let sync = FileSync::new(&path, limits, loaded.bytes);
        let mut guard = SaveGuard::new(&path, BackupPolicy::None);
        assert!(matches!(
            guard.save(loaded.todos.iter(), sync.baseline()),
            Err(StoreError::ChangedOnDisk { .. })
        ));
    }

    fn key_event(character: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)
    }

    fn key(character: char) -> Event {
        Event::Key(key_event(character))
    }

    fn p(character: char) -> Event {
        key(character)
    }

    fn r(character: char) -> Event {
        Event::Key(KeyEvent {
            kind: KeyEventKind::Release,
            ..key_event(character)
        })
    }

    fn altgr(character: char) -> Event {
        Event::Key(KeyEvent::new(
            KeyCode::Char(character),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        ))
    }
}
