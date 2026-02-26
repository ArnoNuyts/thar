import { assertEquals } from "@std/assert";
import { getModalBodyRowFromClick } from "../utils/modal-mouse.ts";
import { MouseEvent } from "../hooks/useMouseInput.ts";

const clickEvent = (x: number, y: number): MouseEvent => ({
  wheelUp: false,
  wheelDown: false,
  leftClick: true,
  move: false,
  x,
  y,
  raw: {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
    mouseWheelUp: false,
    mouseWheelDown: false,
    mouseLeft: true,
    mouseMove: false,
    mouseX: x,
    mouseY: y,
  },
});

Deno.test("modal mouse: priority menu maps first and last rows with odd terminal rows", () => {
  // Priority modal: width 30, 6 body rows (A-F), modal chrome is 5 rows.
  // With odd terminal rows (25), the body starts at row 11.
  const stdout = { rows: 25, columns: 101 };
  const options = { modalWidth: 30, bodyRows: 6 };

  assertEquals(
    getModalBodyRowFromClick(clickEvent(36, 11), stdout, options),
    0,
  );
  assertEquals(
    getModalBodyRowFromClick(clickEvent(65, 16), stdout, options),
    5,
  );
});

Deno.test("modal mouse: priority menu ignores rows outside body with odd terminal rows", () => {
  const stdout = { rows: 25, columns: 101 };
  const options = { modalWidth: 30, bodyRows: 6 };

  // One row above and below the body should not map.
  assertEquals(
    getModalBodyRowFromClick(clickEvent(40, 10), stdout, options),
    undefined,
  );
  assertEquals(
    getModalBodyRowFromClick(clickEvent(40, 17), stdout, options),
    undefined,
  );
});

Deno.test("modal mouse: priority menu maps first and last rows with even terminal rows", () => {
  // rows=24 and modalHeight=11 leaves odd free-space; centered modal starts one row lower.
  const stdout = { rows: 24, columns: 101 };
  const options = { modalWidth: 30, bodyRows: 6 };

  assertEquals(
    getModalBodyRowFromClick(clickEvent(36, 11), stdout, options),
    0,
  );
  assertEquals(
    getModalBodyRowFromClick(clickEvent(65, 16), stdout, options),
    5,
  );
});

Deno.test("modal mouse: priority menu ignores rows outside body with even terminal rows", () => {
  const stdout = { rows: 24, columns: 101 };
  const options = { modalWidth: 30, bodyRows: 6 };

  assertEquals(
    getModalBodyRowFromClick(clickEvent(40, 10), stdout, options),
    undefined,
  );
  assertEquals(
    getModalBodyRowFromClick(clickEvent(40, 17), stdout, options),
    undefined,
  );
});
