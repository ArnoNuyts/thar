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
//! the nearest toast expiry or local midnight), apply it, repeat. All state
//! transitions live in `thar-tui`; this module only translates crossterm.

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
use thar_core::TodoDate;
use thar_tui::input::{self, LastClick, MouseInput, MouseKind};
use thar_tui::{App, view};

/// Poll timeout used only when the host clock cannot produce a midnight.
const CLOCK_FALLBACK: Duration = Duration::from_secs(60);

/// Never poll for exactly zero: a due timer must wake the loop, not spin it.
const MIN_POLL: Duration = Duration::from_millis(1);

/// Test-only trigger that panics after the session has entered.
///
/// A later PTY test sets this to `1` to prove the panic hook restores the
/// terminal. It is inert unless the value is exactly `1`.
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

/// Poll timeout: the nearest of the toast expiry and the next local midnight.
fn next_poll_timeout(app: &App, now: Instant) -> Duration {
    let midnight = until_next_local_midnight(&jiff::Zoned::now()).unwrap_or(CLOCK_FALLBACK);
    let timeout = app
        .toast_timeout(now)
        .map_or(midnight, |toast| midnight.min(toast));
    timeout.max(MIN_POLL)
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

        if panic_trigger_requested() {
            panic!("{PANIC_ENV}=1: deliberately panicking to test terminal restore");
        }

        Ok(session)
    }

    /// Draw one frame and wait for one event.
    ///
    /// # Errors
    ///
    /// Propagates draw, event-read, and size failures.
    pub fn run(&mut self, app: &mut App) -> io::Result<()> {
        let mut last_click: Option<LastClick> = None;

        loop {
            let size = self.terminal.size()?;
            app.resize(size.width, size.height);

            let now = Instant::now();
            app.expire_toast(now);
            self.terminal.draw(|frame| view::render(frame, app))?;

            if app.should_quit {
                return Ok(());
            }

            self.sync_cursor(app)?;

            let timeout = next_poll_timeout(app, Instant::now());
            if event::poll(timeout)? {
                match event::read()? {
                    Event::Key(key) => {
                        if key.kind != KeyEventKind::Release
                            && let Some(command) = input::command_for_key(key, app.search_focused)
                        {
                            input::apply(app, command);
                        }
                    }
                    Event::Mouse(mouse) => {
                        if let Some(kind) = mouse_kind(mouse.kind) {
                            let (next, command) = input::handle_mouse(
                                app,
                                MouseInput {
                                    kind,
                                    x: mouse.column.saturating_add(1),
                                    y: mouse.row.saturating_add(1),
                                    shift: mouse
                                        .modifiers
                                        .contains(ratatui::crossterm::event::KeyModifiers::SHIFT),
                                },
                                last_click,
                                Instant::now(),
                            );
                            last_click = next;
                            if let Some(command) = command {
                                input::apply(app, command);
                            }
                        }
                    }
                    Event::Resize(width, height) => app.resize(width, height),
                    Event::Paste(text) => paste_into_search(app, &text),
                    // Focus does not change any read-only state. The next
                    // iteration redraws and re-checks the local day.
                    Event::FocusGained | Event::FocusLost => {}
                }
            }

            // A timeout at (or past) midnight lands here and re-derives the
            // local day, rebuilding overdue/threshold verdicts exactly once.
            app.set_today(today_local());
        }
    }

    fn sync_cursor(&mut self, app: &App) -> io::Result<()> {
        if app.search_focused {
            self.terminal.show_cursor()?;
        } else {
            self.terminal.hide_cursor()?;
        }
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        restore_terminal();
        let _ = self.terminal.show_cursor();
        if let Some(previous) = self.previous_hook.take() {
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
    !matches!(
        character,
        '\u{0000}'..='\u{001F}' | '\u{007F}'..='\u{009F}' | '\u{2028}' | '\u{2029}'
    )
}

/// Bracketed paste into the focused search bar.
///
/// CP6 has no create/edit modal, so an unfocused paste is ignored.
fn paste_into_search(app: &mut App, text: &str) {
    if !app.search_focused {
        return;
    }
    for character in text.chars().filter(|character| is_pastable(*character)) {
        input::apply(app, input::Command::SearchInsert(character));
    }
}

#[cfg(test)]
mod tests {
    use super::{is_pastable, panic_value_is_trigger, today_local, until_next_local_midnight};
    use std::time::Duration;

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
}
