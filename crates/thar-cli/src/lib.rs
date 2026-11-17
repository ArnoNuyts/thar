//! `thar-cli`: the `thar-rs` TUI binary.
//!
//! The binary opens a todo file read-only by default. CP7 adds `--write`: the
//! write-capable path creates a missing file, keeps one `<file>.bak` before the
//! first save, refuses to overwrite an external edit, and replaces the file
//! atomically through [`thar_store`]. The read-only path links no writer in
//! practice: [`load`] reads and parses, [`terminal`] owns the terminal, and a
//! missing file is not created unless `--write` was passed. [`sync`] polls the
//! file for external edits in both modes and owns the reload and read-only
//! recovery policy (see `docs/rust-port/CP7-SYNC.md`).
//!
//! The CLI surface mirrors `logic/cli.ts` for the flags the port supports:
//! `-f/--file`, `-h/--help`, `-v/--version`, `--write`, `--read-only`,
//! `--no-backup`, `--no-update-check`, and `--`. `update` is recognized and
//! rejected with a bounded message: self-update is a distribution concern
//! (CP8), not a CP7 feature. An invalid `THAR_MAX_*` override is fatal with
//! exit code 2, matching the TypeScript `InvalidLimitError`; it never silently
//! falls back to a default.

pub mod cli;
pub mod clipboard;
pub mod file;
pub mod sync;
pub mod terminal;

use std::ffi::OsString;
use std::process::ExitCode;

pub use cli::{CliCommand, CliError, DEFAULT_FILENAME, format_usage, parse_cli_args};
pub use file::{
    LoadError, LoadedFile, get_read_limits, load, load_with_limits, parse_bytes, read_bytes,
    read_limits_from,
};
pub use sync::{FileSync, ReloadOutcome};
pub use terminal::{run_tui, run_tui_with_store, today_local};

/// Crate version, also printed by `thar-rs --version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Entry point used by `main.rs` and the unit tests.
///
/// Arguments are the OS strings after the program name, so a non-UTF-8 todo
/// file name reaches the loader unchanged.
#[must_use]
pub fn run(args: &[OsString]) -> ExitCode {
    let command = match parse_cli_args(args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            eprintln!();
            eprintln!("{}", format_usage(VERSION));
            return ExitCode::from(2);
        }
    };

    match command {
        CliCommand::Help => {
            println!("{}", format_usage(VERSION));
            ExitCode::SUCCESS
        }
        CliCommand::Version => {
            println!("{VERSION}");
            ExitCode::SUCCESS
        }
        CliCommand::Update => {
            eprintln!("thar-rs: self-update is not supported by this build.");
            ExitCode::from(2)
        }
        CliCommand::Run {
            file,
            write,
            no_backup,
            ..
        } => run_editor(file, write, no_backup),
    }
}

/// Open one todo file in the TUI, honouring the write flags.
fn run_editor(file: std::path::PathBuf, write: bool, no_backup: bool) -> ExitCode {
    // The Ink app creates a missing todo file during startup. Restore that only
    // in write mode; the read-only contract must not create anything.
    if write && let Err(error) = thar_store::ensure_file(&file) {
        eprintln!("thar-rs: cannot create the todo file: {error}");
        return ExitCode::from(1);
    }

    let loaded = match load(&file) {
        Ok(loaded) => loaded,
        Err(error) => {
            // An invalid THAR_MAX_* override is a usage error (the TypeScript
            // InvalidLimitError path); every other load failure is exit 1.
            let code = match error {
                LoadError::InvalidLimit(_) => 2,
                _ => 1,
            };
            eprintln!("thar-rs: {error}");
            return ExitCode::from(code);
        }
    };

    let today = today_local();
    let mut app = thar_tui::App::new(file.clone(), loaded.todos, today);
    app.set_load_error(loaded.error);
    app.set_read_only(!write);

    if app.is_read_only() {
        // The read-only binary still watches the file: an external edit
        // refreshes the view and can only toast, because no writer is linked.
        match run_tui(&mut app) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("thar-rs: {error}");
                ExitCode::from(1)
            }
        }
    } else {
        // Open the save guard whenever `--write` is set, even when `load_error`
        // is already set (a file deleted between the create and the read). The
        // session then writes nothing until the watcher reloads a file that
        // exists again, which is the Ink app's recovery path.
        let policy = if no_backup {
            thar_store::BackupPolicy::None
        } else {
            thar_store::BackupPolicy::Bak
        };
        let mut guard = match thar_store::SaveGuard::open(file.clone(), policy) {
            Ok(guard) => guard,
            Err(error) => {
                eprintln!("thar-rs: {error}");
                return ExitCode::from(1);
            }
        };
        match run_tui_with_store(&mut app, &mut guard) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("thar-rs: {error}");
                ExitCode::from(1)
            }
        }
    }
}
