import { assertEquals } from "@std/assert";
import { Key } from "../hooks/useInput.ts";
import {
  MENU_ITEMS,
  MULTI_SELECT_MENU_ITEMS,
  resolveMenuShortcut,
} from "../components/TodoMenu.tsx";

const key = (overrides: Partial<Key> = {}): Key => ({
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
  mouseLeft: false,
  mouseMove: false,
  ...overrides,
});

Deno.test("TodoMenu: every displayed shortcut resolves to its declared action", () => {
  for (const item of MENU_ITEMS) {
    const resolved = item.shortcut === "del"
      ? resolveMenuShortcut("", key({ delete: true }))
      : item.shortcut === "space"
      ? resolveMenuShortcut(" ", key())
      : resolveMenuShortcut(item.shortcut, key());

    assertEquals(
      resolved,
      item.action,
      `shortcut ${item.shortcut} should dispatch ${item.action}`,
    );
  }
});

Deno.test("MultiSelectMenu: every displayed shortcut resolves to its action", () => {
  for (const item of MULTI_SELECT_MENU_ITEMS) {
    const resolved = item.shortcut === "del"
      ? resolveMenuShortcut("", key({ delete: true }), MULTI_SELECT_MENU_ITEMS)
      : item.shortcut === "space"
      ? resolveMenuShortcut(" ", key(), MULTI_SELECT_MENU_ITEMS)
      : resolveMenuShortcut(item.shortcut, key(), MULTI_SELECT_MENU_ITEMS);

    assertEquals(
      resolved,
      item.action,
      `shortcut ${item.shortcut} should dispatch ${item.action}`,
    );
  }
});

Deno.test("MultiSelectMenu: only selection-wide actions are listed", () => {
  assertEquals(
    MULTI_SELECT_MENU_ITEMS.map(({ action }) => action),
    [
      "delete",
      "toggle",
      "due",
      "threshold",
      "recurrence",
      "priority",
      "add-project",
      "add-context",
      "toggle-hidden",
      "copy",
    ],
  );
});

Deno.test("MultiSelectMenu: single-todo and global shortcuts do not dispatch", () => {
  for (const shortcut of ["e", "a", "H", "z", "Z", "v"]) {
    assertEquals(
      resolveMenuShortcut(shortcut, key(), MULTI_SELECT_MENU_ITEMS),
      undefined,
      `${shortcut} should not be active in the multi-select menu`,
    );
  }
});

Deno.test("TodoMenu: menu labels and ordering are unchanged", () => {
  assertEquals(
    MENU_ITEMS.map(({ label, shortcut, action }) => ({
      label,
      shortcut,
      action,
    })),
    [
      { label: "Edit", shortcut: "e", action: "edit" },
      { label: "Delete", shortcut: "del", action: "delete" },
      { label: "Toggle Complete", shortcut: "space", action: "toggle" },
      { label: "Set Due Date", shortcut: "d", action: "due" },
      { label: "Set Threshold Date", shortcut: "t", action: "threshold" },
      { label: "Set Recurrence", shortcut: "r", action: "recurrence" },
      { label: "Set Priority", shortcut: "p", action: "priority" },
      { label: "Modify Projects", shortcut: "+", action: "add-project" },
      { label: "Modify Contexts", shortcut: "@", action: "add-context" },
      { label: "Toggle Hidden", shortcut: "h", action: "toggle-hidden" },
      {
        label: "Show/Hide Hidden",
        shortcut: "H",
        action: "toggle-view-hidden",
      },
      { label: "Archive Completed", shortcut: "a", action: "archive" },
      { label: "Copy", shortcut: "c", action: "copy" },
      { label: "Undo", shortcut: "z", action: "undo" },
      { label: "Redo", shortcut: "Z", action: "redo" },
      { label: "Paste", shortcut: "v", action: "paste" },
    ],
  );
});

Deno.test("TodoMenu: named keys do not fall through to literal dispatch", () => {
  assertEquals(
    resolveMenuShortcut("", key({ return: true })),
    undefined,
  );
  assertEquals(
    resolveMenuShortcut("", key({ escape: true })),
    undefined,
  );
  assertEquals(
    resolveMenuShortcut("", key({ delete: true })),
    "delete",
  );
  assertEquals(resolveMenuShortcut(" ", key()), "toggle");
  assertEquals(resolveMenuShortcut("nonsense", key()), undefined);
});
