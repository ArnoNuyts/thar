//! `thar-rs` entry point.
use std::ffi::OsString;
use std::process::ExitCode;

fn main() -> ExitCode {
    // `args_os` keeps non-UTF-8 file names intact; `args` would panic on them.
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    thar_cli::run(&arguments)
}
