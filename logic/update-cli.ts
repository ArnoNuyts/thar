import { parseCliArgs } from "./cli.ts";
import {
  detectInstallKind,
  getDefaultInstallDescriptor,
  getInstallCommand,
  describeInstallKind,
  type InstallDescriptor,
} from "./install-method.ts";
import {
  createRuntimeCommandRunner,
  lookupNpmGlobalRoot,
  type CommandRunner,
} from "./self-update.ts";
import {
  checkForUpdate,
  resolveRegistryBase,
  type FetchLike,
} from "./update-check.ts";
import { isNewerVersion } from "./version.ts";
import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";

export interface UpdateCliIO {
  write: (text: string) => void;
  isTTY: boolean;
  confirm: (question: string) => Promise<boolean>;
}

export interface UpdateCliOptions {
  argv: readonly string[];
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  platform?: RuntimePlatform;
  installDescriptor?: InstallDescriptor;
  fetchImpl?: FetchLike;
  runner?: CommandRunner;
  globalRootLookup?: () => Promise<string | undefined>;
  io?: Partial<UpdateCliIO>;
}

const defaultConfirm = async (question: string): Promise<boolean> => {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await readline.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
};

export const runUpdateCli = async (
  options: UpdateCliOptions,
): Promise<number> => {
  const command = parseCliArgs(options.argv);
  if (!command.update) return 2;

  const io: UpdateCliIO = {
    write: (text) => process.stdout.write(text),
    isTTY: Boolean(process.stdout.isTTY),
    confirm: defaultConfirm,
    ...options.io,
  };
  const env = options.env ?? process.env;
  const platform = options.platform ?? Runtime.platform;

  const outcome = await checkForUpdate({
    currentVersion: options.currentVersion,
    fetchImpl: options.fetchImpl,
    registryBase: resolveRegistryBase(env),
  });

  if (outcome.status === "error") {
    io.write(`Could not check for updates: ${outcome.reason}\n`);
    return 1;
  }

  io.write(`Current: v${options.currentVersion}\n`);
  io.write(`Latest:  v${outcome.latest}\n`);

  if (command.updateCheckOnly) return 0;

  if (!isNewerVersion(outcome.latest, options.currentVersion)) {
    io.write(`thar is up to date (v${options.currentVersion}).\n`);
    return 0;
  }

  let descriptor = options.installDescriptor ?? getDefaultInstallDescriptor();
  let kind = detectInstallKind(descriptor);

  if (kind === "unknown") {
    const lookup =
      options.globalRootLookup ??
      (() => lookupNpmGlobalRoot(undefined, platform));
    const root = await lookup();
    if (root) {
      descriptor = { ...descriptor, nodeModulesGlobalRoot: root };
      kind = detectInstallKind(descriptor);
    }
  }

  const installCommand = getInstallCommand(kind, platform);
  io.write(`Install method: ${describeInstallKind(kind)}\n`);

  if (!installCommand.canSelfUpdate) {
    io.write(`To update, run: ${installCommand.display}\n`);
    return 0;
  }

  io.write(`Update command: ${installCommand.display}\n`);

  if (!command.updateYes) {
    if (!io.isTTY) {
      io.write("Re-run with --yes to install.\n");
      return 0;
    }

    const confirmed = await io.confirm(
      `Run "${installCommand.display}"? [y/N] `,
    );
    if (!confirmed) {
      io.write("Update cancelled.\n");
      return 0;
    }
  }

  io.write(`Running: ${installCommand.display}\n`);

  const runner = options.runner ?? createRuntimeCommandRunner();
  let result: { success: boolean; code: number };
  try {
    result = await runner(installCommand.command, installCommand.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch {
    result = { success: false, code: 1 };
  }

  if (!result.success) {
    io.write(
      `Update failed. Nothing was changed. Run manually: ${installCommand.display}\n`,
    );
    return 1;
  }

  io.write(
    `Updated thar to v${outcome.latest}. Restart thar to use the new version.\n`,
  );
  return 0;
};
