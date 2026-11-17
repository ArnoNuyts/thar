//! The one-write-to-disk safety copy.
//!
//! CP7 keeps a `<file>.bak` next to the todo file before the first write of a
//! session. It is created once with mode `0600` and never overwritten, so a
//! second run cannot replace the original with an already-edited copy. `--no-backup`
//! (or `THAR_BACKUP=none`) disables it.

#[cfg(unix)]
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::StoreError;

/// Suffix of the safety copy.
pub const BACKUP_SUFFIX: &str = ".bak";

/// Whether the session keeps a safety copy.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum BackupPolicy {
    /// Do not create a backup.
    #[default]
    None,
    /// Create `<file>.bak` before the first write.
    Bak,
}

/// Path of the safety copy for `path`.
#[must_use]
pub fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

/// Create the safety copy from `original` if the policy asks for it.
///
/// An existing backup is kept: the first copy is the most valuable one.
/// Empty original bytes (a file that did not exist yet) create no backup.
///
/// # Errors
///
/// Returns a [`StoreError::Io`] only for a backup that was requested and could
/// not be written; an existing backup is not an error.
pub fn create(
    path: &Path,
    original: &[u8],
    policy: BackupPolicy,
) -> Result<Option<PathBuf>, StoreError> {
    if policy == BackupPolicy::None || original.is_empty() {
        return Ok(None);
    }

    let backup = backup_path(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = match options.open(&backup) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => return Err(StoreError::io(&backup, error)),
    };

    file.write_all(original)
        .and_then(|()| file.sync_all())
        .map_err(|error| StoreError::io(&backup, error))?;

    // Verify the mode on Unix even when the process umask is wider.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&backup, fs::Permissions::from_mode(0o600));
    }

    Ok(Some(backup))
}

#[cfg(test)]
mod tests {
    use super::{BACKUP_SUFFIX, BackupPolicy, backup_path, create};
    use crate::test_support::temp_dir;

    #[test]
    fn keeps_the_first_backup() {
        let directory = temp_dir("backup-first");
        let path = directory.join("todo.txt");
        std::fs::write(&path, b"current\n").expect("write");

        let first = create(&path, b"original\n", BackupPolicy::Bak)
            .expect("backup")
            .expect("created");
        let second = create(&path, b"changed\n", BackupPolicy::Bak).expect("backup");
        assert_eq!(second, None);
        assert_eq!(std::fs::read(first).expect("read"), b"original\n");
    }

    #[test]
    fn none_and_empty_original_create_nothing() {
        let directory = temp_dir("backup-none");
        let path = directory.join("todo.txt");
        assert_eq!(
            create(&path, b"x", BackupPolicy::None).expect("backup"),
            None
        );
        assert_eq!(create(&path, b"", BackupPolicy::Bak).expect("backup"), None);
        assert!(!backup_path(&path).with_extension("").exists());
        assert_eq!(
            backup_path(&path)
                .file_name()
                .expect("name")
                .to_string_lossy(),
            format!("todo.txt{BACKUP_SUFFIX}")
        );
    }
}
