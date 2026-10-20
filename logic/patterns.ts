/**
 * Shared patterns for project (+project) and context (@context) tags.
 *
 * `PROJECT_REGEX` / `CONTEXT_REGEX` require the tag to start a word, which is
 * how todos are parsed. `PROJECT_TOKEN_REGEX` / `CONTEXT_TOKEN_REGEX` match tag
 * tokens anywhere and preserve the legacy behaviour used when extracting tags
 * from a search query.
 *
 * The token regexes are global and should only be used with `matchAll` (which
 * clones them) or after resetting `lastIndex`. The non-global `*_PATTERN`
 * copies are safe for repeated `.test()` / `.exec()` calls.
 */

const TAG_NAME_CHARS = String.raw`[\w.\_\-]`;
const TAG_NAME_PATTERN = `${TAG_NAME_CHARS}+`;

const SEARCH_TAG_NAME_CHARS = String.raw`[\w.\\_\-]`;
const SEARCH_TAG_NAME_PATTERN = `${SEARCH_TAG_NAME_CHARS}+`;

export const PROJECT_REGEX = new RegExp(
  `(^|\\s)\\+(?<name>${TAG_NAME_PATTERN})`,
  "g",
);
export const CONTEXT_REGEX = new RegExp(
  `(^|\\s)@(?<name>${TAG_NAME_PATTERN})`,
  "g",
);

export const PROJECT_PATTERN = new RegExp(PROJECT_REGEX.source);
export const CONTEXT_PATTERN = new RegExp(CONTEXT_REGEX.source);

export const PROJECT_TOKEN_REGEX = new RegExp(
  `(\\+${SEARCH_TAG_NAME_PATTERN})`,
  "g",
);
export const CONTEXT_TOKEN_REGEX = new RegExp(
  `(@${SEARCH_TAG_NAME_PATTERN})`,
  "g",
);

const TAG_WORD_START_AT_END = new RegExp(
  `[\\s]([\\+@]${TAG_NAME_CHARS}*)$`,
);
const TAG_WORD_START_AT_BEGINNING = new RegExp(
  `^([\\+@]${TAG_NAME_CHARS}*)$`,
);

export type TagType = "project" | "context";

export interface TagWordStart {
  word: string;
  startIndex: number;
  type: TagType;
  searchTerm: string;
}

export const matchProjects = (text: string): string[] =>
  Array.from(text.matchAll(PROJECT_REGEX), (match) => match.groups!.name);

export const matchContexts = (text: string): string[] =>
  Array.from(text.matchAll(CONTEXT_REGEX), (match) => match.groups!.name);

/**
 * Returns the `+project` or `@context` currently being typed at the end of
 * `leftPart`, or `null` when the cursor is not at a tag word start.
 */
export const matchTagWordStart = (leftPart: string): TagWordStart | null => {
  const match = leftPart.match(TAG_WORD_START_AT_END) ??
    leftPart.match(TAG_WORD_START_AT_BEGINNING);

  if (!match) return null;

  const word = match[1];
  return {
    word,
    startIndex: leftPart.lastIndexOf(word),
    type: word.startsWith("+") ? "project" : "context",
    searchTerm: word.substring(1),
  };
};
