import { assertEquals } from "@std/assert";
import {
  countWrappedLines,
  getHoveredButtonIndex,
} from "../utils/modal-layout.ts";

// Geometry used by the hover tests:
//   terminal 40 columns x 24 rows, modal 40 wide, 6 body rows.
//   modalHeight = 3 (top chrome) + 6 (body) + 2 (bottom chrome) = 11
//   modalLeft = floor((40 - 40) / 2) + 1 = 1
//   modalTop = ceil((24 - 11) / 2) + 1 = 8
//   button row within the body = 2, so buttonY = 8 + 3 + 2 = 13
const baseOptions = {
  rows: 24,
  columns: 40,
  modalWidth: 40,
  bodyRows: 6,
  buttonRowIndex: 2,
  labels: ["Save", "Cancel"] as [string, string],
};

// Modal spans columns 1..40. The left half is 1..20 and the right half is
// 21..40. "« Save »" is 8 cells, centered at columns 7..14.
// "« Cancel »" is 10 cells, centered at columns 26..35.
Deno.test("getHoveredButtonIndex: ignores positions without coordinates", () => {
  assertEquals(getHoveredButtonIndex(undefined, 13, baseOptions), null);
  assertEquals(getHoveredButtonIndex(10, undefined, baseOptions), null);
  assertEquals(getHoveredButtonIndex(undefined, undefined, baseOptions), null);
});

Deno.test("getHoveredButtonIndex: maps each button region", () => {
  assertEquals(getHoveredButtonIndex(10, 13, baseOptions), 0);
  assertEquals(getHoveredButtonIndex(30, 13, baseOptions), 1);
});

Deno.test("getHoveredButtonIndex: maps button edges inclusively", () => {
  assertEquals(getHoveredButtonIndex(7, 13, baseOptions), 0);
  assertEquals(getHoveredButtonIndex(14, 13, baseOptions), 0);
  assertEquals(getHoveredButtonIndex(26, 13, baseOptions), 1);
  assertEquals(getHoveredButtonIndex(35, 13, baseOptions), 1);
});

Deno.test("getHoveredButtonIndex: ignores divider and padding gaps", () => {
  // Between the left label (ends at 14) and the right label (starts at 26).
  assertEquals(getHoveredButtonIndex(15, 13, baseOptions), null);
  assertEquals(getHoveredButtonIndex(20, 13, baseOptions), null);
  assertEquals(getHoveredButtonIndex(25, 13, baseOptions), null);
  // Outside the modal and outside the right label.
  assertEquals(getHoveredButtonIndex(0, 13, baseOptions), null);
  assertEquals(getHoveredButtonIndex(36, 13, baseOptions), null);
});

Deno.test("getHoveredButtonIndex: ignores rows above and below the buttons", () => {
  assertEquals(getHoveredButtonIndex(10, 12, baseOptions), null);
  assertEquals(getHoveredButtonIndex(10, 14, baseOptions), null);
});

Deno.test("countWrappedLines: empty string counts as one line", () => {
  assertEquals(countWrappedLines("", 10), 1);
});

Deno.test("countWrappedLines: single short line", () => {
  assertEquals(countWrappedLines("hello", 10), 1);
});

Deno.test("countWrappedLines: text exactly the width fits on one line", () => {
  assertEquals(countWrappedLines("abcdefghij", 10), 1);
});

Deno.test("countWrappedLines: width + 1 characters wraps once", () => {
  assertEquals(countWrappedLines("abcdefghijk", 10), 2);
});

Deno.test("countWrappedLines: multiple wraps", () => {
  assertEquals(countWrappedLines("abcdefghijklmnopqrstuvw", 10), 3);
});

Deno.test("countWrappedLines: wraps on word boundaries", () => {
  assertEquals(countWrappedLines("hello world foo", 10), 2);
});

Deno.test("countWrappedLines: explicit newlines each start a new line", () => {
  assertEquals(countWrappedLines("a\nb", 10), 2);
  assertEquals(countWrappedLines("a\nb\nc", 10), 3);
  // An empty paragraph from consecutive newlines still occupies a row.
  assertEquals(countWrappedLines("a\n\nb", 10), 3);
});

Deno.test("countWrappedLines: non-positive width falls back to one line", () => {
  assertEquals(countWrappedLines("hello", 0), 1);
  assertEquals(countWrappedLines("hello", -3), 1);
});
