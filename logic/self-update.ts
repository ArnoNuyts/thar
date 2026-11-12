import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";
import type { PendingUpdate } from "./pending-update.ts";

export type CommandResult = {
  success: boolean;
  code: number;
};

export type CommandRunner = (
  command: string,
  args: string[],
  options: {
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => Promise<CommandResult>;

export type CommandOutputRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult & { stdout: string }>;

export const createRuntimeCommandRunner = (): CommandRunner => {
  return async (command, args, options) => {
    try {
      return await new Runtime.Command(command, {
        args,
        stdin: options.stdin,
        stdout: options.stdout,
        stderr: options.stderr,
      }).run();
    } catch {
      return { success: false, code: 1 };
    }
  };
};

const runtimeOutputRunner: CommandOutputRunner = async (command, args) => {
  try {
    const output = await new Runtime.Command(command, { args }).output();
    return {
      success: output.success,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
    };
  } catch {
    return { success: false, code: 1, stdout: "" };
  }
};

export const parseNpmGlobalRoot = (stdout: string): string | undefined => {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line || undefined;
};

export const getNpmRootCommand = (
  platform: RuntimePlatform = Runtime.platform,
): { command: string; args: string[] } =>
  platform === "windows"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", "root", "-g"] }
    : { command: "npm", args: ["root", "-g"] };

export const lookupNpmGlobalRoot = async (
  runner: CommandOutputRunner = runtimeOutputRunner,
  platform: RuntimePlatform = Runtime.platform,
): Promise<string | undefined> => {
  const { command, args } = getNpmRootCommand(platform);
  const result = await runner(command, args);
  if (!result.success) return undefined;
  return parseNpmGlobalRoot(result.stdout);
};

export interface PendingUpdateResult {
  ok: boolean;
  code: number;
  display: string;
  version: string;
}

/**
 * Runs the pending installer after Ink has exited, so its output owns the
 * terminal. Never retries and never throws.
 */
export const runPendingUpdate = async (
  pending: PendingUpdate,
  runner: CommandRunner = createRuntimeCommandRunner(),
): Promise<PendingUpdateResult> => {
  try {
    const result = await runner(pending.command.command, pending.command.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    return {
      ok: result.success,
      code: result.code,
      display: pending.command.display,
      version: pending.version,
    };
  } catch {
    return {
      ok: false,
      code: 1,
      display: pending.command.display,
      version: pending.version,
    };
  }
};
