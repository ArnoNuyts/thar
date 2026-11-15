//! Terminal lifecycle and the event loop for `thar-rs`.
//!
//! The process owns exactly one terminal session. Raw mode, the alternate
//! screen, mouse capture and bracketed paste are enabled together and restored
//! together: on a normal exit through [`TerminalSession`]'s `Drop`, and on a
//! panic through the installed hook. A panic must never leave the user's
//! terminal in raw mode, which is why the restore path does not depend on
//! unwinding reaching the end of the event loop.
//!
//! The loop is deliberately small: draw, wait for one event (with a timeout for
//! toast expiry and the midnight rollover), apply it, repeat. All state
//! transitions live in `thar-tui`; this module only translates crossterm.

use std::io::{self, Stdout};
use std::panic;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
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

/// Longest wait between date checks when no toast is pending.
const IDLE_POLL: Duration = Duration::from_secs(30);

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

/// Restore everything the TUI may have changed.
fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        LeaveAlternateScreen
    );
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
    pub fn start() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(
            stdout,
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        ) {
            let _ = disable_raw_mode();
            return Err(error);
        }

        let previous = panic::take_hook();
        let shared: PanicHook = Arc::from(previous);
        let hook = Arc::clone(&shared);
        panic::set_hook(Box::new(move |info| {
            restore_terminal();
            // The previous hook prints the message and backtrace; restoring
            // first keeps that output readable on a normal screen.
            hook(info);
        }));

        let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        Ok(Self {
            terminal,
            previous_hook: Some(shared),
        })
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
            self.terminal.draw(|frame| view::render(frame, app))?;

            if app.should_quit {
                return Ok(());
            }

            self.sync_cursor(app)?;

            let now = Instant::now();
            app.expire_toast(now);
            let poll_for = app.toast_timeout(now).unwrap_or(IDLE_POLL).min(IDLE_POLL);

            if event::poll(poll_for)? {
                match event::read()? {
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        if let Some(command) = input::command_for_key(key, app.search_focused) {
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
                    _ => {}
                }
            }

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

/// Bracketed paste into the focused search bar.
///
/// Line breaks and control characters are dropped: the search input is one
/// line, and pasted terminal control data must never reach the query. CP6 has
/// no create/edit modal, so an unfocused paste is ignored.
fn paste_into_search(app: &mut App, text: &str) {
    if !app.search_focused {
        return;
    }
    for ch in text.chars().filter(|ch| !ch.is_control()) {
        input::apply(app, input::Command::SearchInsert(ch));
    }
}

#[cfg(test)]
mod tests {
    use super::today_local;

    #[test]
    fn today_is_a_valid_calendar_date() {
        let date = today_local();
        assert!(date.year() >= 1970);
        assert!((1..=12).contains(&date.month()));
        assert!((1..=31).contains(&date.day()));
    }
}
