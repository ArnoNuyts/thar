//! `thar-store`: the write half of the Thar port.
//!
//! CP6 shipped a read-only binary; CP7 adds `--write`. Every filesystem API
//! that can modify user data lives here so the TUI crates stay free of I/O and
//! the CP6 read-only source scan keeps its meaning.
//!
//! The pieces are deliberately small:
//!
//! - [`atomic`] replaces a file through a temporary sibling and a rename;
//! - [`backup`] keeps one `<file>.bak` before the first save of a session;
//! - [`save`] serializes a todo list, refuses an external edit, and writes;
//! - [`done`] appends completed todos to `done.txt`;
//! - [`clipboard`] shells out to the platform clipboard commands;
//! - [`error`] is the bounded error type shown in the action bar.
//!
//! There is no watcher here yet: reloads and debouncing are host behaviour and
//! arrive with the file-sync workstream.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod atomic;
pub mod backup;
pub mod clipboard;
pub mod done;
pub mod error;
pub mod save;

pub use atomic::write_atomic;
pub use backup::{BACKUP_SUFFIX, BackupPolicy, backup_path};
pub use done::append_done;
pub use error::StoreError;
pub use save::{SaveGuard, Saved, ensure_file};

/// Temp-directory helpers for the crate's tests.
#[cfg(test)]
mod test_support {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh unique directory under the system temp directory.
    pub fn temp_dir(label: &str) -> PathBuf {
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "thar-store-{label}-{}-{counter}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        path
    }
}
