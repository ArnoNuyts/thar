import { expect, test } from "vitest";

import type { FetchLike } from "../logic/update-check.ts";
import type { CommandRunner } from "../logic/self-update.ts";
import { runUpdateCli } from "../logic/update-cli.ts";

const latestFetch =
  (version: string): FetchLike =>
  async () =>
    new Response(JSON.stringify({ name: "todotui", version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

const npmDescriptor = {
  scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const npxDescriptor = {
  scriptPath: "/home/me/.npm/_npx/123/node_modules/todotui/dist/main.js",
  env: {},
  platform: "linux" as const,
};

const makeIo = () => {
  const output: string[] = [];
  const confirmations: string[] = [];
  return {
    output,
    confirmations,
    io: {
      write: (text: string) => output.push(text),
      isTTY: true,
      confirm: async (question: string) => {
        confirmations.push(question);
        return true;
      },
    },
  };
};

test("update-cli: --check prints current and latest without installing", async () => {
  const { output, io } = makeIo();
  let runnerCalls = 0;
  const runner: CommandRunner = async () => {
    runnerCalls++;
    return { success: true, code: 0 };
  };

  const code = await runUpdateCli({
    argv: ["update", "--check"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner,
    io,
  });

  expect(code).toEqual(0);
  expect(output.join("")).toMatch(/Current: v0\.4\.0/);
  expect(output.join("")).toMatch(/Latest: +v0\.5\.0/);
  expect(runnerCalls).toEqual(0);
});

test("update-cli: reports when the current version is up to date", async () => {
  const { output, io } = makeIo();
  let runnerCalls = 0;

  const code = await runUpdateCli({
    argv: ["update"],
    currentVersion: "0.5.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async () => {
      runnerCalls++;
      return { success: true, code: 0 };
    },
    io,
  });

  expect(code).toEqual(0);
  expect(output.join("")).toMatch(/up to date/i);
  expect(runnerCalls).toEqual(0);
});

test("update-cli: non-interactive mode requires --yes", async () => {
  const { output, io } = makeIo();
  io.isTTY = false;

  let runnerCalls = 0;
  const code = await runUpdateCli({
    argv: ["update"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async () => {
      runnerCalls++;
      return { success: true, code: 0 };
    },
    io,
  });

  expect(code).toEqual(0);
  expect(output.join("")).toMatch(/npm install -g todotui@latest/);
  expect(output.join("")).toMatch(/--yes/);
  expect(runnerCalls).toEqual(0);
});

test("update-cli: --yes runs the detected command", async () => {
  const { output, io } = makeIo();
  const invocations: string[][] = [];

  const code = await runUpdateCli({
    argv: ["update", "--yes"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async (command, args) => {
      invocations.push([command, ...args]);
      return { success: true, code: 0 };
    },
    io,
  });

  expect(code).toEqual(0);
  expect(invocations).toEqual([["npm", "install", "-g", "todotui@latest"]]);
  expect(output.join("")).toMatch(/Updated todotui to v0\.5\.0/);
  expect(output.join("")).toMatch(/Restart todotui/);
});

test("update-cli: interactive confirmation can cancel", async () => {
  const { output, confirmations } = makeIo();
  let runnerCalls = 0;

  const code = await runUpdateCli({
    argv: ["update"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async () => {
      runnerCalls++;
      return { success: true, code: 0 };
    },
    io: {
      write: (text: string) => output.push(text),
      isTTY: true,
      confirm: async (question: string) => {
        confirmations.push(question);
        return false;
      },
    },
  });

  expect(code).toEqual(0);
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toMatch(/npm install -g todotui@latest/);
  expect(output.join("")).toMatch(/cancelled/i);
  expect(runnerCalls).toEqual(0);
});

test("update-cli: a failed install prints the manual command", async () => {
  const { output, io } = makeIo();

  const code = await runUpdateCli({
    argv: ["update", "--yes"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async () => ({ success: false, code: 1 }),
    io,
  });

  expect(code).toEqual(1);
  expect(output.join("")).toMatch(/Update failed/);
  expect(output.join("")).toMatch(/npm install -g todotui@latest/);
});

test("update-cli: ephemeral npx installs print the command instead of installing", async () => {
  const { output, io } = makeIo();
  let runnerCalls = 0;

  const code = await runUpdateCli({
    argv: ["update", "--yes"],
    currentVersion: "0.4.0",
    installDescriptor: npxDescriptor,
    fetchImpl: latestFetch("0.5.0"),
    runner: async () => {
      runnerCalls++;
      return { success: true, code: 0 };
    },
    io,
  });

  expect(code).toEqual(0);
  expect(output.join("")).toMatch(/npx todotui@latest/);
  expect(runnerCalls).toEqual(0);
});

test("update-cli: registry failures exit non-zero without throwing", async () => {
  const { output, io } = makeIo();

  const code = await runUpdateCli({
    argv: ["update", "--check"],
    currentVersion: "0.4.0",
    installDescriptor: npmDescriptor,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    io,
  });

  expect(code).toEqual(1);
  expect(output.join("")).toMatch(/Could not check for updates/);
});

test("update-cli: an unknown install can be resolved with npm root -g", async () => {
  const { output, io } = makeIo();
  const invocations: string[][] = [];

  const code = await runUpdateCli({
    argv: ["update", "--yes"],
    currentVersion: "0.4.0",
    installDescriptor: {
      scriptPath: "/opt/custom/todotui/main.js",
      env: {},
      platform: "linux",
    },
    globalRootLookup: async () => "/opt/custom",
    fetchImpl: latestFetch("0.5.0"),
    runner: async (command, args) => {
      invocations.push([command, ...args]);
      return { success: true, code: 0 };
    },
    io,
  });

  expect(code).toEqual(0);
  expect(invocations).toEqual([["npm", "install", "-g", "todotui@latest"]]);
  expect(output.join("")).toMatch(/npm/);
});
