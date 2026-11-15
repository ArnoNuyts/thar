// Peak-RSS probe used by scripts/port-startup-matrix.mjs and by the
// single-run commands in docs/rust-port/baseline.md §7/§8.
//
// `/usr/bin/time` is not installed in the measurement container, so peak RSS
// is read from process.resourceUsage().maxRSS at exit — the same "Maximum
// resident set size" (KiB) value that /usr/bin/time -v reports. The probe
// itself is one tiny module, so figures are comparable to, not identical with,
// `/usr/bin/time -v`.
//
// Usage: node --import ./scripts/port-rss-probe.mjs <script> [args...]
// Output: `MAXRSS_KB=<n>` on stderr (stdout is left untouched).
process.on("exit", () => {
  process.stderr.write(`MAXRSS_KB=${process.resourceUsage().maxRSS}\n`);
});
