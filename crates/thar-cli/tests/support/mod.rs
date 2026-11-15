//! Shared helpers for the `thar-cli` integration tests.
//!
//! The read-only guard only scans `src/**`, so tests may create temporary
//! files and directories to prove the loader leaves them untouched.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

/// Environment variables that change loader behaviour or enter the test hook.
pub const CONFIG_ENV: [&str; 4] = [
    "THAR_MAX_FILE_BYTES",
    "THAR_MAX_READ_TODOS",
    "THAR_MAX_LINE_CHARS",
    "THAR_TUI_PANIC",
];

/// A uniquely named temporary directory, removed on drop.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    /// Create a fresh directory under the system temp directory.
    pub fn new(label: &str) -> Self {
        let unique = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "thar-rs-{label}-{}-{unique}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    /// The directory path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Path of an entry inside the directory.
    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }

    /// Write bytes to an entry and return its path.
    pub fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.join(name);
        std::fs::write(&path, bytes).expect("write temp file");
        path
    }

    /// Sorted entry names, for asserting that a run created nothing.
    pub fn entries(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.path)
            .expect("read temp dir")
            .map(|entry| {
                entry
                    .expect("read temp entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Last modification time of a path.
pub fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path)
        .expect("metadata for path")
        .modified()
        .expect("modified time")
}

/// A `thar-rs` command with the test process's configuration removed.
pub fn thar() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_thar-rs"));
    for name in CONFIG_ENV {
        command.env_remove(name);
    }
    command
}

/// Standard output as lossy text.
pub fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// Standard error as lossy text.
pub fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}
