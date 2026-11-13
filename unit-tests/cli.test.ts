import { describe, expect, test } from "vitest";
import {
  CliError,
  DEFAULT_FILENAME,
  formatUsage,
  parseCliArgs,
} from "../logic/cli.ts";

describe("parseCliArgs", () => {
  test("uses the default todo file when no arguments are given", () => {
    expect(parseCliArgs([])).toEqual({
      file: DEFAULT_FILENAME,
      help: false,
      version: false,
      noUpdateCheck: false,
      update: false,
      updateCheckOnly: false,
      updateYes: false,
    });
  });

  test("accepts a positional todo file", () => {
    expect(parseCliArgs(["work.txt"]).file).toBe("work.txt");
  });

  test("accepts --file, -f and --file=", () => {
    expect(parseCliArgs(["--file", "work.txt"]).file).toBe("work.txt");
    expect(parseCliArgs(["-f", "work.txt"]).file).toBe("work.txt");
    expect(parseCliArgs(["--file=work.txt"]).file).toBe("work.txt");
  });

  test("accepts --help and --version", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["-v"]).version).toBe(true);
  });

  test("treats everything after -- as a positional argument", () => {
    expect(parseCliArgs(["--", "--help"]).file).toBe("--help");
  });

  test("rejects unknown options", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(CliError);
    expect(() => parseCliArgs(["--nope"])).toThrow("Unknown option: --nope");
  });

  test("rejects a missing --file value", () => {
    expect(() => parseCliArgs(["--file"])).toThrow("--file requires a path.");
  });

  test("rejects an empty --file value", () => {
    expect(() => parseCliArgs(["--file="])).toThrow(
      "Todo file path cannot be empty.",
    );
  });

  test("rejects more than one todo file", () => {
    expect(() => parseCliArgs(["one.txt", "two.txt"])).toThrow(
      "Only one todo file may be specified.",
    );
    expect(() => parseCliArgs(["--file", "one.txt", "two.txt"])).toThrow(
      "Only one todo file may be specified.",
    );
  });

  test("accepts --no-update-check as a TUI flag", () => {
    expect(parseCliArgs(["--no-update-check"]).noUpdateCheck).toBe(true);
    expect(parseCliArgs(["--no-update-check", "work.txt"]).noUpdateCheck).toBe(
      true,
    );
    expect(parseCliArgs(["work.txt", "--no-update-check"]).noUpdateCheck).toBe(
      true,
    );
  });

  test("parses the update subcommand", () => {
    expect(parseCliArgs(["update"])).toMatchObject({
      update: true,
      updateCheckOnly: false,
      updateYes: false,
    });
    expect(parseCliArgs(["update", "--check"])).toMatchObject({
      update: true,
      updateCheckOnly: true,
      updateYes: false,
    });
    expect(parseCliArgs(["update", "--yes"])).toMatchObject({
      update: true,
      updateCheckOnly: false,
      updateYes: true,
    });
    expect(parseCliArgs(["update", "-y", "--check"])).toMatchObject({
      update: true,
      updateCheckOnly: true,
      updateYes: true,
    });
    expect(parseCliArgs(["update", "--version"]).version).toBe(true);
  });
});

test("formatUsage includes the version, usage and options", () => {
  const usage = formatUsage("1.2.3");

  expect(usage).toContain("thar 1.2.3");
  expect(usage).toContain("Usage:");
  expect(usage).toContain("--file <path>");
  expect(usage).toContain("--help");
  expect(usage).toContain("--version");
  expect(usage).toContain("update");
  expect(usage).toContain("--no-update-check");
});
