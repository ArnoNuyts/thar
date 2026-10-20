import { expect, test } from "vitest";

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
test("getHoveredButtonIndex: ignores positions without coordinates", () => {
  expect(getHoveredButtonIndex(undefined, 13, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(10, undefined, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(undefined, undefined, baseOptions)).toEqual(
    null,
  );
});

test("getHoveredButtonIndex: maps each button region", () => {
  expect(getHoveredButtonIndex(10, 13, baseOptions)).toEqual(0);
  expect(getHoveredButtonIndex(30, 13, baseOptions)).toEqual(1);
});

test("getHoveredButtonIndex: maps button edges inclusively", () => {
  expect(getHoveredButtonIndex(7, 13, baseOptions)).toEqual(0);
  expect(getHoveredButtonIndex(14, 13, baseOptions)).toEqual(0);
  expect(getHoveredButtonIndex(26, 13, baseOptions)).toEqual(1);
  expect(getHoveredButtonIndex(35, 13, baseOptions)).toEqual(1);
});

test("getHoveredButtonIndex: ignores divider and padding gaps", () => {
  // Between the left label (ends at 14) and the right label (starts at 26).
  expect(getHoveredButtonIndex(15, 13, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(20, 13, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(25, 13, baseOptions)).toEqual(null);
  // Outside the modal and outside the right label.
  expect(getHoveredButtonIndex(0, 13, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(36, 13, baseOptions)).toEqual(null);
});

test("getHoveredButtonIndex: ignores rows above and below the buttons", () => {
  expect(getHoveredButtonIndex(10, 12, baseOptions)).toEqual(null);
  expect(getHoveredButtonIndex(10, 14, baseOptions)).toEqual(null);
});

test("countWrappedLines: empty string counts as one line", () => {
  expect(countWrappedLines("", 10)).toEqual(1);
});

test("countWrappedLines: single short line", () => {
  expect(countWrappedLines("hello", 10)).toEqual(1);
});

test("countWrappedLines: text exactly the width fits on one line", () => {
  expect(countWrappedLines("abcdefghij", 10)).toEqual(1);
});

test("countWrappedLines: width + 1 characters wraps once", () => {
  expect(countWrappedLines("abcdefghijk", 10)).toEqual(2);
});

test("countWrappedLines: multiple wraps", () => {
  expect(countWrappedLines("abcdefghijklmnopqrstuvw", 10)).toEqual(3);
});

test("countWrappedLines: wraps on word boundaries", () => {
  expect(countWrappedLines("hello world foo", 10)).toEqual(2);
});

test("countWrappedLines: explicit newlines each start a new line", () => {
  expect(countWrappedLines("a\nb", 10)).toEqual(2);
  expect(countWrappedLines("a\nb\nc", 10)).toEqual(3);
  // An empty paragraph from consecutive newlines still occupies a row.
  expect(countWrappedLines("a\n\nb", 10)).toEqual(3);
});

test("countWrappedLines: non-positive width falls back to one line", () => {
  expect(countWrappedLines("hello", 0)).toEqual(1);
  expect(countWrappedLines("hello", -3)).toEqual(1);
});
