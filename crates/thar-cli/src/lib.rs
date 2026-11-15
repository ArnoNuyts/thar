//! `thar-cli`: the `thar-rs` read-only TUI binary.
//!
//! CP6 ships a separate binary that opens a todo file read-only. It links no
//! writer: [`load`] reads and parses, [`terminal`] owns the terminal, and the
//! only path that touches the filesystem is a read. A missing file is not
//! created (the Ink app creates it during normal startup; this build must be
//! able to run against an unwritable directory).
//!
//! The CLI surface mirrors `logic/cli.ts` for the flags CP6 supports:
//! `-f/--file`, `-h/--help`, `-v/--version`, `--no-update-check`, and `--`.
//! `update` is recognized and rejected with a bounded message: self-update is
//! a distribution concern (CP8), not a CP6 feature.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod cli;
pub mod file;
pub mod terminal;

use std::process::ExitCode;

pub use cli::{CliError, CliOptions, DEFAULT_FILENAME, format_usage, parse_cli_args};
pub use file::{LoadError, LoadedFile, get_read_limits, load};
pub use terminal::{run_tui, today_local};

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
        eprintln!("thar-rs: self-update is not supported by the read-only build.");
        return ExitCode::from(2);
    }

    let loaded = match load(&options.file) {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            return ExitCode::from(1);
        }
    };

    let today = today_local();
    let mut app = thar_tui::App::new(options.file.clone(), loaded.todos, today);
    app.load_error = loaded.error;

    match run_tui(&mut app) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("thar-rs: {error}");
            ExitCode::from(1)
        }
    }
}
