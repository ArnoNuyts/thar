import { Runtime } from "./runtime.ts";

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_COLUMNS = 80;

export type TerminalSize = {
  rows?: number;
  columns?: number;
};

const getConsoleSize = (): TerminalSize | undefined => {
  try {
    return Runtime.consoleSize();
  } catch {
    return undefined;
  }
};

export const getTerminalRows = (terminal?: TerminalSize): number => {
  return terminal?.rows ?? getConsoleSize()?.rows ?? DEFAULT_TERMINAL_ROWS;
};

export const getTerminalColumns = (terminal?: TerminalSize): number => {
  return (
    terminal?.columns ?? getConsoleSize()?.columns ?? DEFAULT_TERMINAL_COLUMNS
  );
};

export const getTerminalSize = (
  terminal?: TerminalSize,
  measured?: TerminalSize,
) => ({
  rows: measured?.rows ?? getTerminalRows(terminal),
  columns: measured?.columns ?? getTerminalColumns(terminal),
});
