/**
 * One-shot generator for `fixtures/search-expectations.json`.
 *
 * This file is **not** part of the test suite and CI never runs it. It pins the
 * TypeScript oracle's search normalization so the Rust port can be compared
 * against it without regenerating anything at test time. Regenerate only when
 * the fixture itself is deliberately changing:
 *
 * ```sh
 * PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
 *   npx vite-node crates/thar-tui/tests/generate-search-expectations.ts
 * PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
 *   npx oxfmt crates/thar-tui/tests/fixtures/search-expectations.json
 * ```
 *
 * The fixture is a deliberate, reviewed change: `normalize` is
 * `String.prototype.toLowerCase` (including `Final_Sigma`) and `terms` is
 * `extractSearchTerms` from `utils/search-utils.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Todo } from "../../../logic/todo.ts";
import { extractSearchTerms } from "../../../utils/search-utils.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(here, "fixtures/search-expectations.json");

/** One todo's host-normalized search input: `[text, contexts, projects]`. */
type SearchView = [string, string[], string[]];

const searchViewOf = (todo: Todo): SearchView => [
  todo.text.toLowerCase(),
  Array.from(todo.contexts).map((context) => context.toLowerCase()),
  Array.from(todo.projects).map((project) => project.toLowerCase()),
];

const SIGMA = "\u03A3";

/**
 * Case_Ignorable representatives: Mn, Me, Cf, Lm, Sk, Single_Quote,
 * MidLetter, and MidNumLet.
 */
const CASE_IGNORABLE = [
  "\u0301", // combining acute (Mn)
  "\u20DD", // combining enclosing circle (Me)
  "\u00AD", // soft hyphen (Cf)
  "\uFEFF", // zero width no-break space (Cf)
  "\u02B0", // modifier letter small h (Lm)
  "\u02C2", // modifier letter left arrowhead (Sk)
  "'", // apostrophe (Single_Quote)
  "\u2019", // right single quotation mark (Single_Quote)
  ":", // colon (MidLetter)
  "\u05F4", // Hebrew punctuation gershayim (MidLetter)
  ".", // full stop (MidNumLet)
];

const normalizeInputs = new Set<string>([
  // The oracle's committed search cases, plus their reverse directions.
  "a\u03C3.",
  "a\u03B2\u0301\u03C3.",
  "a\u03A3.\u0391",
  "a\u03B2\u0301\u03A3.",
  "a\u03C3.\u0301a",
  "a\u03C2.",
  "MILK",
  "walk dog @home",
  "task @A.b @x",
  "task @a.b @a\u{1F600}b",
  "\u039F\u0394\u039F\u03A3 \u039D\u0395\u0391",
  "buy milk +work",
  // Final_sigma shapes.
  "\u0391\u03A3",
  "\u0391\u03A3.",
  "\u0391\u03A3 \u0391",
  "\u0391\u03A3\u0391",
  "\u03A3",
  "\u0391.\u03A3",
  "\u0391\u03A3'",
  "\u03A3.",
  "\u0391\u03A3\u03A3",
  "\u0391\u03A3\u03A3\u0391",
  "\u03A3\u03A3",
  "\u0391\u03A32",
  "\u0391\u03A3_",
  "\u0391\u03A3!",
  "\u0391\u03A3!\u0391",
  "1\u03A3",
  "\u03A3\u0391",
  "a\u03A3\u0301",
  "a\u03A3\u0301b",
  "a\u0301\u03A3",
  "a\u03A3.\u0301b",
  "a\u03A3.\u0301",
  "\u0391\u03A3\u0301",
  "\u0391\u03A3\u0301\u0391",
  "\u0391\u03A3\u00AD\u0391",
  "\u0391\u03A3'\u0391",
  "\u0391\u03A3\u02B0\u0391",
  // Unconditional mappings, including multi-character expansions.
  "\u00C4\u00D6\u00DC",
  "\u0130",
  "\u1E9E",
  "\u01C5",
  "\u01C4",
  "\u2167",
  "\u{10400}\u{10428}",
  "\u1E9E\u03A3",
  "\u{10400}\u03A3",
]);

for (const ignorable of CASE_IGNORABLE) {
  normalizeInputs.add(`a${SIGMA}${ignorable}`);
  normalizeInputs.add(`a${SIGMA}${ignorable}A`);
  normalizeInputs.add(`a${ignorable}${SIGMA}`);
  normalizeInputs.add(`a${ignorable}${SIGMA}${ignorable}`);
  normalizeInputs.add(`${SIGMA}${ignorable}`);
  normalizeInputs.add(`a${SIGMA}${ignorable}${ignorable}A`);
}

const viewLines = [
  "a\u03A3.\u0391 @\u039F\u0394\u039F\u03A3 +\u03A3",
  "a\u03B2\u0301\u03A3. @a\u0301\u03A3 +B",
  "x \u0130 @\u1E9E +\u01C5",
  "MILK @Home +Work",
  "a\u03A3 A @a\u03A3 +a\u03A3",
  "task @A.b +a-1",
  "\u039F\u0394\u039F\u03A3 \u039D\u0395\u0391 @\u039F\u0394\u039F\u03A3 +\u039F\u0394\u039F\u03A3",
  "\u{10400}\u{10428} @\u{10400} +\u{10428}",
  "\u0130stanbul @\u0130 +\u0130",
  "a\u0301\u03A3\u0301 @x +y",
];

const termQueries = new Set<string>([
  // The fixed list used by the list parity fixture.
  "",
  "   ",
  "work",
  "@work",
  "+project",
  "alpha beta",
  "!!!",
  "MILK",
  "due:",
  "h:1",
  "@",
  "a.b",
  "\u039F\u0394\u039F\u03A3",
  // The oracle's extra search-term pins.
  "/@work +bug/",
  "/@home/",
  "milk,",
  "..abc..",
  "-x-",
  "@@@",
  "+/",
  "a@b+",
  "\u03B1\u03C3",
  "x\u03C3x",
  // Sigma queries and wrapper edges.
  "a\u03A3.\u0391",
  "a\u03B2\u0301\u03A3.",
  "\u0391\u03A3",
  "\u0391\u03A3 \u039D\u0395\u0391",
  "@\u0391\u03A3",
  "+\u03A3",
  "@!!!",
  "-@!",
  "_x_",
  "\u{1F600}x\u{1F600}",
  "\u{1F600}",
  "\u0301a\u0301",
  "a'b",
  "'a'",
  "``a``",
  "a/b",
  "a\\b",
  "a:b",
  "a;b",
  "a,b",
  "a!b",
  "!a!",
  "\u20ACa\u20AC",
  // JavaScript whitespace: NEL is not whitespace; BOM is.
  "alpha\u0085beta",
  "alpha\uFEFFbeta",
  "a\u00A0b",
  "a\u1680b",
  "a\u2000b",
  "a\u200Ab",
  "a\u2028b",
  "a\u2029b",
  "a\u202Fb",
  "a\u205Fb",
  "a\u3000b",
  "a\u000Bb",
  "a\u000Cb",
  "a\u000Db",
  "a\u0009b",
  "a\u0020b",
]);

// Exhaustive two-character queries over the wrapper, whitespace, and sigma
// alphabet, so a stripped/stripped-to-empty edge cannot slip through.
const SMALL_ALPHABET = [
  "a",
  "A",
  SIGMA,
  "0",
  "_",
  "@",
  "+",
  ".",
  "-",
  "!",
  "/",
  " ",
  "\u00A0",
  "\u0085",
  "\uFEFF",
  "\u0301",
];
for (const left of SMALL_ALPHABET) {
  for (const right of SMALL_ALPHABET) {
    termQueries.add(left + right);
  }
}

const document = {
  oracle: {
    source: "TypeScript implementation (logic/todo.ts, utils/search-utils.ts)",
    generatedAt: "2026-11-15",
    node: process.version,
    icu: process.versions.icu ?? "unknown",
    unicode: process.versions.unicode ?? "unknown",
    notes: [
      "Generated once with crates/thar-tui/tests/generate-search-expectations.ts; tests never regenerate it.",
      "normalize entries are String.prototype.toLowerCase(input); the Rust port must apply Final_Sigma with Case_Ignorable skipping.",
      "views entries are [line, text, contexts, projects] after the oracle's per-field toLowerCase.",
      "terms entries are extractSearchTerms(query), including JavaScript's \\s set and ASCII-only \\w stripping.",
      "The two-character query grid exercises wrapper punctuation and whitespace edges.",
    ],
  },
  normalize: [...normalizeInputs].map((input) => ({
    input,
    lower: input.toLowerCase(),
  })),
  views: viewLines.map((line) => {
    const todo = new Todo(line);
    const view = searchViewOf(todo);
    return { line, text: view[0], contexts: view[1], projects: view[2] };
  }),
  terms: [...termQueries].map((query) => ({
    query,
    terms: extractSearchTerms(query),
  })),
};

fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

// oxlint-disable-next-line no-console
console.log(
  `wrote ${outputPath} (${document.normalize.length} normalize, ${document.views.length} views, ${document.terms.length} term cases)`,
);
