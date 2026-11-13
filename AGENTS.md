# Agent Notes

## Toolchain

- Node is pinned to `26.12.0` via `.nvmrc`. Run `nvm use` before working.
  On Alpine, nvm's default download is glibc-only; install the unofficial musl
  build into `~/.nvm/versions/node/v26.12.0` if `nvm install` fails.
- Package manager: npm (`npm ci` / `npm install`).
- Runtime/build: Vite 8 (Rolldown + Oxc) with React 19.
- Typecheck: TypeScript 7 (`npm run typecheck`).
- Lint: Oxlint (`npm run lint`).
- Format: Oxfmt (`npm run fmt`, `npm run fmt:check`).
- Tests: Vitest (`npm test`) using native `test`/`expect` imports. Prefer
  `Runtime` from `utils/runtime.ts` or Node built-ins over Deno APIs in tests.

## Test execution

- Prefer a single full-suite run when verifying integrated behavior:
  `npm test`.
- Focused runs are fine, but still run the full suite before opening a PR:
  `npx vitest run unit-tests/foo.test.ts`.
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

- `npm run check` — typecheck, lint, format check.
- `npm test` — full Vitest suite.
- `npm run build` — Vite SSR bundle in `dist/`.
- `npm run build:sea` — Node single executable in `dist/` (current platform).
- When debugging behavior that depends on row layout, prefer rerunning the full
  suite after targeted fixes because navigation and mouse tests depend on shared
  index semantics.
