# Committed parity fixtures

Both files are generated **once** from the TypeScript oracle and committed.
The Rust tests read them and never regenerate anything; a behaviour change is a
deliberate, reviewed change to the JSON.

| File                       | Generator                            | Covers                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search-expectations.json` | `../generate-search-expectations.ts` | `String.prototype.toLowerCase` (including `Final_Sigma` with `Case_Ignorable` skipping), per-field todo views, and `extractSearchTerms` (JavaScript `\s`, ASCII-only `\w` stripping).                               |
| `list-expectations.json`   | `../generate-list-expectations.ts`   | The owned row model against `sortByImportance` → `filterHidden` unless `showHidden` → `filterBySearch` → `createIndexes` for every parseable `testdata/port/` fixture, both hidden modes, and the fixed query list. |

## Regenerate

Use the repository's pinned Node (`.nvmrc`, 26.12.0). The list generator pins
the corpus clock to local `2026-11-15T12:00:00`; both record the Node, ICU, and
Unicode versions they ran under.

```sh
PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
  npx vite-node crates/thar-tui/tests/generate-search-expectations.ts
PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
  npx vite-node crates/thar-tui/tests/generate-list-expectations.ts
PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
  npx oxfmt crates/thar-tui/tests/fixtures/*.json
```

Lists above 500 expected entries are stored as `{ "count": n, "sha256": "…" }`
of the newline-joined values, so `testdata/port/large-10000.txt` is pinned
exactly without a multi-megabyte fixture.

The `Cased` and `Case_Ignorable` range tables in `src/search.rs` were generated
from the same Node 26.12 / Unicode 17.0 property data with
`../generate-unicode-tables.mjs`; if the fixture is regenerated on a different
Unicode version, regenerate those tables too.
