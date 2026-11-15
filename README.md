# Thar

A keyboard-driven [todo.txt](https://github.com/todotxt/todo.txt) TUI for the
terminal.

![thar demo](https://raw.githubusercontent.com/ArnoNuyts/thar/main/docs/demo.gif)

## Install

```sh
npm install -g @arnoarnoarno/thar
```

Or run it without installing:

```sh
npx @arnoarnoarno/thar
```

Requires Node.js 22.12 or newer.

## Usage

```sh
thar                 # opens ./todo.txt
thar work.txt        # opens work.txt
thar --help
```

The todo file is created if it does not exist. Completed items are archived to
`done.txt` next to it.

| Key       | Action                |
| --------- | --------------------- |
| `↑` / `↓` | Move selection        |
| `Space`   | Complete todo         |
| `n` / `e` | New / edit todo       |
| `/`       | Search                |
| `x`       | Open the command menu |
| `q`       | Quit                  |

Supports projects (`+project`), contexts (`@context`), priorities, due dates,
threshold dates, recurrence, and hidden todos. Run `thar --help` for options
and see the [todo.txt format](https://github.com/todotxt/todo.txt) for tags.

## Rust core

Thar's `todo.txt` domain (parsing, sorting/search/indexing, row building and
serialization) runs on a Rust core compiled to WebAssembly. The WASM is built
from `crates/thar-wasm`, shipped inside the npm package at
`crates/thar-wasm/pkg/`, and used by default.

The write path still serializes with the TypeScript implementation and
byte-compares the Rust result against it before saving: if the two ever
disagree, the TypeScript bytes are written and one diagnostic line says so.
Nothing is lost and the file never contains a mix.

| Variable         | Effect                                                                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THAR_CORE=ts`   | Escape hatch for one release: use the TypeScript core only. Loads no WASM package and behaves exactly like the pre-port app.                                                                                         |
| `THAR_CORE=rust` | Explicit default. Any value other than `ts` selects the Rust core.                                                                                                                                                   |
| `THAR_CORE_WASM` | Development-only: explicit path to another `thar_wasm.js`. Resolved with `path.resolve`, so a relative value is relative to the working directory; unset, only the module-relative `crates/thar-wasm/pkg/` is tried. |
| `THAR_MAX_*`     | Read limits (`THAR_MAX_FILE_BYTES`, `THAR_MAX_READ_TODOS`, `THAR_MAX_LINE_CHARS`). They are passed to the Rust parser, so both implementations judge a file the same way.                                            |

The Rust core is defensive by design. A missing or broken package, an absent
export, a malformed answer, a host collation locale other than `en-US`, or any
disagreement with the TypeScript implementation falls back to the TypeScript
path with **one bounded, content-free `console.debug` line**. Startup never
throws, and an invalid todo file still reports its exact validation error.

The Rust sort implements the `en-US`/ICU ordering that the app has always used.
On a host whose default collator differs, the main list falls back to the
TypeScript ordering for that session so contexts keep their expected order;
writing does not sort, so it is unaffected.

### Rust TUI (`thar-rs`, read-only)

CP6 adds a second, separate binary built from `crates/thar-cli`: a ratatui port
of the list that opens a todo file **read-only**. It is not the `thar` npm
entry point and does not replace the Ink app yet.

```sh
cargo run -p thar-cli --bin thar-rs -- --file todo.txt
# or
cargo build -p thar-cli --release
./target/release/thar-rs --file todo.txt
```

It cannot write: no writer is linked into the binary, a missing todo file is
opened as an empty list instead of being created, and every key that would
modify the list answers with a bounded `Read-only: thar-rs cannot modify
todo.txt` message. Navigation, context headers, search, the hidden-todo view
(`H`), the mouse wheel/click/shift-click/double-click and the action bar work;
editing and the modals are not part of this build.

`--file`, `--help`, `--version` and `--no-update-check` are supported; `update`
is rejected with a bounded message. CI runs the PTY suite
(`cargo test -p thar-cli --test pty`) on Linux and macOS against the real
binary, and only compiles the crate on Windows. See
[`docs/rust-port/PLAN.md`](docs/rust-port/PLAN.md) (CP6) for the evidence and
for what remains before the Rust TUI becomes the default.

### Building from source

```sh
npm ci
npm run build      # TypeScript bundle; works without Rust
npm start          # dev run; works without Rust (falls back to TypeScript)
```

Running from source without a built WASM package is supported: the app logs one
line and uses the TypeScript core. To get the Rust core locally, or to produce
an npm tarball, you need Rust 1.99.1 and `wasm-pack`:

```sh
npm run build:wasm   # wasm-pack build ... --out-dir pkg --locked
npm run build
```

`npm pack` and `npm publish` run `prepack`, which builds the WASM and then the
TypeScript bundle, so both toolchains are required for packaging. The WASM is
kept within a 250 KB raw / 100 KB gzip budget enforced in CI.

See [`docs/rust-port/PLAN.md`](docs/rust-port/PLAN.md) and
[`tools/port/README.md`](tools/port/README.md) for the porting checkpoints and
the offline differential harness (`npm run port:contract*`), which stays in CI
as the TypeScript oracle even though the runtime comparison is gone.

## License

[MIT](LICENSE)
