//! Poll-based file watching for the event loop.
//!
//! The Ink app watches the todo file through `node:fs.watch`, debounces a
//! reload by 500 ms, ignores events for one second after its own write, and
//! reloads on a content change. `thar-rs` needs the same behaviour without a
//! new dependency and without platform-specific event APIs, so this module
//! polls the file metadata instead:
//!
//! - every [`POLL_INTERVAL`] (250 ms) it compares the modification time and
//!   length against the last observed stamp;
//! - a changed stamp starts a [`RELOAD_DEBOUNCE`] (500 ms) quiet period, which
//!   restarts on the next change so a slow editor writing in several steps
//!   still produces one read;
//! - for [`SELF_WRITE_WINDOW`] (1 s) after [`FileSync::note_write`] a reload is
//!   suppressed, because the change is this session's own save;
//! - when the quiet period ends the bytes are read and compared against the
//!   last accepted content, so a touch (mtime changes, bytes do not) never
//!   reloads.
//!
//! All time enters through [`FileSync::poll`] and [`FileSync::note_write`], so
//! the tests drive the watcher with explicit [`Instant`]s and never sleep.
//!
//! # Policy
//!
//! - The external file wins. A reload replaces the in-memory list and clears
//!   the undo history ([`thar_tui::App::reloaded`]).
//! - A failed read or parse keeps the last good list, cancels a pending save,
//!   and puts the session in the read-only recovery state (`app.load_error`).
//!   The next successful reload clears it and re-enables writes.
//! - A failed reload is not retried on a timer: the metadata must change again
//!   before another read happens, so a rejected file cannot cause a toast loop.
//! - A session that starts without a file stays quiet until the file first
//!   appears: a never-present file is the startup note, not an unreadable
//!   event. Once the watcher has seen the file, deleting it is reported.
//! - The target is never written from here. Deletes and unreadable files are
//!   reported instead of recreated.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use thar_core::ReadLimits;
use thar_tui::App;

use crate::file::{LoadError, LoadedFile, parse_bytes, read_bytes};

/// How often the file metadata is checked, while the loop is idle.
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Quiet period after the last metadata change before the file is read.
///
/// Matches `DEFAULT_RELOAD_DEBOUNCE_MS` in `hooks/useTodoFileSync.ts`.
pub const RELOAD_DEBOUNCE: Duration = Duration::from_millis(500);

/// Window after a save in which a change is treated as this session's write.
///
/// Matches the hook's `Date.now() - lastWriteTimeRef.current < 1000` guard.
pub const SELF_WRITE_WINDOW: Duration = Duration::from_secs(1);

/// Longest message kept from a reload failure (matches `MAX_DISPLAY_ERROR_CHARS`).
pub const MAX_MESSAGE_CHARS: usize = 300;

/// Toast shown after a successful reload, matching the Ink app.
pub const RELOADED_MESSAGE: &str = "File reloaded";

/// The modification stamp the watcher compares between polls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Stamp {
    /// Modification time, if the filesystem reports one.
    modified: Option<SystemTime>,
    /// File length in bytes.
    len: u64,
}

impl Stamp {
    fn of(metadata: &fs::Metadata) -> Self {
        Self {
            modified: metadata.modified().ok(),
            len: metadata.len(),
        }
    }
}

/// What one poll found, if the file changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReloadOutcome {
    /// The on-disk bytes differ from the last accepted content.
    ///
    /// [`FileSync::apply`] decodes and parses them with
    /// [`crate::file::parse_bytes`], then adopts them as the save baseline.
    Changed(Vec<u8>),
    /// The file was rewritten with exactly the accepted bytes.
    ///
    /// A touch is a no-op for a healthy session, but it is the only signal that
    /// a previously failed reload can be cleared when the external fix restores
    /// the original content: the caller re-parses [`FileSync::baseline`].
    Unchanged,
    /// The file exists but could not be read; the message is bounded and
    /// content-free, safe to show in the action bar.
    Unreadable(String),
}

/// A poll-based watcher for one todo file.
///
/// Construct it once per session with the limits the initial load used and the
/// exact bytes the caller loaded ([`FileSync::from_load`] does both). The first
/// poll compares the on-disk content against that caller-supplied baseline:
/// equal bytes are [`ReloadOutcome::Unchanged`] (a no-op for a healthy session),
/// different bytes reload. The watcher does no I/O at construction, so a change
/// between the load and the watcher cannot be mistaken for the session's own
/// state.
#[derive(Debug)]
pub struct FileSync {
    path: PathBuf,
    limits: ReadLimits,
    /// The content the session last accepted (a load, a reload, or a save).
    baseline: Vec<u8>,
    /// The metadata seen at the last poll, or `None` when the file is missing.
    observed: Option<Stamp>,
    /// True until the watcher has seen `path` exist. The initial load already
    /// reported a never-present file, so the first poll must not turn that note
    /// into a read error; a file that disappears after being seen still is one.
    started_missing: bool,
    /// When the next metadata check is due.
    next_poll: Instant,
    /// When a metadata change was first seen, for the reload debounce.
    changed_at: Option<Instant>,
    /// End of the self-write suppression window.
    suppress_until: Option<Instant>,
    /// Number of content reads that ran, for tests and the evidence doc.
    content_reads: u64,
}

impl FileSync {
    /// Start watching `path` with the same limits the initial load used.
    ///
    /// `baseline` is the bytes the caller loaded and parsed, or `None` when the
    /// file was missing. It becomes the first comparison target and the save
    /// baseline. The watcher arms one debounce immediately, so the first poll
    /// re-reads the file once the quiet period ends and reports whether it
    /// still matches `baseline`.
    #[must_use]
    pub fn new(path: impl Into<PathBuf>, limits: ReadLimits, baseline: Option<Vec<u8>>) -> Self {
        // A missing file at load time is the startup state. Deriving it from
        // the baseline instead of a second stat keeps the load and the watcher
        // on one observation.
        let started_missing = baseline.is_none();
        Self {
            path: path.into(),
            limits,
            baseline: baseline.unwrap_or_default(),
            observed: None,
            started_missing,
            next_poll: Instant::now(),
            changed_at: Some(Instant::now()),
            suppress_until: None,
            content_reads: 0,
        }
    }

    /// Build the watcher from a load result.
    ///
    /// This is the one constructor the host uses: it takes the load's limits
    /// and exact bytes (including the missing-file `None`) without a second
    /// read, so the first poll compares against what the session actually
    /// loaded.
    #[must_use]
    pub fn from_load(path: impl Into<PathBuf>, loaded: &LoadedFile) -> Self {
        Self::new(path, loaded.limits, loaded.bytes.clone())
    }

    /// Adopt bytes the caller has just read, parsed, or written.
    ///
    /// After a reload this is the exact content that became the in-memory list;
    /// after a save it is the bytes written. Both make a later identical read a
    /// no-op instead of a spurious reload.
    pub fn adopt(&mut self, bytes: Vec<u8>) {
        self.baseline = bytes;
    }

    /// The content this session last accepted.
    ///
    /// This is the only save baseline: a save passes it to the guard, and a
    /// failed reload recovers by re-parsing it when the file returns to the
    /// same bytes.
    #[must_use]
    pub fn baseline(&self) -> &[u8] {
        &self.baseline
    }

    /// Record a save at `now`.
    ///
    /// Restarts the self-write window and re-reads the metadata, so the save's
    /// own rename is not mistaken for an external change. A change that was
    /// already pending before the save is kept: the content comparison after
    /// the window decides whether it was a real external edit.
    pub fn note_write(&mut self, now: Instant) {
        self.suppress_until = Some(now + SELF_WRITE_WINDOW);
        self.next_poll = now + POLL_INTERVAL;
        self.observed = fs::metadata(&self.path)
            .ok()
            .map(|metadata| Stamp::of(&metadata));
    }

    /// How long the event loop may wait before the next metadata check or
    /// reload deadline.
    ///
    /// Never longer than [`POLL_INTERVAL`]. The caller clamps it to at least
    /// 1 ms so a due deadline wakes the loop instead of spinning it.
    #[must_use]
    pub fn poll_timeout(&self, now: Instant) -> Duration {
        let mut timeout = self.next_poll.saturating_duration_since(now);

        if let Some(changed_at) = self.changed_at {
            let due = match self.suppress_until {
                Some(until) if until > now => until,
                _ => changed_at + RELOAD_DEBOUNCE,
            };
            timeout = timeout.min(due.saturating_duration_since(now));
        }

        timeout.min(POLL_INTERVAL)
    }

    /// Check for a change and, when the debounce has elapsed, read the file.
    ///
    /// Returns `None` while nothing changed, while the debounce is still
    /// running, and while a self-write is being suppressed.
    pub fn poll(&mut self, now: Instant) -> Option<ReloadOutcome> {
        if now >= self.next_poll {
            self.next_poll = now + POLL_INTERVAL;
            self.observe(now);
        }

        let changed_at = self.changed_at?;

        if self.suppress_until.is_some_and(|until| now < until) {
            return None;
        }
        if now < changed_at + RELOAD_DEBOUNCE {
            return None;
        }

        // One read per change. Clearing the deadline first means a failed read
        // is not retried until the metadata changes again: a rejected file must
        // not produce a toast loop.
        self.changed_at = None;
        self.content_reads = self.content_reads.saturating_add(1);

        match read_bytes(&self.path, &self.limits) {
            Ok(bytes) if bytes == self.baseline => Some(ReloadOutcome::Unchanged),
            Ok(bytes) => Some(ReloadOutcome::Changed(bytes)),
            // The process started without a file (the initial load already
            // reported that) and the file has never existed since. Wait for it
            // to appear instead of replacing the startup note with a read
            // error; a file that was seen and then deleted still reports.
            Err(LoadError::Io(error))
                if error.kind() == io::ErrorKind::NotFound && self.started_missing =>
            {
                self.observed = None;
                None
            }
            Err(error) => Some(ReloadOutcome::Unreadable(bounded_message(
                &error.to_string(),
            ))),
        }
    }

    /// Number of content reads that ran, including no-op comparisons.
    ///
    /// Exposed for the data-safety tests: it proves a touched-but-unchanged
    /// file was read and rejected by the byte compare, not merely missed by the
    /// metadata check.
    #[must_use]
    pub fn content_reads(&self) -> u64 {
        self.content_reads
    }

    /// Apply one poll outcome to the app: reload the list, or enter read-only
    /// recovery.
    ///
    /// The bytes are parsed once. On success they become the watcher baseline
    /// in the same step, so the bytes that were parsed are exactly the bytes a
    /// later save compares against. `Unchanged` is a no-op for a healthy
    /// session, but during recovery it means an external fix restored the
    /// accepted bytes: re-parse the baseline so an unsaved in-memory edit is
    /// replaced instead of being marked saved.
    pub fn apply(&mut self, app: &mut App, now: Instant) {
        let Some(outcome) = self.poll(now) else {
            return;
        };

        let bytes = match outcome {
            ReloadOutcome::Changed(bytes) => bytes,
            ReloadOutcome::Unchanged if app.load_error().is_some() => self.baseline.clone(),
            ReloadOutcome::Unchanged => return,
            ReloadOutcome::Unreadable(message) => {
                app.reload_failed(message);
                return;
            }
        };

        let todos = match parse_bytes(&bytes, &self.limits) {
            Ok(todos) => todos,
            Err(error) => {
                app.reload_failed(bounded_message(&error.to_string()));
                return;
            }
        };

        self.adopt(bytes);
        app.reloaded(todos);
        app.push_toast(RELOADED_MESSAGE);
    }

    /// Refresh the observed stamp and arm the debounce when it changed.
    fn observe(&mut self, now: Instant) {
        match fs::metadata(&self.path) {
            Ok(metadata) => {
                // From here on a disappearance is a real deletion, not the
                // startup state.
                self.started_missing = false;
                let stamp = Stamp::of(&metadata);
                if self.observed != Some(stamp) {
                    self.observed = Some(stamp);
                    self.changed_at = Some(now);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if self.observed.is_some() {
                    self.observed = None;
                    self.changed_at = Some(now);
                }
            }
            // A transient metadata failure is retried at the next poll. It is
            // not evidence of a content change, and showing it would toast on
            // every poll.
            Err(_) => {}
        }
    }
}

/// Bound and sanitize a message before it is stored or shown.
///
/// Mirrors `toBoundedDisplayMessage` in `logic/display-safety.ts`: control
/// characters become visible `\uXXXX` escapes, an empty message becomes
/// "Unknown error", and long messages end with `...`.
#[must_use]
pub fn bounded_message(text: &str) -> String {
    let safe = thar_tui::display::sanitize_for_display(text.trim());
    if safe.is_empty() {
        return "Unknown error".to_owned();
    }

    let mut bounded: String = safe.chars().take(MAX_MESSAGE_CHARS).collect();
    if safe.chars().count() > MAX_MESSAGE_CHARS {
        bounded.push_str("...");
    }
    bounded
}
