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
//! The loop owns one [`FileSync`]: after every event (or timeout) it applies
//! the watcher, and a debounced external change replaces the list, clears the
//! undo history, refreshes the save baseline and toasts "File reloaded". A
//! failed reload keeps the last good list, cancels a pending save and enters
//! the read-only recovery state; the next successful reload clears it. The
//! policy lives in `crates/thar-cli/src/sync.rs`, mirrored by the file-sync
//! design notes under `docs/rust-port/`.

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
use thar_core::TodoDate;
use thar_store::SaveGuard;
use thar_tui::event::{LastClick, MouseInput, MouseKind};
use thar_tui::input;
use thar_tui::{App, Effect, view};

use crate::clipboard::{copy, paste};
use crate::sync::FileSync;

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
/// The session needs only `YYYY-MM-DD`, so the date is taken from the host's
/// local zone and converted into the strict domain type. The fallback is the
/// epoch only if the local zone reports an out-of-range year, which a correct
/// host clock cannot do.
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
    /// `sync` is the session's watcher, built from the load result so its
    /// baseline and limits are the ones the session actually loaded.
    ///
    /// # Errors
    ///
    /// Propagates draw, event-read, and size failures.
    pub fn run(
        &mut self,
        app: &mut App,
        mut store: Option<&mut SaveGuard>,
        mut sync: FileSync,
    ) -> io::Result<()> {
        // Write mode has one source of truth: the presence of the store. The
        // caller opens a store exactly when `--write` is active.
        app.set_read_only(store.is_none());
        let mut last_click: Option<LastClick> = None;
        // One decoder for the whole session: a press and its key-up can arrive
        // in separate event-loop iterations, and a per-batch decoder would
        // mistake the release for an unmatched Alt+numpad character.
        #[cfg(windows)]
        let mut keys = win::WinKeys::default();

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
                // The Ink app can lose a save queued <50 ms before `q`; this
                // loop flushes it first, because losing the last keystroke of
                // an edit is exactly the data-safety failure the flush exists
                // to prevent.
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
                #[cfg(windows)]
                handle_event(app, event, event_now, &mut last_click, &mut keys)?;
                #[cfg(not(windows))]
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
            sync.apply(app, Instant::now());

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
/// `store` is the write path; `None` is read-only. `sync` is the watcher built
/// from the load result, so its baseline and limits travel with the session.
///
/// # Errors
///
/// Propagates terminal setup and draw errors.
pub fn run_tui(app: &mut App, store: Option<&mut SaveGuard>, sync: FileSync) -> io::Result<()> {
    let mut session = TerminalSession::start()?;
    session.run(app, store, sync)
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

/// Drain the host effects queued by commands.
///
/// The host performs only the I/O (clipboard process, archive append) and hands
/// the outcome back to the app, which owns every toast and the list update.
fn process_effects(app: &mut App, now: Instant) {
    for effect in app.take_effects() {
        match effect {
            Effect::Archive(todos) => archive(app, todos, now),
            Effect::Copy(text) => copy_to_clipboard(app, &text),
            Effect::Paste => paste_from_clipboard(app, now),
        }
    }
}

/// Append the completed todos to `done.txt` and report the outcome.
///
/// `App` owns the archive gate (write mode and healthy recovery state) and
/// passes the completed todos in the effect; this host half only performs the
/// file append and hands the result back for removal and the toast.
fn archive(app: &mut App, todos: Vec<thar_core::Todo>, now: Instant) {
    let ids: Vec<_> = todos.iter().map(|todo| todo.id).collect();
    let done = thar_store::done_path(app.filename());
    let result = thar_store::append_done(&done, &todos).map_err(|error| error.to_string());
    app.archive_finished(&ids, result, now);
}

/// Copy `text` to the clipboard and report the outcome; the app owns the toast.
fn copy_to_clipboard(app: &mut App, text: &str) {
    let count = text.lines().count();
    app.copy_finished(count, copy(text).map_err(|error| error.to_string()));
}

/// Read the clipboard and report the outcome; the app owns the paste policy and
/// the failure toast.
fn paste_from_clipboard(app: &mut App, now: Instant) {
    app.paste_finished(paste().map_err(|error| error.to_string()), now);
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
#[cfg(windows)]
fn handle_event(
    app: &mut App,
    event: Event,
    now: Instant,
    last_click: &mut Option<LastClick>,
    keys: &mut win::WinKeys,
) -> io::Result<()> {
    // Normalize and decode every event before the burst check and before
    // dispatch, so a typed `@` or `€` never reaches the keymap as a command.
    // The decoder owns the session so a press from an earlier iteration is
    // still visible when its key-up arrives.
    let Some(event) = keys.decode(event) else {
        return Ok(());
    };

    if matches!(&event, Event::Key(key) if burst::is_burst_key(key)) {
        let mut queued = vec![event];
        for event in burst::drain_queued()? {
            if let Some(event) = keys.decode(event) {
                queued.push(event);
            }
        }
        for event in burst::coalesce_burst(&queued) {
            dispatch_event(app, event, now, last_click);
        }
        return Ok(());
    }
    dispatch_event(app, event, now, last_click);
    Ok(())
}

/// Apply one event to the app.
///
/// Unix terminals report a bracketed paste as [`Event::Paste`], so there is no
/// key decoding or burst coalescing on this path.
///
/// # Errors
///
/// Currently infallible; the signature matches the Windows host so the event
/// loop has one call site.
#[cfg(not(windows))]
fn handle_event(
    app: &mut App,
    event: Event,
    now: Instant,
    last_click: &mut Option<LastClick>,
) -> io::Result<()> {
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

/// Windows key normalization and decoding, compiled in for unit tests on every
/// host.
#[cfg(any(windows, test))]
mod win {
    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

    /// Clear the Ctrl+Alt that crossterm reports instead of AltGr.
    ///
    /// Windows reports AltGr as `Ctrl+Alt` plus the composed character. The
    /// keymap reads Ctrl or Alt as a command, so the pair is stripped before
    /// dispatch; other modifiers are kept.
    pub(super) fn normalize(mut key: KeyEvent) -> KeyEvent {
        if let KeyCode::Char(character) = key.code
            && !character.is_control()
            && key
                .modifiers
                .contains(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            key.modifiers
                .remove(KeyModifiers::CONTROL | KeyModifiers::ALT);
        }
        key
    }

    /// Apply [`normalize`] to a key event and leave other events untouched.
    pub(super) fn normalize_event(event: Event) -> Event {
        match event {
            Event::Key(key) => Event::Key(normalize(key)),
            other => other,
        }
    }

    /// Session-scoped decoder for Windows key events.
    ///
    /// conhost reports characters that are not on the layout (Alt+numpad) as a
    /// lone `Release` of the composed character, with no matching press. The
    /// decoder records presses so ordinary key-ups are dropped, and promotes
    /// an unmatched non-ASCII release to a press so the character still types.
    /// The non-ASCII limit keeps Shift rollover safe: a release of an ASCII key
    /// whose press fell outside the process stays dropped.
    ///
    /// The state lives for the whole session, not one drained batch: crossterm
    /// can deliver a press in one event-loop iteration and its key-up in the
    /// next, and a batch-scoped decoder would promote that ordinary key-up.
    #[derive(Default)]
    pub(super) struct WinKeys {
        down: Vec<KeyCode>,
    }

    impl WinKeys {
        /// Decode one event; `None` means the event was only a key-up.
        pub(super) fn decode(&mut self, event: Event) -> Option<Event> {
            let event = normalize_event(event);
            let Event::Key(key) = event else {
                return Some(event);
            };

            if key.kind != KeyEventKind::Release {
                if !self.down.contains(&key.code) {
                    self.down.push(key.code);
                }
                return Some(Event::Key(key));
            }

            if let Some(index) = self.down.iter().position(|code| *code == key.code) {
                self.down.remove(index);
                return None;
            }

            if !matches!(key.code, KeyCode::Char(character) if !character.is_ascii()) {
                return None;
            }

            // An Alt+numpad character: turn its lone key-up into the press that
            // types it. The Alt that produced the character must not survive,
            // or the keymap would read it as a command.
            let mut key = key;
            key.kind = KeyEventKind::Press;
            key.modifiers
                .remove(KeyModifiers::CONTROL | KeyModifiers::ALT);
            Some(Event::Key(key))
        }
    }

    /// Normalize and decode a drained batch before paste coalescing.
    ///
    /// Test-only: the session uses one [`WinKeys`] across iterations, while a
    /// test often wants to describe a whole batch as one call.
    #[cfg(test)]
    pub(super) fn decode_batch(events: Vec<Event>) -> Vec<Event> {
        let mut keys = WinKeys::default();
        events
            .into_iter()
            .filter_map(|event| keys.decode(event))
            .collect()
    }
}

/// Windows paste-burst detection, compiled in for unit tests on every host.
#[cfg(any(windows, test))]
mod burst {
    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

    /// Windows: the minimum printable presses in one burst that are a paste.
    const BURST_PASTE_MIN: usize = 3;

    /// True for a key press that can be part of a Windows paste.
    ///
    /// Enter qualifies without Alt, so the `Ctrl+Enter` that a pasted LF
    /// produces on Windows does not split the run. A printable character
    /// qualifies unless either Ctrl or Alt is held; AltGr is normalized at the
    /// host boundary before this runs. Releases, navigation keys and function
    /// keys stay single keys.
    pub(super) fn is_burst_key(key: &KeyEvent) -> bool {
        key.kind != KeyEventKind::Release
            && match key.code {
                KeyCode::Enter => !key.modifiers.intersects(KeyModifiers::ALT),
                KeyCode::Char(character) => {
                    !key.modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                        && !character.is_control()
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
    fn flush_burst(run: &mut Vec<KeyEvent>, coalesced: &mut Vec<Event>) {
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
    use super::win::{WinKeys, decode_batch, normalize};
    use super::{panic_value_is_trigger, today_local, until_next_local_midnight};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
    use thar_core::{ReadLimits, Todo, TodoDate, TodoId};
    use thar_tui::{Action, App};

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
        let events = [key('a'), r('a'), key('b'), r('b'), key('c'), r('c')];
        assert_eq!(coalesce_burst(&events), [Event::Paste("abc".to_owned())]);
    }

    #[test]
    fn auto_repeat_is_not_a_paste() {
        // Holding one key produces a run of the same character, not a paste.
        let events = [key('z'), key('z'), key('z')];
        assert_eq!(coalesce_burst(&events), events);
    }

    #[test]
    fn altgr_characters_join_a_burst() {
        // Normalization happens at the host boundary; the burst only sees the
        // typed character, with no Ctrl+Alt left to read as a command.
        let events = decode_batch(vec![key('a'), altgr('@'), key('b')]);
        assert_eq!(coalesce_burst(&events), [Event::Paste("a@b".to_owned())]);
    }

    #[test]
    fn altgr_is_normalized_to_a_typed_character() {
        let altgr = KeyEvent::new(
            KeyCode::Char('@'),
            KeyModifiers::CONTROL | KeyModifiers::ALT,
        );
        assert_eq!(
            normalize(altgr),
            KeyEvent::new(KeyCode::Char('@'), KeyModifiers::NONE),
            "AltGr must type '@' instead of running a command"
        );

        let ctrl = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            normalize(ctrl),
            ctrl,
            "Ctrl without Alt stays a command shortcut"
        );
    }

    #[test]
    fn an_alt_numpad_release_becomes_a_press() {
        let decoded = decode_batch(vec![key('a'), r('a'), r('“'), key('b'), r('b')]);
        assert_eq!(
            coalesce_burst(&decoded),
            [Event::Paste("a“b".to_owned())],
            "the Alt+numpad '“' must join the paste instead of leaving 'a b'"
        );
    }

    #[test]
    fn a_matched_release_is_dropped_by_the_decoder() {
        let decoded = decode_batch(vec![key('a'), r('a'), key('b'), r('b')]);
        assert_eq!(decoded, [key('a'), key('b')]);
    }

    #[test]
    fn a_release_is_matched_across_event_loop_iterations() {
        // crossterm can deliver a press and its key-up in separate reads. The
        // decoder must remember the press so the ordinary non-ASCII key-up is
        // dropped instead of promoted into a second character.
        let mut keys = WinKeys::default();
        assert_eq!(
            keys.decode(key('é')),
            Some(key('é')),
            "the press is dispatched once"
        );
        assert_eq!(
            keys.decode(r('é')),
            None,
            "the later key-up must not type 'é' again"
        );

        // The same batch still decodes to exactly one press.
        let mut keys = WinKeys::default();
        let decoded: Vec<_> = [key('é'), r('é')]
            .into_iter()
            .filter_map(|event| keys.decode(event))
            .collect();
        assert_eq!(decoded, [key('é')]);
    }

    #[test]
    fn a_lone_alt_numpad_release_decodes_to_a_press() {
        // A single Alt+numpad character can arrive as one lone `Release`, with
        // no press in the same batch. Decoding the initial event promotes it so
        // the character still types.
        assert_eq!(
            decode_batch(vec![r('“')]),
            [Event::Key(KeyEvent::new(
                KeyCode::Char('“'),
                KeyModifiers::NONE
            ))]
        );
        // An ordinary lone key-up has no press of its own and is dropped.
        assert!(decode_batch(vec![r('a')]).is_empty());
    }

    #[test]
    fn ctrl_enter_does_not_split_a_paste() {
        let events = [
            key('a'),
            key('b'),
            Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)),
            key('c'),
        ];
        assert_eq!(
            coalesce_burst(&events),
            [Event::Paste("ab\nc".to_owned())],
            "a pasted LF arrives as Ctrl+Enter on Windows"
        );
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

    /// Advance the clock in poll-sized steps, driving the real
    /// [`FileSync::apply`], until `condition` holds. `apply` owns the
    /// `FileSync::poll` call, so the test observes the resulting app state
    /// instead of the outcome.
    fn reload_until(
        app: &mut App,
        sync: &mut FileSync,
        start: Instant,
        condition: impl Fn(&App) -> bool,
    ) -> Instant {
        let mut now = start;
        for _ in 0..64 {
            sync.apply(app, now);
            if condition(app) {
                return now;
            }
            now += POLL_INTERVAL;
        }
        panic!(
            "FileSync::apply never reached the expected state; load_error: {:?}",
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
        let mut sync = FileSync::new(&path, limits, std::fs::read(&path).ok());
        let start = Instant::now();

        // The file disappears: the first successful reload is a failure, so the
        // session enters read-only recovery.
        std::fs::remove_file(&path).expect("delete the file");
        reload_until(&mut app, &mut sync, start, |app| app.load_error().is_some());
        assert!(!app.writable(), "a failed reload blocks writes");

        // A mutation still lands in memory while recovery blocks its save.
        let id = app.todos()[0].id;
        app.apply_action(Action::Toggle { ids: vec![id] }, start);
        assert!(app.todos()[0].is_done(), "the toggle is in memory");
        assert!(!app.is_dirty(), "recovery does not schedule a save");

        // Restoring the accepted bytes is the recovery signal: the reload must
        // replace the list, not report the in-memory toggle as saved.
        std::fs::write(&path, b"a\n").expect("restore the file");
        reload_until(&mut app, &mut sync, start, |app| app.load_error().is_none());

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

    fn key_event(character: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE)
    }

    fn key(character: char) -> Event {
        Event::Key(key_event(character))
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
