/**
 * Shape of the CP1 differential contract.
 *
 * The contract is the JSONL file described in `tools/port/README.md`. Every
 * record is built in a fixed key order and contains no timestamps, absolute
 * paths, host names or random values, so two runs over the same corpus are
 * byte-identical.
 */

export type TagPair = [string, string | string[]];

export type ContractTodoState = "todo" | "done";

export interface ContractReadLimits {
  maxFileBytes: number;
  maxReadTodos: number;
  maxLineChars: number;
}

export interface ContractTodo {
  text: string;
  state: ContractTodoState;
  priority: string | null;
  completionDate: string | null;
  creationDate: string | null;
  projects: string[];
  contexts: string[];
  tags: TagPair[];
  isDone: boolean;
  isHidden: boolean;
  isVisibleInOverview: boolean;
  isOverdue: boolean;
  toString: string;
  hash: string;
}

/**
 * Rejection details. Optional numeric fields are only present when the
 * production error object carries them, in this fixed order.
 */
export interface ContractError {
  name: string;
  code: string;
  lineNumber?: number;
  length?: number;
  maxLineChars?: number;
  lineCount?: number;
  maxReadTodos?: number;
  actualBytes?: number;
  maxBytes?: number;
  codePoint?: number;
  message: string;
}

export interface ContractTodosRecord {
  fixture: string;
  sha256: string;
  kind: "todos";
  readLimits: ContractReadLimits;
  clockLocal: string;
  todoCount: number;
  serialized: { sha256: string; bytes: number };
  todos: ContractTodo[];
}

export interface ContractErrorRecord {
  fixture: string;
  sha256: string;
  kind: "error";
  readLimits: ContractReadLimits;
  clockLocal: string;
  error: ContractError;
}

export type ContractRecord = ContractTodosRecord | ContractErrorRecord;
