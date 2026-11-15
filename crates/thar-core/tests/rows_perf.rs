//! Manual row-building measurement at 50 / 3 000 / 10 000 todos.
//!
//! This is **not** part of the CI suite (`#[ignore]`): the numbers are only
//! meaningful in a release build, and timing assertions in CI are flaky. It is
//! the core-only half of `tools/port/bench-rows.ts`, which measures the same
//! sizes through the stateless WASM boundary. Compare the two to see how much
//! of the CP3b1 per-keystroke cost is the boundary (JSON encode/decode +
//! marshalling) and how much is the domain work:
//!
//! ```sh
//! cargo test --release -p thar-core --test rows_perf -- --ignored --nocapture
//! npx vite-node tools/port/bench-rows.ts     # the same sizes over WASM
//! ```
//!
//! The generated list mirrors the *shape* of `createGeneratedLines` in
//! `tools/port/rows.ts` (mixed-case contexts, priorities, due/threshold/hidden,
//! duplicates); it does not need the same bytes to be a meaningful measurement.

use std::hint::black_box;
use std::time::{Duration, Instant};

use thar_core::{SearchView, Todo, TodoDate, TodoId, build_rows, create_rows, sort_by_importance};

const TODAY: &str = "2026-11-15";

/// Iterations per size; enough for a stable p95 without a long wait.
fn iterations_for(size: usize) -> usize {
    match size {
        0..=50 => 2_000,
        51..=3_000 => 200,
        _ => 40,
    }
}

/// One deterministic pseudo-random line, mirroring the TS generator's shape.
fn generated_lines(count: usize) -> Vec<String> {
    const CONTEXTS: [Option<&str>; 18] = [
        None,
        Some("home"),
        Some("Home"),
        Some("HOME"),
        Some("work"),
        Some("Work"),
        Some("work-2"),
        Some("work_2"),
        Some("work.2"),
        Some("alpha"),
        Some("Zed"),
        Some("9lives"),
        Some("3d"),
        Some("_hidden"),
        Some("-dash"),
        Some(".dot"),
        Some("a1"),
        Some("A1"),
    ];
    const PRIORITIES: [Option<char>; 7] = [
        None,
        Some('A'),
        Some('B'),
        Some('C'),
        Some('D'),
        Some('E'),
        None,
    ];
    const DUE: [Option<&str>; 8] = [
        None,
        None,
        Some("2020-01-01"),
        Some("2026-11-14"),
        Some("2026-11-15"),
        Some("2026-11-16"),
        Some("2999-12-31"),
        Some("2026-02-30"),
    ];
    const THRESHOLDS: [Option<&str>; 5] = [
        None,
        None,
        Some("2026-11-14"),
        Some("2026-11-16"),
        Some("not-a-date"),
    ];
    const PROJECTS: [Option<&str>; 5] = [
        None,
        Some("+project"),
        Some("+Project"),
        Some("+side.project"),
        Some("+a-1"),
    ];

    let mut seed: u64 = 20_261_020;
    let mut next = move || {
        seed = (seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223)) % 4_294_967_296;
        seed as usize
    };

    let mut lines: Vec<String> = Vec::with_capacity(count);
    for index in 0..count {
        if index > 0 && index % 7 == 0 {
            lines.push(lines[index - 1].clone());
            continue;
        }

        let mut pick = |values: usize| next() % values;
        let done = pick(2) == 0;
        let priority = PRIORITIES[pick(PRIORITIES.len())];
        let context = CONTEXTS[pick(CONTEXTS.len())];
        let due = DUE[pick(DUE.len())];
        let threshold = THRESHOLDS[pick(THRESHOLDS.len())];
        let project = PROJECTS[pick(PROJECTS.len())];
        let hidden = pick(4) == 3;

        let mut parts: Vec<String> = Vec::new();
        if done {
            parts.push("x".to_owned());
        }
        if let Some(priority) = priority {
            parts.push(format!("({priority})"));
        }
        parts.push(format!("todo {index}"));
        if let Some(context) = context {
            parts.push(format!("@{context}"));
        }
        if let Some(project) = project {
            parts.push(project.to_owned());
        }
        if let Some(due) = due {
            parts.push(format!("due:{due}"));
        }
        if let Some(threshold) = threshold {
            parts.push(format!("t:{threshold}"));
        }
        if hidden {
            parts.push("h:1".to_owned());
        }
        lines.push(parts.join(" "));
    }
    lines
}

fn percentile(values: &mut [Duration], fraction: f64) -> Duration {
    values.sort_unstable();
    let index = ((values.len() as f64 * fraction).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values[index]
}

fn measure(iterations: usize, mut body: impl FnMut()) -> (Duration, Duration) {
    for _ in 0..5 {
        body();
    }
    let mut durations = Vec::with_capacity(iterations);
    for _ in 0..iterations {
        let started = Instant::now();
        body();
        durations.push(started.elapsed());
    }
    (
        percentile(&mut durations, 0.5),
        percentile(&mut durations, 0.95),
    )
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

#[test]
#[ignore = "manual perf measurement; run with --release --ignored --nocapture"]
fn measure_build_rows_at_50_3k_10k() {
    let today = TodoDate::parse(TODAY).expect("valid today");

    println!("rows_perf: core-only build_rows, clock {TODAY}, release build");
    println!("| todos | work | p50 ms | p95 ms |");
    println!("| ----: | :--- | -----: | -----: |");

    for size in [50usize, 3_000, 10_000] {
        let lines = generated_lines(size);
        let parse_started = Instant::now();
        let todos: Vec<Todo> = lines
            .iter()
            .enumerate()
            .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
            .collect();
        let parse_time = parse_started.elapsed();

        // The host's view build: one `toLowerCase` per field, once per load.
        let views_started = Instant::now();
        let text: Vec<String> = todos.iter().map(|todo| todo.text.to_lowercase()).collect();
        let contexts: Vec<Vec<String>> = todos
            .iter()
            .map(|todo| {
                todo.contexts
                    .iter()
                    .map(|context| context.to_lowercase())
                    .collect()
            })
            .collect();
        let projects: Vec<Vec<String>> = todos
            .iter()
            .map(|todo| {
                todo.projects
                    .iter()
                    .map(|project| project.to_lowercase())
                    .collect()
            })
            .collect();
        let context_refs: Vec<Vec<&str>> = contexts
            .iter()
            .map(|values| values.iter().map(String::as_str).collect())
            .collect();
        let project_refs: Vec<Vec<&str>> = projects
            .iter()
            .map(|values| values.iter().map(String::as_str).collect())
            .collect();
        let views: Vec<SearchView<'_>> = text
            .iter()
            .enumerate()
            .map(|(index, text)| SearchView {
                text,
                contexts: &context_refs[index],
                projects: &project_refs[index],
            })
            .collect();
        let views_time = views_started.elapsed();

        println!(
            "<!-- prepare: {size} todos — parse {:.2} ms, views {:.2} ms -->",
            millis(parse_time),
            millis(views_time)
        );

        for (label, terms) in [
            ("empty", Vec::<&str>::new()),
            ("one-term", vec!["work"]),
            ("multi-term", vec!["alpha", "work"]),
        ] {
            let iterations = iterations_for(size);
            let (p50, p95) = measure(iterations, || {
                let rows =
                    build_rows(&todos, &views, &terms, false, today).expect("views are aligned");
                black_box(rows.len());
            });
            println!(
                "| {size} | {label} | {:.2} | {:.2} |",
                millis(p50),
                millis(p95)
            );
        }
    }

    // Also show the raw stage cost so a regression can be attributed to a
    // stage instead of "build_rows got slower".
    let lines = generated_lines(10_000);
    let todos: Vec<Todo> = lines
        .iter()
        .enumerate()
        .map(|(index, line)| Todo::parse_line(line, TodoId::new(index as u64)))
        .collect();
    let (sort_p50, _) = measure(40, || {
        black_box(sort_by_importance(&todos, today));
    });
    let (rows_p50, _) = measure(40, || {
        black_box(create_rows(todos.iter()));
    });
    println!(
        "<!-- 10000 todos: sort {:.2} ms, create_rows {:.2} ms -->",
        millis(sort_p50),
        millis(rows_p50)
    );
}
