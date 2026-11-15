//! Generates `docs/rust-port/assets/cp6-tui.png` from a real PTY frame.
//!
//! This is a manual asset generator, not a CI test: it is `#[ignore]`d and
//! never runs in the normal suite. It spawns `thar-rs` on a 100x30 PTY with
//! [`FIXTURE`], waits for the first complete frame, and turns the parsed
//! `vt100` screen into an SVG with one coloured text run per style run, then
//! rasterizes that SVG to PNG. The image is what the terminal actually drew;
//! nothing is mocked or re-laid-out.
//!
//! Run it from the repository root:
//!
//! ```sh
//! cargo test -p thar-cli --test pty -- --ignored cp6_screenshot
//! ```
//!
//! Rasterizing needs a SVG renderer. ImageMagick is installed here but its SVG
//! delegate is `rsvg-convert`, which is not; ffmpeg is built with the librsvg
//! decoder, so it does the conversion. Re-run this test after a styling change
//! instead of editing the PNG by hand.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::Session;
use crate::support::TempDir;

/// Fixture for the screenshot: priorities, contexts, projects, an overdue
/// `due:`, a past threshold `t:`, a future `due:` and a completed row.
///
/// The dates are far enough in the past that the overdue set does not change
/// when the generator runs on a later day; the row order stays stable.
const FIXTURE: &str = "\
(A) write port plan @work +thar due:2026-11-01
buy milk @home
read rust book @home +learning t:2026-11-01
x 2026-11-01 ship the release @work +thar
(C) review pull request @work due:2026-11-20
water the plants
call the dentist
";

/// Cell geometry of the generated image.
const CELL_WIDTH: u32 = 10;
const CELL_HEIGHT: u32 = 20;
const FONT_SIZE: u32 = 16;
const BASELINE: u32 = 15;
/// Margin around the terminal frame, so the image reads as a screenshot rather
/// than a crop that starts on the first glyph's ascender.
const MARGIN: u32 = 12;

/// Default terminal colours, used for cells that inherit the terminal theme.
const DEFAULT_FOREGROUND: [u8; 3] = [0xEE, 0xEC, 0xE5];
const DEFAULT_BACKGROUND: [u8; 3] = [0x18, 0x18, 0x18];

#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp6-tui.png"]
fn cp6_screenshot() {
    let directory = TempDir::new("screenshot");
    let todo = directory.write("todo.txt", FIXTURE.as_bytes());
    let mut session = Session::open(&todo);

    // Wait for the last fixture row and the badge: at that point the frame is
    // complete, because ratatui's first draw writes every row in one batch.
    session.wait_text("READ-ONLY");
    session.wait_todo_text("ship the release");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp6-tui.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp6-tui.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);

    println!("wrote {}", png_path.display());

    session.send(b"q");
    let status = session.wait_exit(crate::TIMEOUT);
    assert_eq!(
        status.exit_code(),
        0,
        "the screenshot run must exit cleanly"
    );
}

/// `docs/rust-port/assets/<name>` relative to this crate.
fn asset_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/rust-port/assets")
        .join(name)
}

/// Rasterize one SVG frame with ffmpeg's librsvg decoder.
fn rasterize(svg: &Path, png: &Path) {
    let status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(svg)
        .args(["-frames:v", "1", "-update", "1"])
        .arg(png)
        .status()
        .expect("run ffmpeg (is it installed?)");
    assert!(status.success(), "ffmpeg could not rasterize the SVG frame");
}

/// Turn the parsed screen into a self-contained SVG.
fn svg(screen: &vt100::Screen) -> String {
    let (rows, cols) = screen.size();
    let width = u32::from(cols.get()) * CELL_WIDTH + MARGIN * 2;
    let height = u32::from(rows.get()) * CELL_HEIGHT + MARGIN * 2;

    let mut svg = String::new();
    svg.push_str(&format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" \
         viewBox=\"0 0 {width} {height}\">\n"
    ));
    svg.push_str(&format!(
        "  <rect width=\"100%\" height=\"100%\" fill=\"{}\"/>\n",
        hex(DEFAULT_BACKGROUND)
    ));
    svg.push_str(&format!(
        "  <g font-family=\"DejaVu Sans Mono, Liberation Mono, monospace\" \
         font-size=\"{FONT_SIZE}\">\n"
    ));

    for row in 0..rows.get() {
        let runs = runs(screen, row, cols.get());

        for run in &runs {
            if run.background == DEFAULT_BACKGROUND {
                continue;
            }
            svg.push_str(&format!(
                "    <rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{CELL_HEIGHT}\" fill=\"{}\"/>\n",
                MARGIN + u32::from(run.start) * CELL_WIDTH,
                MARGIN + u32::from(row) * CELL_HEIGHT,
                run.width() * CELL_WIDTH,
                hex(run.background)
            ));
        }

        for run in &runs {
            if run.text.trim().is_empty() {
                continue;
            }
            let mut attributes = format!("fill=\"{}\"", hex(run.foreground));
            if run.bold {
                attributes.push_str(" font-weight=\"bold\"");
            }
            if run.dim {
                attributes.push_str(" fill-opacity=\"0.6\"");
            }
            svg.push_str(&format!(
                "    <text x=\"{}\" y=\"{}\" {attributes} xml:space=\"preserve\">{}</text>\n",
                MARGIN + u32::from(run.start) * CELL_WIDTH,
                MARGIN + u32::from(row) * CELL_HEIGHT + BASELINE,
                escape(&run.text)
            ));
        }
    }

    svg.push_str("  </g>\n</svg>\n");
    svg
}

/// One run of cells that share a foreground, background, bold and dim.
struct Run {
    start: u16,
    text: String,
    foreground: [u8; 3],
    background: [u8; 3],
    bold: bool,
    dim: bool,
}

impl Run {
    /// Width in terminal cells. The fixture is ASCII, so one `char` is one
    /// cell; a wide character would need its continuation cell skipped.
    fn width(&self) -> u32 {
        u32::try_from(self.text.chars().count()).unwrap_or(0)
    }
}

fn runs(screen: &vt100::Screen, row: u16, cols: u16) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();

    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else {
            continue;
        };
        let contents = cell.contents();
        if contents.is_empty() {
            // The continuation cell of a wide character.
            continue;
        }

        let mut foreground = colour(cell.fgcolor(), DEFAULT_FOREGROUND);
        let mut background = colour(cell.bgcolor(), DEFAULT_BACKGROUND);
        if cell.inverse() {
            std::mem::swap(&mut foreground, &mut background);
        }
        let continuation = runs.last_mut().filter(|run| {
            run.foreground == foreground
                && run.background == background
                && run.bold == cell.bold()
                && run.dim == cell.dim()
        });
        match continuation {
            Some(run) => run.text.push_str(contents),
            None => runs.push(Run {
                start: col,
                text: contents.to_owned(),
                foreground,
                background,
                bold: cell.bold(),
                dim: cell.dim(),
            }),
        }
    }

    runs
}

fn colour(color: vt100::Color, fallback: [u8; 3]) -> [u8; 3] {
    match color {
        vt100::Color::Default => fallback,
        vt100::Color::Rgb(r, g, b) => [r, g, b],
        vt100::Color::Idx(index) => ansi256(index),
    }
}

/// The xterm 256-colour palette. The theme emits 24-bit colours, so this is
/// only a safety net for a cell that inherits an indexed colour.
fn ansi256(index: u8) -> [u8; 3] {
    const BASE: [[u8; 3]; 16] = [
        [0x00, 0x00, 0x00],
        [0x80, 0x00, 0x00],
        [0x00, 0x80, 0x00],
        [0x80, 0x80, 0x00],
        [0x00, 0x00, 0x80],
        [0x80, 0x00, 0x80],
        [0x00, 0x80, 0x80],
        [0xC0, 0xC0, 0xC0],
        [0x80, 0x80, 0x80],
        [0xFF, 0x00, 0x00],
        [0x00, 0xFF, 0x00],
        [0xFF, 0xFF, 0x00],
        [0x00, 0x00, 0xFF],
        [0xFF, 0x00, 0xFF],
        [0x00, 0xFF, 0xFF],
        [0xFF, 0xFF, 0xFF],
    ];

    match index {
        0..=15 => BASE[usize::from(index)],
        16..=231 => {
            let value = index - 16;
            let steps = [0x00, 0x5F, 0x87, 0xAF, 0xD7, 0xFF];
            [
                steps[usize::from(value / 36)],
                steps[usize::from((value % 36) / 6)],
                steps[usize::from(value % 6)],
            ]
        }
        _ => {
            let level = 8 + (index - 232) * 10;
            [level, level, level]
        }
    }
}

fn hex(colour: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", colour[0], colour[1], colour[2])
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Regenerate the paste-fix PR asset: a real frame after a bracketed paste.
///
/// ```sh
/// cargo test -p thar-cli --test pty -- --ignored cp6_paste_fix_screenshot
/// ```
#[test]
#[ignore = "manual asset generator: regenerates docs/rust-port/assets/cp6-paste-fix.png"]
fn cp6_paste_fix_screenshot() {
    let directory = TempDir::new("paste-screenshot");
    let todo = directory.write("todo.txt", crate::FIXTURE.as_bytes());
    let mut session = Session::open(&todo);

    session.wait_text("READ-ONLY");
    session.send(b"/");
    session.wait_text(" /   /");
    // The terminal's bracketed-paste sequence, exactly as a real terminal
    // sends it: the query must read "milk", not "klim".
    session.send(b"\x1b[200~milk\x1b[201~");
    session.wait_text("/ milk");
    session.wait_todo_text("buy milk");

    let image = session.with_screen(svg);
    let svg_path = directory.join("cp6-paste-fix.svg");
    std::fs::write(&svg_path, &image).expect("write the SVG frame");

    let png_path = asset_path("cp6-paste-fix.png");
    std::fs::create_dir_all(png_path.parent().expect("the asset has a directory"))
        .expect("create docs/rust-port/assets");
    rasterize(&svg_path, &png_path);
    println!("wrote {}", png_path.display());

    session.send(crate::ENTER);
    session.send(b"q");
    assert_eq!(
        session.wait_exit(crate::TIMEOUT).exit_code(),
        0,
        "the screenshot run must exit cleanly"
    );
}
