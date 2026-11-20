//! A real pseudo-terminal for the `thar-rs` integration tests.
//!
//! The parent test support module builds files and runs plain processes; this
//! module owns the PTY half: a portable-pty pair, a reader thread that feeds
//! every byte into a `vt100` parser, and screen snapshots. A test sends the
//! exact bytes a terminal would send and then polls the *parsed screen* until
//! the expected frame appears, so no test sleeps for a fixed time and none
//! asserts on a partially written frame.
//!
//! The reader thread is the only blocking code: tests write to the master,
//! wait for the app to repaint, and read the same cell grid a user would see.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::num::NonZeroU16;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};
use vt100::Parser;

use crate::support::CONFIG_ENV;

/// Terminal width the PTY is opened with.
pub const COLS: u16 = 100;
/// Terminal height the PTY is opened with.
pub const ROWS: u16 = 30;
/// Upper bound for one screen wait or one process wait.
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// How long a wait sleeps between two parses. The wait returns as soon as the
/// predicate holds, so this only bounds the detection latency.
const POLL_INTERVAL: Duration = Duration::from_millis(5);
/// The renderer always draws the action bar in the last two rows (see
/// `thar_tui::layout::ACTION_BAR_HEIGHT`); screen scanning stops above them.
const ACTION_BAR_ROWS: u16 = 2;

/// Everything the reader thread owns: the parsed screen and the raw bytes.
struct Output {
    parser: Parser,
    raw: Vec<u8>,
}

/// One todo row as it appears on the parsed screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TodoRow {
    /// The row text with trailing padding removed.
    pub text: String,
    /// True when the row is painted with a background other than the list
    /// background, i.e. it is the cursor row or part of a shift selection.
    pub highlighted: bool,
}

/// An immutable view of the screen at one moment.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    /// The whole screen, rows joined with `\n`.
    pub text: String,
    /// Every screen row built from the parsed cells, without trimming interior
    /// or trailing spaces. Indexed by 0-based row in [`Snapshot::row`].
    pub rows: Vec<String>,
    /// Todo rows in screen order. Context headers, the search bar and the
    /// action bar are excluded.
    pub todos: Vec<TodoRow>,
}

impl Snapshot {
    /// One whole screen row, including trailing spaces.
    ///
    /// A row outside the screen is the empty string.
    #[must_use]
    pub fn row(&self, row: u16) -> &str {
        self.rows.get(usize::from(row)).map_or("", String::as_str)
    }

    /// The first highlighted todo row. With no shift range there is exactly
    /// one: the cursor.
    #[must_use]
    pub fn focused(&self) -> Option<&TodoRow> {
        self.todos.iter().find(|todo| todo.highlighted)
    }

    /// Text of the first highlighted todo row.
    #[must_use]
    pub fn focused_text(&self) -> Option<&str> {
        self.focused().map(|todo| todo.text.as_str())
    }

    /// Every highlighted todo row, in screen order.
    #[must_use]
    pub fn highlighted(&self) -> Vec<&TodoRow> {
        self.todos.iter().filter(|todo| todo.highlighted).collect()
    }
}

/// A `thar-rs` process attached to a PTY of [`COLS`]x[`ROWS`].
pub struct Session {
    /// Kept alive so the PTY is not closed while the child runs.
    _master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    output: Arc<Mutex<Output>>,
    reader: Option<JoinHandle<()>>,
}

impl Session {
    /// Run `thar-rs --file <file>` with `TERM=xterm-256color`.
    pub fn open(file: &Path) -> Self {
        Self::open_with(file, &[])
    }

    /// Run `thar-rs --file <file>` with extra environment overrides.
    ///
    /// The overrides win over the inherited environment; the variables in
    /// [`CONFIG_ENV`] are always removed first so a developer's shell cannot
    /// change what a test exercises.
    pub fn open_with(file: &Path, environment: &[(&str, &str)]) -> Self {
        let directory = file.parent().unwrap_or_else(|| Path::new("."));
        let args = [OsStr::new("--file"), file.as_os_str()];
        Self::spawn(directory, &args, environment)
    }

    /// Run `thar-rs --file <file>` at an explicit terminal size.
    pub fn open_sized(file: &Path, cols: u16, rows: u16) -> Self {
        let directory = file.parent().unwrap_or_else(|| Path::new("."));
        let args = [OsStr::new("--file"), file.as_os_str()];
        Self::spawn_sized(directory, &args, &[], cols, rows)
    }

    /// Run `thar-rs` with no arguments in `directory` (the default
    /// `./todo.txt` path).
    pub fn start(directory: &Path, environment: &[(&str, &str)]) -> Self {
        Self::spawn(directory, &[], environment)
    }

    fn spawn(directory: &Path, args: &[&OsStr], environment: &[(&str, &str)]) -> Self {
        Self::spawn_sized(directory, args, environment, COLS, ROWS)
    }

    fn spawn_sized(
        directory: &Path,
        args: &[&OsStr],
        environment: &[(&str, &str)],
        cols: u16,
        rows: u16,
    ) -> Self {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open a PTY pair");

        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_thar-rs"));
        for name in CONFIG_ENV {
            command.env_remove(name);
        }
        // Keep a failing child's output short and deterministic: a backtrace
        // is dozens of lines and would scroll the panic message off the
        // parsed screen before a test can assert it.
        command.env_remove("RUST_BACKTRACE");
        command.env_remove("RUST_LIB_BACKTRACE");
        command.env("TERM", "xterm-256color");
        for (name, value) in environment {
            command.env(name, value);
        }
        command.cwd(directory);
        for arg in args {
            command.arg(arg);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn thar-rs on the PTY");
        // Close the slave in this process: it is what makes the master's read
        // return EOF when the child exits.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone the reader");
        let writer = pair.master.take_writer().expect("take the writer");
        let rows = NonZeroU16::new(rows).expect("rows is non-zero");
        let cols = NonZeroU16::new(cols).expect("cols is non-zero");
        let output = Arc::new(Mutex::new(Output {
            parser: Parser::new(rows, cols, 0),
            raw: Vec::new(),
        }));

        let sink = Arc::clone(&output);
        let reader_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 8 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let mut output = session_lock(&sink);
                        output.parser.process(&buffer[..count]);
                        output.raw.extend_from_slice(&buffer[..count]);
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
        });

        Self {
            _master: pair.master,
            writer,
            child,
            output,
            reader: Some(reader_thread),
        }
    }

    /// Write bytes to the terminal input, exactly as a terminal would.
    pub fn send(&mut self, bytes: &[u8]) {
        self.writer.write_all(bytes).expect("write to the PTY");
        self.writer.flush().expect("flush the PTY");
    }

    /// Parse the current screen once.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        let output = session_lock(&self.output);
        snapshot_of(output.parser.screen())
    }

    /// Run `read` against the live parsed screen.
    ///
    /// Used by the screenshot generator, which needs the per-cell colours the
    /// textual snapshot drops.
    pub fn with_screen<T>(&self, read: impl FnOnce(&vt100::Screen) -> T) -> T {
        let output = session_lock(&self.output);
        read(output.parser.screen())
    }

    /// Poll the live parsed screen until `predicate` holds, then return.
    ///
    /// Used instead of [`Session::wait_until`] when a wait needs per-cell
    /// styles, which a [`Snapshot`] drops.
    ///
    /// # Panics
    ///
    /// Panics with the last screen after [`TIMEOUT`], so a failure shows what
    /// the app actually drew instead of just "condition not met".
    pub fn wait_screen(&self, description: &str, predicate: impl Fn(&vt100::Screen) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self.with_screen(&predicate) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {description}; last screen:\n{}",
                self.snapshot().text
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// Poll the screen until `predicate` holds, then return.
    ///
    /// # Panics
    ///
    /// Panics with the last screen after [`TIMEOUT`], so a failure shows what
    /// the app actually drew instead of just "condition not met".
    pub fn wait_until(&self, description: &str, predicate: impl Fn(&Snapshot) -> bool) {
        self.wait_screen(description, |screen| predicate(&snapshot_of(screen)));
    }

    /// Wait until the whole screen contains `needle`.
    pub fn wait_text(&self, needle: &str) {
        self.wait_until(&format!("screen text {needle:?}"), |snapshot| {
            snapshot.text.contains(needle)
        });
    }

    /// Wait until one whole screen row equals `expected` cell for cell.
    pub fn wait_row(&self, row: u16, expected: &str) {
        self.wait_until(&format!("row {row} to be {expected:?}"), |snapshot| {
            snapshot.row(row) == expected
        });
    }

    /// Wait until the cell at `row`/`col` has (or no longer has) reverse video.
    ///
    /// This reads the live parsed screen rather than a [`Snapshot`] because the
    /// text snapshot drops styles.
    pub fn wait_cell_reversed(&self, row: u16, col: u16, reversed: bool) {
        let description = if reversed {
            format!("cell ({row}, {col}) to be reversed")
        } else {
            format!("cell ({row}, {col}) to lose reverse video")
        };
        self.wait_screen(&description, |screen| {
            cell_reversed(screen, row, col) == reversed
        });
    }

    /// Wait until the whole screen no longer contains `needle`.
    pub fn wait_no_text(&self, needle: &str) {
        self.wait_until(&format!("screen text without {needle:?}"), |snapshot| {
            !snapshot.text.contains(needle)
        });
    }

    /// Wait until the cursor row's text contains `needle`.
    pub fn wait_focused(&self, needle: &str) {
        self.wait_until(
            &format!("the cursor row to contain {needle:?}"),
            |snapshot| {
                snapshot
                    .focused_text()
                    .is_some_and(|text| text.contains(needle))
            },
        );
    }

    /// Wait until a rendered todo row contains `needle`.
    pub fn wait_todo_text(&self, needle: &str) {
        self.wait_until(&format!("a todo row containing {needle:?}"), |snapshot| {
            snapshot.todos.iter().any(|todo| todo.text.contains(needle))
        });
    }

    /// Wait until no rendered todo row contains `needle`.
    pub fn wait_no_todo_text(&self, needle: &str) {
        self.wait_until(&format!("no todo row containing {needle:?}"), |snapshot| {
            snapshot
                .todos
                .iter()
                .all(|todo| !todo.text.contains(needle))
        });
    }

    /// Wait until the raw output contains `needle`.
    pub fn wait_raw(&self, needle: &[u8]) {
        let description = String::from_utf8_lossy(needle);
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if self.raw_contains(needle) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for raw output {description:?}"
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// Wait for the child to exit and for the reader to reach EOF.
    ///
    /// # Panics
    ///
    /// Panics if the child or the reader does not finish within `timeout`; a
    /// hanging TUI fails the test instead of hanging the suite.
    pub fn wait_exit(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.join_reader(deadline);
                    return status;
                }
                Ok(None) => {}
                Err(error) => panic!("waiting for thar-rs failed: {error}"),
            }
            assert!(
                Instant::now() < deadline,
                "thar-rs did not exit within {timeout:?}"
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    /// Wait for the reader thread to hit EOF, so `raw` has every byte.
    fn join_reader(&mut self, deadline: Instant) {
        let Some(reader) = self.reader.take() else {
            return;
        };
        while !reader.is_finished() {
            assert!(
                Instant::now() < deadline,
                "the PTY reader did not reach EOF within the timeout"
            );
            thread::sleep(POLL_INTERVAL);
        }
        let _ = reader.join();
    }

    /// Every raw byte the child has written so far.
    #[must_use]
    pub fn raw(&self) -> Vec<u8> {
        session_lock(&self.output).raw.clone()
    }

    /// True when the raw output contains `needle`.
    #[must_use]
    pub fn raw_contains(&self, needle: &[u8]) -> bool {
        if needle.is_empty() {
            return true;
        }
        self.raw()
            .windows(needle.len())
            .any(|window| window == needle)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // A test that panics must not leave a child behind. The reader thread
        // ends at EOF once the child is gone; do not block on it here.
        let _ = self.child.kill();
        if let Some(reader) = self.reader.take()
            && reader.is_finished()
        {
            let _ = reader.join();
        }
    }
}

fn session_lock(output: &Arc<Mutex<Output>>) -> MutexGuard<'_, Output> {
    // A predicate never panics while a lock is held (snapshots copy what they
    // need), so poisoning can only come from a real bug; recover anyway.
    output.lock().unwrap_or_else(PoisonError::into_inner)
}

fn snapshot_of(screen: &vt100::Screen) -> Snapshot {
    let (rows, cols) = screen.size();
    let background = dominant_background(screen);
    let mut todos = Vec::new();
    let mut lines = Vec::with_capacity(usize::from(rows.get()));

    for row in 0..rows.get() {
        let whole = whole_row_text(screen, row, cols.get());
        if row < rows.get().saturating_sub(ACTION_BAR_ROWS) {
            let text = whole.trim_end();
            if is_todo_row(text) {
                let highlighted = screen.cell(row, 0).map(vt100::Cell::bgcolor) != background;
                todos.push(TodoRow {
                    text: text.to_owned(),
                    highlighted,
                });
            }
        }
        lines.push(whole);
    }

    Snapshot {
        text: screen.contents(),
        rows: lines,
        todos,
    }
}

/// True when the cell at 0-based `row`/`col` is painted in reverse video.
fn cell_reversed(screen: &vt100::Screen, row: u16, col: u16) -> bool {
    screen.cell(row, col).is_some_and(|cell| cell.inverse())
}

/// The full row from the parsed cells, retaining every trailing space.
fn whole_row_text(screen: &vt100::Screen, row: u16, cols: u16) -> String {
    let mut text = String::with_capacity(usize::from(cols));
    for col in 0..cols {
        if let Some(cell) = screen.cell(row, col) {
            text.push_str(cell.contents());
        }
    }
    text
}

/// The most common background colour in the list area.
///
/// Comparing against the dominant colour instead of a hard-coded value keeps
/// the "is this row highlighted" question independent of the palette, which
/// the view-parity pass owns. A cursor row and a shift range are a handful of
/// rows; the list background covers the rest of the screen.
fn dominant_background(screen: &vt100::Screen) -> Option<vt100::Color> {
    let (rows, cols) = screen.size();
    let mut counts: Vec<(vt100::Color, usize)> = Vec::new();

    for row in 0..rows.get().saturating_sub(ACTION_BAR_ROWS) {
        for col in 0..cols.get() {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            let background = cell.bgcolor();
            match counts.iter_mut().find(|(color, _)| *color == background) {
                Some((_, count)) => *count += 1,
                None => counts.push((background, 1)),
            }
        }
    }

    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(color, _)| color)
}

/// A rendered todo row starts with the 1-based number and carries a checkbox.
///
/// Context headers (`"  work (3)  "`) and the action bar do not match, so a
/// test can assert "no todo row shows this text" without knowing the layout.
fn is_todo_row(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some((number, rest)) = trimmed.split_once(' ') else {
        return false;
    };
    !number.is_empty()
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && (rest.contains("[ ]") || rest.contains("[x]"))
}
