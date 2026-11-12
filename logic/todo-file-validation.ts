import {
  type ReadLimits,
  TodoControlCharacterError,
  TodoLineCountLimitError,
  TodoLineLengthLimitError,
} from "./limits.ts";

export type TodoContentLimits = Pick<
  ReadLimits,
  "maxReadTodos" | "maxLineChars"
>;

const isRejectedCodePoint = (codePoint: number): boolean =>
  (codePoint >= 0x00 && codePoint <= 0x08) ||
  (codePoint >= 0x0b && codePoint <= 0x1f) ||
  (codePoint >= 0x7f && codePoint <= 0x9f) ||
  codePoint === 0x2028 ||
  codePoint === 0x2029;

/**
 * Validate and normalize raw todo-file text.
 *
 * The line-count limit is checked with an `indexOf` scan *before* `split`, so
 * a file with hundreds of thousands of lines is rejected without allocating a
 * line array. Each line is then checked for length and rejected control code
 * points. CRLF is accepted by stripping exactly one trailing CR; any remaining
 * CR is rejected. Blank lines are returned as-is; the caller filters them.
 */
export const validateTodoFileContent = (
  data: string,
  limits: TodoContentLimits,
): string[] => {
  let newlineCount = 0;
  let newlineIndex = data.indexOf("\n");
  while (newlineIndex !== -1) {
    newlineCount++;
    newlineIndex = data.indexOf("\n", newlineIndex + 1);
  }

  // A trailing newline terminates the last line rather than starting a new
  // one, so "a\n" has one physical line and "a\nb" has two.
  const lineCount =
    newlineCount +
    (data.length > 0 && data.charCodeAt(data.length - 1) !== 0x0a ? 1 : 0);

  if (lineCount > limits.maxReadTodos) {
    throw new TodoLineCountLimitError(lineCount, limits.maxReadTodos);
  }

  const lines = data.split("\n");
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    // Strip one trailing CR only when the line was terminated by LF. A CR at
    // end-of-file has no matching LF and is therefore a bare CR.
    const isLfTerminated = index < lines.length - 1;
    const line =
      isLfTerminated && rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (line.length > limits.maxLineChars) {
      throw new TodoLineLengthLimitError(
        index + 1,
        line.length,
        limits.maxLineChars,
      );
    }

    for (let offset = 0; offset < line.length; offset++) {
      const codePoint = line.charCodeAt(offset);
      if (codePoint === 0x0d || isRejectedCodePoint(codePoint)) {
        throw new TodoControlCharacterError(index + 1, codePoint);
      }
    }

    normalizedLines.push(line);
  }

  return normalizedLines;
};
