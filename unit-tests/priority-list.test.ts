import { assertEquals } from "@std/assert";
import {
  getPriorityOptions,
  isPriorityInput,
  PRIORITIES,
  priorityValue,
} from "../logic/priority.ts";

Deno.test("priorities: one ordered A-F list", () => {
  assertEquals([...PRIORITIES], ["A", "B", "C", "D", "E", "F"]);
});

Deno.test("priorities: inline shortcuts accept only the exact A-F letters", () => {
  for (const priority of PRIORITIES) {
    assertEquals(isPriorityInput(priority), true);
  }

  for (const input of ["a", "G", "Z", "1", "", " A"]) {
    assertEquals(isPriorityInput(input), false);
  }
});

Deno.test("priorities: Unset is appended only when a todo has a priority", () => {
  assertEquals(getPriorityOptions(false), [...PRIORITIES]);
  assertEquals(getPriorityOptions(true), [...PRIORITIES, "Unset"]);
});

Deno.test("priorities: Unset maps back to an undefined todo priority", () => {
  assertEquals(priorityValue("A"), "A");
  assertEquals(priorityValue("F"), "F");
  assertEquals(priorityValue("Unset"), undefined);
});
