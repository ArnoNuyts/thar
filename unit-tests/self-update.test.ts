import { expect, test } from "vitest";

import type { InstallCommand } from "../logic/install-method.ts";
import {
  clearPendingUpdate,
  peekPendingUpdate,
  setPendingUpdate,
  takePendingUpdate,
} from "../logic/pending-update.ts";
import {
  createRuntimeCommandRunner,
  getNpmRootCommand,
  lookupNpmGlobalRoot,
  parseNpmGlobalRoot,
  runPendingUpdate,
  type CommandRunner,
} from "../logic/self-update.ts";

const npmCommand: InstallCommand = {
  kind: "npm-global",
  display: "npm install -g todotui@latest",
  command: "npm",
  args: ["install", "-g", "todotui@latest"],
  canSelfUpdate: true,
};

test("pending-update: stores a process-scoped action exactly once", () => {
  clearPendingUpdate();
  expect(peekPendingUpdate()).toBeUndefined();

  setPendingUpdate({ command: npmCommand, version: "0.5.0" });
  expect(peekPendingUpdate()).toEqual({
    command: npmCommand,
    version: "0.5.0",
  });

  const taken = takePendingUpdate();
  expect(taken?.version).toEqual("0.5.0");
  expect(peekPendingUpdate()).toBeUndefined();
  expect(takePendingUpdate()).toBeUndefined();
});

test("self-update: runs the installer with inherited stdio and fixed argv", async () => {
  const calls: {
    command: string;
    args: string[];
    options: Record<string, string>;
  }[] = [];

  const runner: CommandRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { success: true, code: 0 };
  };

  const result = await runPendingUpdate(
    { command: npmCommand, version: "0.5.0" },
    runner,
  );

  expect(result).toEqual({
    ok: true,
    code: 0,
    display: "npm install -g todotui@latest",
    version: "0.5.0",
  });
  expect(calls).toEqual([
    {
      command: "npm",
      args: ["install", "-g", "todotui@latest"],
      options: { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    },
  ]);
});

test("self-update: reports a failed installer without retrying", async () => {
  let calls = 0;
  const runner: CommandRunner = async () => {
    calls++;
    return { success: false, code: 17 };
  };

  const result = await runPendingUpdate(
    { command: npmCommand, version: "0.5.0" },
    runner,
  );

  expect(calls).toEqual(1);
  expect(result.ok).toEqual(false);
  expect(result.code).toEqual(17);
});

test("self-update: a thrown runner failure becomes a clean failure", async () => {
  const runner: CommandRunner = async () => {
    throw new Error("spawn failed");
  };

  const result = await runPendingUpdate(
    { command: npmCommand, version: "0.5.0" },
    runner,
  );

  expect(result.ok).toEqual(false);
  expect(result.code).toEqual(1);
});

test("self-update: npm root lookup parses the first non-empty line", async () => {
  expect(parseNpmGlobalRoot("\n/usr/local/lib/node_modules\r\n")).toEqual(
    "/usr/local/lib/node_modules",
  );
  expect(parseNpmGlobalRoot("   ")).toBeUndefined();

  const calls: string[][] = [];
  const root = await lookupNpmGlobalRoot(async (command, args) => {
    calls.push([command, ...args]);
    return {
      success: true,
      code: 0,
      stdout: "/usr/local/lib/node_modules\n",
    };
  }, "linux");

  expect(root).toEqual("/usr/local/lib/node_modules");
  expect(calls).toEqual([["npm", "root", "-g"]]);
});

test("self-update: Windows npm root lookup uses cmd.exe", () => {
  expect(getNpmRootCommand("windows").command).toEqual("cmd.exe");
  expect(getNpmRootCommand("windows").args).toEqual([
    "/d",
    "/s",
    "/c",
    "npm",
    "root",
    "-g",
  ]);
  expect(getNpmRootCommand("linux")).toEqual({
    command: "npm",
    args: ["root", "-g"],
  });
});

test("self-update: the runtime runner is injectable", () => {
  expect(typeof createRuntimeCommandRunner()).toEqual("function");
});
