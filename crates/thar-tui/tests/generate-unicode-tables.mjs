/**
 * Prints the `Cased` and `Case_Ignorable` range tables used by
 * `crates/thar-tui/src/search.rs`.
 *
 * Run with the repository's pinned Node (26.12, Unicode 17.0) and paste the two
 * constants under their existing doc comments in `src/search.rs`:
 *
 * ```sh
 * PATH="$HOME/.local/share/mise/installs/node/26.12.0/bin:$PATH" \
 *   node crates/thar-tui/tests/generate-unicode-tables.mjs
 * ```
 *
 * This is a maintenance helper, not part of the test suite. The committed
 * tables are the contract; regenerate them only when the oracle's Unicode
 * version changes.
 */

const ranges = (property) => {
  const pattern = new RegExp(`^\\p{${property}}$`, "u");
  const result = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    if (!pattern.test(String.fromCodePoint(codePoint))) continue;
    const last = result[result.length - 1];
    if (last && codePoint === last[1] + 1) last[1] = codePoint;
    else result.push([codePoint, codePoint]);
  }
  return result;
};

const format = (name, values) => {
  const hex = (value) => `0x${value.toString(16).toUpperCase()}`;
  const rows = values.map(([start, end]) => `(${hex(start)}, ${hex(end)})`);
  const lines = [`const ${name}: &[(u32, u32)] = &[`];
  for (let index = 0; index < rows.length; index += 6) {
    lines.push(`    ${rows.slice(index, index + 6).join(", ")},`);
  }
  lines.push("];");
  return lines.join("\n");
};

// oxlint-disable-next-line no-console
console.log(
  `${format("CASED", ranges("Cased"))}\n\n${format(
    "CASE_IGNORABLE",
    ranges("Case_Ignorable"),
  )}`,
);
