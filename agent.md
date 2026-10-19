# Agent Notes

## Deno test execution

- Default to `deno task test` (`deno test -A --parallel`), which runs test
  modules across workers and roughly halves wall-clock time on Linux (~20s ->
  ~10s on a 4-CPU box).
- On Windows, if parallel runs hit Deno 2.7.5 pipe panics
  (`Unexpected client pipe failure`, invalid handle), fall back to
  `deno task test:serial` (`deno test -A`).
- Prefer a single full-suite run when verifying integrated behavior.
- Focused runs are fine, but still run them one at a time.
- Avoid fixed `setTimeout`/`delay` sleeps in tests. Poll for the condition with
  `waitFor` from `unit-tests/test-utils.ts` instead; it returns as soon as the
  assertion passes.
- The toaster timeout is cleared on unmount, so tests do not need to wait for
  the 2s toast to expire.

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
- Use `deno task test` for the test suite in this repo (`deno task test:serial`
  if parallel is unavailable).
- When debugging behavior that depends on row layout, prefer rerunning the full
  suite after targeted fixes because navigation and mouse tests depend on shared
  index semantics.
