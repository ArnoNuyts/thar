/**
 * Host collation locale checks.
 *
 * The Rust row builder sorts context names with the en-US ICU order
 * (`crates/thar-core/src/query.rs`), while the TypeScript oracle and the app
 * call `String.prototype.localeCompare`, whose order depends on the host
 * default locale. CP3b2b resolves that without changing the Rust sort:
 *
 * - the rows harness refuses to run off en-US, so `LANG=da_DK.UTF-8` is a
 *   readable error instead of genuine-looking diffs;
 * - the adapter falls back to TypeScript when the host resolves elsewhere.
 *
 * See `docs/rust-port/PLAN.md` §13 decision 8.
 */

/** The locale `new Intl.Collator()` resolves to on this host (e.g. `en-US`). */
export const defaultCollatorLocale = (): string =>
  new Intl.Collator().resolvedOptions().locale;

/**
 * True when `locale` collates like the pinned en-US order.
 *
 * `en-US` is the pinned value; `en` and the other English locales share the
 * CLDR root order for the `[A-Za-z0-9_.-]` alphabet the context scanner can
 * produce, and ICU already resolves an unsupported English variant to
 * `en-US`. Anything else (`da-DK`, `de-DE`, `sv-SE`, …) is rejected: its
 * `localeCompare` order can differ from the Rust comparator for the same
 * names.
 */
export const isEnglishCollator = (locale: string): boolean =>
  /^en(?:[-_]|$)/i.test(locale);
