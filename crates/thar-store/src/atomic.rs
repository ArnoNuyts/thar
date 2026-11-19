//! Atomic whole-file replacement.
//!
//! The writer creates a temporary file in the target directory, writes the
//! complete text, syncs it, and renames it over the target. A rename inside one
//! directory is atomic on POSIX and is the platform replace on Windows, so a
//! crash either leaves the old file or the new file, never a partial one.
//!
//! The temporary file is removed on every error path. Directory `fsync` is
//! deliberately not attempted: it is not portably available, and the write
//! path's gate is "no partial file / no content change on failure", not
//! crash-consistency beyond the rename.
//!
//! A debug-only hook (`THAR_SAVE_CRASH=before-rename`) stops the process
//! between the temp-file flush and the rename so the data-safety suite can
//! prove the target keeps its previous bytes across a crash. Release builds
//! ignore the variable, and the shipped rename path is unchanged.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Default mode for a file this process creates (owner read/write).
#[cfg(unix)]
const NEW_FILE_MODE: u32 = 0o600;
/// Default mode for a file this process creates (Windows ignores it).
#[cfg(not(unix))]
const NEW_FILE_MODE: u32 = 0o644;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `data` to `path` by replacing it atomically.
///
/// The target's existing permission mode is preserved. A missing target is
/// created with an owner-only mode on Unix.
///
/// # Errors
///
/// Returns the first filesystem error. On failure the target is untouched and
/// the temporary file is removed.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let mode = match fs::metadata(path) {
        Ok(metadata) => file_mode(&metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => NEW_FILE_MODE,
        Err(error) => return Err(error),
    };

    let temporary = temporary_path(path);
    let result = write_and_replace(&temporary, path, data, mode);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_and_replace(temporary: &Path, target: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(mode);
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
        }
        let mut file = options.open(temporary)?;
        file.write_all(data)?;
        // Best effort: a filesystem that cannot sync a regular file must not
        // fail a save. The rename below still prevents a partial target.
        let _ = file.sync_all();
    }
    crash_before_rename();
    fs::rename(temporary, target)
}

/// Test-only crash hook: stop the process between the temp-file flush and the
/// rename.
///
/// A data-safety test spawns a child with `THAR_SAVE_CRASH=before-rename` and
/// observes the target: it must still hold the old bytes. The fully written
/// temporary file is left behind because an exiting process cannot clean up; it
/// is never renamed into place, so it is inert and the next save writes a fresh
/// one.
///
/// The child exits with status 9, the same signal-free crash the TypeScript
/// oracle uses (`process.exit(9)`), so no core dump is produced.
///
/// Debug builds only: a release binary must never exit because an environment
/// variable is set. CI runs the data-safety suite in the development profile.
fn crash_before_rename() {
    if !cfg!(debug_assertions) {
        return;
    }
    let requested = std::env::var_os("THAR_SAVE_CRASH")
        .is_some_and(|value| value == std::ffi::OsStr::new("before-rename"));
    if requested {
        std::process::exit(9);
    }
}

fn temporary_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "todo.txt".to_owned());
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = format!(".{name}.{}.{counter}.tmp", std::process::id());
    match target.parent() {
        Some(parent) => parent.join(temporary),
        None => PathBuf::from(temporary),
    }
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o7777
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata) -> u32 {
    NEW_FILE_MODE
}

#[cfg(test)]
mod tests {
    use super::write_atomic;
    use crate::test_support::temp_dir;

    #[test]
    fn replaces_a_file_and_preserves_mode() {
        let directory = temp_dir("atomic-replace");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"old\n").expect("seed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).expect("mode");
        }

        write_atomic(&path, b"new\n").expect("save");
        assert_eq!(std::fs::read(&path).expect("read"), b"new\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o640);
        }
        assert!(
            std::fs::read_dir(&directory)
                .expect("entries")
                .all(|entry| !entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp"))
        );
    }

    #[test]
    fn missing_target_is_created() {
        let directory = temp_dir("atomic-create");
        let path = directory.join("todo.txt");
        write_atomic(&path, b"one\n").expect("save");
        assert_eq!(std::fs::read(&path).expect("read"), b"one\n");
    }
}
