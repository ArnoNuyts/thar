import { CONTEXT_TOKEN_REGEX, PROJECT_TOKEN_REGEX } from "../logic/patterns.ts";

/**
 * Extracts tags and contexts from a search query.
 * Returns them formatted as they should appear in a todo.
 */
export function extractTagsAndContextsFromSearch(
  searchQuery: string,
): string {
  const trimmed = searchQuery.trim();
  if (!trimmed) return "";

  const tags: string[] = [];

  // Extract projects (+tag)
  const projectMatches = trimmed.matchAll(PROJECT_TOKEN_REGEX);
  for (const match of projectMatches) {
    tags.push(match[1]);
  }

  // Extract contexts (@context)
  const contextMatches = trimmed.matchAll(CONTEXT_TOKEN_REGEX);
  for (const match of contextMatches) {
    tags.push(match[1]);
  }

  return tags.length > 0 ? " " + tags.join(" ") + " " : "";
}

export function extractSearchTerms(searchQuery: string): string[] {
  return searchQuery
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.replace(/^[^\w@+]+|[^\w.\-_]+$/g, ""))
    .filter(Boolean);
}
