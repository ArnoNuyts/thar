import { UpperCaseLetter } from "../types/types.ts";

/**
 * The priorities the app understands, in shortcut/display order.
 *
 * The inline A-F shortcuts in the todo list and the priority modal both read
 * this list so they cannot drift apart.
 */
export const PRIORITIES = ["A", "B", "C", "D", "E", "F"] as const;

export type Priority = typeof PRIORITIES[number];

/** Modal-only label for clearing a todo's priority. */
export const UNSET_PRIORITY = "Unset" as const;

export type PriorityOption = Priority | typeof UNSET_PRIORITY;

/** Inline shortcuts are case-sensitive: lowercase letters keep their own bindings. */
export const isPriorityInput = (input: string): input is Priority =>
  (PRIORITIES as readonly string[]).includes(input);

/** "Unset" is only offered when the reference todo actually has a priority. */
export const getPriorityOptions = (hasPriority: boolean): PriorityOption[] =>
  hasPriority ? [...PRIORITIES, UNSET_PRIORITY] : [...PRIORITIES];

/** Convert a modal option back to the value stored on a Todo. */
export const priorityValue = (
  option: PriorityOption,
): UpperCaseLetter | undefined =>
  option === UNSET_PRIORITY ? undefined : option;
