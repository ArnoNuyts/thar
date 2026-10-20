import { expect, test } from "vitest";

import {
  getPriorityOptions,
  isPriorityInput,
  PRIORITIES,
  priorityValue,
} from "../logic/priority.ts";

test("priorities: one ordered A-F list", () => {
  expect([...PRIORITIES]).toEqual(["A", "B", "C", "D", "E", "F"]);
});

test("priorities: inline shortcuts accept only the exact A-F letters", () => {
  for (const priority of PRIORITIES) {
    expect(isPriorityInput(priority)).toEqual(true);
  }

  for (const input of ["a", "G", "Z", "1", "", " A"]) {
    expect(isPriorityInput(input)).toEqual(false);
  }
});

test("priorities: Unset is appended only when a todo has a priority", () => {
  expect(getPriorityOptions(false)).toEqual([...PRIORITIES]);
  expect(getPriorityOptions(true)).toEqual([...PRIORITIES, "Unset"]);
});

test("priorities: Unset maps back to an undefined todo priority", () => {
  expect(priorityValue("A")).toEqual("A");
  expect(priorityValue("F")).toEqual("F");
  expect(priorityValue("Unset")).toEqual(undefined);
});
