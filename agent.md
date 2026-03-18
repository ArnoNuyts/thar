# Agent Notes

## Deno test execution

- Run Deno tests serially in this Windows environment. Parallel test invocations
  triggered Deno 2.7.5 pipe panics (`Unexpected client pipe failure`, invalid
  handle) before reporting real assertions.
- Prefer a single full-suite run with `deno test -A` when verifying integrated
  behavior.
- Focused runs are fine, but still run them one at a time.

## Index model and the "None" category

- `createIndexes()` is expected to emit a context header for uncategorized todos
  with `contextName: "None"`.
- That `"None"` header is part of the navigation/scroll row model, not just a
  display detail.
- Tests and mouse coordinates must account for the extra header row. For a
  single uncategorized todo, the visible todo row is below the `"None"` header.
- Removing the `"None"` header changes row indexes and breaks navigation,
  scroll-padding, and click tests.

## Verification commands

- Use `deno lint` for lint checks.
- Use `deno check` for type/module checking.
- Use `deno test -A` for the test suite in this repo.
- When debugging behavior that depends on row layout, prefer rerunning the full
  suite after targeted fixes because navigation and mouse tests depend on shared
  index semantics.
