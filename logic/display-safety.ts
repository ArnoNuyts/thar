const TAB = 0x09;

const isUnsafeDisplayCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x1f) ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029;

/**
 * Make text safe to write to a terminal.
 *
 * Tab is kept because it is useful in todo text; CR, LF, C0/C1 controls, DEL,
 * ESC, U+2028, and U+2029 are rendered as visible `\uXXXX` escapes so they
 * cannot start an ANSI/control sequence. This is defense in depth for strings
 * that bypass the file validator (clipboard, programmatic adds, tag values).
 */
export const sanitizeForDisplay = (text: string): string => {
  let safe = "";
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.charCodeAt(index);
    if (codePoint === TAB) {
      safe += "\t";
    } else if (isUnsafeDisplayCodePoint(codePoint)) {
      safe += `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    } else {
      safe += text[index];
    }
  }
  return safe;
};

export const MAX_DISPLAY_ERROR_CHARS = 300;

/** Bound and sanitize an error message before it reaches a toast or a log. */
export const toBoundedDisplayMessage = (
  error: unknown,
  maxChars = MAX_DISPLAY_ERROR_CHARS,
): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = sanitizeForDisplay(raw).trim();
  if (safe.length === 0) return "Unknown error";

  return safe.length > maxChars ? `${safe.slice(0, maxChars)}...` : safe;
};
