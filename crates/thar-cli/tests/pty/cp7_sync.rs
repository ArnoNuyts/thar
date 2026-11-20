//! CP7 file-sync PTY coverage.
//!
//! The data-safety matrix in `tests/write_safety.rs` drives the watcher and the
//! save guard directly. This module proves the same behaviour through the real
//! binary on a real terminal: an external edit reloads into the running list
//! and toasts "File reloaded", and a read-only directory produces one bounded
//! save failure without touching the file.
//!
//! The screenshot generator is `#[ignore]`d like CP6's; run it with
//! `cargo test -p thar-cli --test pty -- --ignored cp7_sync_screenshot`.

use std::path::Path;
use std::time::Instant;

use crate::screenshot::{asset_path, rasterize, svg};
use crate::support::{TempDir, modified};
use crate::{Session, TIMEOUT};

/// Fixture for the reload tests and the screenshot: contexts, a project, a
/// priority, an overdue `due:` and a completed row.
const FIXTURE: &str = "\
(A) write port plan @work +thar due:2026-11-01
buy milk @home
read rust book @home +learning
(C) review pull request @work due:2026-11-20
water the plants
call the dentist
";

/// The file after an external edit. It changes the length as well as the
/// content, so the metadata stamp differs even on a filesystem with coarse
/// modification times.
const EXTERNAL: &str = "\
(A) write port plan @work +thar due:2026-11-01
buy milk @home
read rust book @home +learning
(C) review pull request @work due:2026-11-20
water the plants
call the dentist
ship the CP7 sync @work +thar
";

/// Wait until the file on disk contains `needle`, without a fixed sleep.
fn wait_for_file(path: &Path, needle: &str) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && text.contains(needle)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{} never contained {needle:?}",
            path.display()
        );
        std::thread::yield_now();
    }
}

#[test]
fn an_external_edit_reloads_and_toasts() {
    let directory = TempDir::new("cp7-sync-reload");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open(&path);

    // The watcher takes its baseline before the first frame is drawn, so an
    // edit made after the wait above is unambiguously external.
    session.wait_todo_text("water the plants");
    std::fs::write(&path, EXTERNAL.as_bytes()).expect("external edit");

    // 250 ms poll + 500 ms debounce, then one frame with the toast and the new
    // row. `wait_*` polls the parsed screen, so this is not a fixed sleep.
    session.wait_text("File reloaded");
    session.wait_todo_text("ship the CP7 sync");

    // The reload replaced the list instead of appending to it.
    let snapshot = session.snapshot();
    assert_eq!(
        snapshot.todos.len(),
        7,
        "unexpected reloaded list:\n{}",
        snapshot.text
    );

    // A reload is consistent with the save guard: quitting writes nothing, so
    // the external bytes are exactly what stays on disk.
    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read(&path).expect("read reloaded file"),
        EXTERNAL.as_bytes()
    );
}

#[test]
fn an_external_edit_replaces_the_list_instead_of_merging() {
    // A regression guard for the external-file-wins rule: the previous rows are
    // gone after the reload, nothing is appended, and quitting writes nothing.
    let directory = TempDir::new("cp7-sync-no-merge");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");
    std::fs::write(&path, b"external\nrows\ntotal\n").expect("external edit");
    session.wait_text("File reloaded");
    session.wait_todo_text("external");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read(&path).expect("read external file"),
        b"external\nrows\ntotal\n"
    );
}

/// True when the mode bits actually prevent writes.
///
/// A root shell (or some container filesystems) ignores a `0555` directory, so
/// the read-only-directory test skips instead of reporting a false failure.
#[cfg(unix)]
fn mode_bits_are_enforced(directory: &Path) -> bool {
    let probe = directory.join(".thar-mode-probe");
    match std::fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            false
        }
        Err(_) => true,
    }
}

#[cfg(unix)]
#[test]
fn a_read_only_directory_shows_a_bounded_save_failure_and_keeps_the_bytes() {
    use std::os::unix::fs::PermissionsExt;

    let directory = TempDir::new("cp7-sync-readonly-dir");
    let locked = directory.join("locked");
    std::fs::create_dir(&locked).expect("create the locked directory");
    let path = locked.join("todo.txt");
    std::fs::write(&path, b"one\ntwo\n").expect("seed the target");
    let before_bytes = std::fs::read(&path).expect("read before");
    let before_mtime = modified(&path);

    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555))
        .expect("make the directory read-only");
    if !mode_bits_are_enforced(&locked) {
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
            .expect("restore the directory mode");
        return;
    }

    // Restore the mode even when an assertion panics: the temp directory's
    // cleanup cannot remove a `0555` directory.
    let result = std::panic::catch_unwind(|| {
        let mut session = Session::open(&path);
        session.wait_todo_text("one");

        // The toggle schedules a save, which cannot create the backup or the
        // temporary sibling inside the read-only directory.
        session.send(b" ");
        session.wait_text("Save failed");

        let snapshot = session.snapshot();
        let bar = snapshot.text.lines().last().unwrap_or_default().to_owned();
        assert!(
            bar.chars().count() <= usize::from(crate::session::COLS),
            "the failure message must stay on one bounded line: {bar:?}"
        );
        assert!(
            !bar.contains("two"),
            "the save failure must not echo todo text: {bar:?}"
        );
        // The in-memory toggle happened; the file did not.
        assert!(
            snapshot.text.contains("[x] one"),
            "the toggle is applied in memory:\n{}",
            snapshot.text
        );

        session.send(b"q");
        let status = session.wait_exit(TIMEOUT);
        // The quit flush still cannot write, so the binary must not report a
        // clean exit: the in-memory edit was never saved.
        assert_ne!(status.exit_code(), 0, "an unsaved quit must exit non-zero");
    });

    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
        .expect("restore the directory mode");
    result.expect("the read-only directory PTY assertions");

    assert_eq!(
        std::fs::read(&path).expect("read after"),
        before_bytes,
        "a failed save must leave the target byte-identical"
    );
    assert_eq!(modified(&path), before_mtime, "the target mtime changed");
    let entries: Vec<String> = std::fs::read_dir(&locked)
        .expect("read the locked directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    assert_eq!(entries, ["todo.txt"], "a failed save created a file");
}

#[test]
fn a_failed_reload_blocks_saving_and_a_fix_recovers() {
    let directory = TempDir::new("cp7-sync-recovery");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");

    // Another program writes a rejected control character. The reload fails:
    // the last good rows stay and the bounded message reaches the action bar.
    std::fs::write(&path, b"POISONED_BY_ANOTHER_PROGRAM\x00\n").expect("poison");
    session.wait_text("Todo file line 1");
    session.wait_todo_text("one");
    session.wait_todo_text("two");

    // A mutation is applied in memory but not written while saving is blocked.
    session.send(b" ");
    session.wait_text("Not saved: reload failed");
    assert_eq!(
        std::fs::read(&path).expect("read poisoned"),
        b"POISONED_BY_ANOTHER_PROGRAM\x00\n"
    );

    // Fixing the file externally recovers the session: the rows are replaced
    // and the error disappears.
    std::fs::write(&path, b"one\ntwo\nrecovered\n").expect("fix");
    session.wait_text("File reloaded");
    session.wait_no_text("Todo file line 1");
    session.wait_todo_text("recovered");

    // Writes resume: the next toggle is persisted. The reload reset the cursor
    // to the first row, so this marks "one" done.
    session.send(b" ");
    wait_for_file(&path, "x ");
    session.wait_text("[x] one");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    let saved = std::fs::read_to_string(&path).expect("read saved file");
    assert!(saved.starts_with("x "), "{saved:?}");
    assert!(saved.contains("recovered"), "{saved:?}");
}

#[test]
fn restoring_the_original_bytes_clears_save_blocked_recovery() {
    let directory = TempDir::new("cp7-sync-recovery-same-bytes");
    let path = directory.write("todo.txt", b"one\ntwo\n");
    let mut session = Session::open(&path);

    session.wait_todo_text("one");

    // Break the file, then restore exactly the bytes the session accepted.
    // The watcher sees a changed stamp but identical content, which must still
    // clear the recovery state even though there is no new list to adopt.
    std::fs::write(&path, b"POISONED\x00\n").expect("poison");
    session.wait_text("Todo file line 1");

    // A mutation made while writes are blocked still changes the list in
    // memory, but it must never be reported as saved: the recovery reload has
    // to replace it with the accepted bytes.
    session.send(b" ");
    session.wait_text("[x] one");
    session.wait_text("Not saved");

    std::fs::write(&path, b"one\ntwo\n").expect("restore the original bytes");
    session.wait_text("File reloaded");
    session.wait_no_text("Todo file line 1");
    session.wait_todo_text("one");
    session.wait_todo_text("two");
    session.wait_no_todo_text("[x] one");

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(status.exit_code(), 0);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read restored file"),
        "one\ntwo\n"
    );
}

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp7-sync.png"]
fn cp7_sync_screenshot() {
    let directory = TempDir::new("cp7-sync-screenshot");
    let path = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open(&path);

    session.wait_todo_text("water the plants");
    std::fs::write(&path, EXTERNAL.as_bytes()).expect("external edit");
    session.wait_text("File reloaded");
    session.wait_todo_text("ship the CP7 sync");
    wait_for_file(&path, "ship the CP7 sync");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp7-sync.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp7-sync.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    session.send(b"q");
    let status = session.wait_exit(TIMEOUT);
    assert_eq!(
        status.exit_code(),
        0,
        "the screenshot run must exit cleanly"
    );
}
