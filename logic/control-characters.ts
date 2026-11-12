/**
 * One control-character policy shared by the read path, the display boundary,
 * and the write-time invariant.
 *
 * The rejected set is C0 controls, DEL, C1 controls, and the two Unicode line
 * separators. Tab, LF, and CR are inside that range but are delimiters rather
 * than payload characters, so every caller makes the decision for them
 * explicitly:
 *
 * - the display boundary keeps tab and escapes LF/CR;
 * - the read path splits on LF, strips one CR immediately before it, and
 *   rejects any remaining CR;
 * - the write path rejects LF and CR inside a serialized todo.
 */

export const TAB_CODE_POINT = 0x09;
export const LF_CODE_POINT = 0x0a;
export const CR_CODE_POINT = 0x0d;

/** True for C0/C1 controls, DEL, U+2028, and U+2029. */
export const isRejectedControlCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x1f) ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029;

/**
 * First code point that may not appear inside one serialized todo line.
 * Tab is allowed because both the reader and the renderer preserve it.
 */
export const findUnsafeTodoTextCodePoint = (
  text: string,
): number | undefined => {
  for (let index = 0; index < text.length; index++) {
    const codePoint = text.charCodeAt(index);
    if (isRejectedControlCodePoint(codePoint) && codePoint !== TAB_CODE_POINT) {
      return codePoint;
    }
  }
  return undefined;
};
