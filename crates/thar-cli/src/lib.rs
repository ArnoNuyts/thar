//! `thar-cli`: the `thar-rs` TUI binary.
//!
//! The binary opens a todo file read-only by default. CP7 adds `--write`: the
//! write-capable path creates a missing file, keeps one `<file>.bak` before the
//! first save, refuses to overwrite an external edit, and replaces the file
//! atomically through [`thar_store`]. The read-only path links no writer in
//! practice: [`load`] reads and parses, [`terminal`] owns the terminal, and a
//! missing file is not created unless `--write` was passed.
//!
//! The CLI surface mirrors `logic/cli.ts` for the flags the port supports:
//! `-f/--file`, `-h/--help`, `-v/--version`, `--write`, `--read-only`,
//! `--no-backup`, `--no-update-check`, and `--`. `update` is recognized and
//! rejected with a bounded message: self-update is a distribution concern
//! (CP8), not a CP7 feature. An invalid `THAR_MAX_*` override is fatal with
//! exit code 2, matching the TypeScript `InvalidLimitError`; it never silently
//! falls back to a default.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod cli;
pub mod file;
pub mod terminal;

use std::process::ExitCode;

pub use cli::{CliError, CliOptions, DEFAULT_FILENAME, format_usage, parse_cli_args};
pub use file::{LoadError, LoadedFile, get_read_limits, load, load_with_limits, read_limits_from};
pub use terminal::{run_tui, run_tui_with_store, today_local};

/// Crate version, also printed by `thar-rs --version`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Entry point used by `main.rs` and the unit tests.
#[must_use]
pub fn run(args: &[String]) -> ExitCode {
    let options = match parse_cli_args(args) {
        Ok(options) => options,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            eprintln!();
            eprintln!("{}", format_usage(VERSION));
            return ExitCode::from(2);
        }
    };

    if options.help {
        println!("{}", format_usage(VERSION));
        return ExitCode::SUCCESS;
    }

    if options.version {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }

    if options.update {
        eprintln!("thar-rs: self-update is not supported by this build.");
        return ExitCode::from(2);
    }

    // The Ink app creates a missing todo file during startup. Restore that only
    // in write mode; the read-only contract must not create anything.
    if options.write
        && let Err(error) = thar_store::ensure_file(std::path::Path::new(&options.file))
    {
        eprintln!("thar-rs: cannot create the todo file: {error}");
        return ExitCode::from(1);
    }

    let loaded = match load(&options.file) {
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
    let mut app = thar_tui::App::new(options.file.clone(), loaded.todos, today);
    app.load_error = loaded.error;
    app.read_only = !options.write || app.load_error.is_some();

    if app.read_only {
        match run_tui(&mut app) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("thar-rs: {error}");
                ExitCode::from(1)
            }
        }
    } else {
        let policy = if options.no_backup {
            thar_store::BackupPolicy::None
        } else {
            thar_store::BackupPolicy::Bak
        };
        let mut guard = match thar_store::SaveGuard::open(options.file.clone(), policy) {
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
