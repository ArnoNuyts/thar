import { expect, test } from "vitest";

import { formatUsage, parseCliArgs } from "../logic/cli.ts";

test("cli: no args opens the default todo file", () => {
  expect(parseCliArgs([])).toEqual({
    kind: "tui",
    filename: "todo.txt",
    noUpdateCheck: false,
  });
});

test("cli: a positional argument is the todo file", () => {
  expect(parseCliArgs(["work.txt"])).toEqual({
    kind: "tui",
    filename: "work.txt",
    noUpdateCheck: false,
  });
  expect(parseCliArgs(["update.txt"])).toMatchObject({
    kind: "tui",
    filename: "update.txt",
  });
  expect(parseCliArgs(["./update"])).toMatchObject({
    kind: "tui",
    filename: "./update",
  });
});

test("cli: --version and -v print the version", () => {
  expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["todo.txt", "--version"])).toEqual({ kind: "version" });
});

test("cli: --no-update-check is a TUI flag, not a filename", () => {
  expect(parseCliArgs(["--no-update-check"])).toEqual({
    kind: "tui",
    filename: "todo.txt",
    noUpdateCheck: true,
  });
  expect(parseCliArgs(["--no-update-check", "work.txt"])).toEqual({
    kind: "tui",
    filename: "work.txt",
    noUpdateCheck: true,
  });
  expect(parseCliArgs(["work.txt", "--no-update-check"])).toEqual({
    kind: "tui",
    filename: "work.txt",
    noUpdateCheck: true,
  });
});

test("cli: update is a reserved first positional", () => {
  expect(parseCliArgs(["update"])).toEqual({
    kind: "update",
    checkOnly: false,
    yes: false,
  });
  expect(parseCliArgs(["update", "--check"])).toEqual({
    kind: "update",
    checkOnly: true,
    yes: false,
  });
  expect(parseCliArgs(["update", "--yes"])).toEqual({
    kind: "update",
    checkOnly: false,
    yes: true,
  });
  expect(parseCliArgs(["update", "-y", "--check"])).toEqual({
    kind: "update",
    checkOnly: true,
    yes: true,
  });
});

test("cli: version wins over other arguments", () => {
  expect(parseCliArgs(["update", "--version"])).toEqual({ kind: "version" });
});

test("cli: formatUsage documents the supported command line", () => {
  const usage = formatUsage();
  expect(usage).toMatch(/todotui \[file\]/);
  expect(usage).toMatch(/--version/);
  expect(usage).toMatch(/update/);
  expect(usage).toMatch(/--no-update-check/);
});
