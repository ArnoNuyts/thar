import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";

export type InstallKind =
  | "npm-global"
  | "pnpm-global"
  | "yarn-global"
  | "bun-global"
  | "volta"
  | "npx"
  | "pnpm-dlx"
  | "bunx"
  | "homebrew"
  | "scoop"
  | "dev"
  | "sea"
  | "unknown";

export interface InstallDescriptor {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: RuntimePlatform;
  cwd?: string;
  isSea?: boolean;
  nodeModulesGlobalRoot?: string;
}

export interface InstallCommand {
  kind: InstallKind;
  display: string;
  command: string;
  args: string[];
  canSelfUpdate: boolean;
}

const normalizePath = (path: string, platform: RuntimePlatform): string => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "windows" ? normalized.toLowerCase() : normalized;
};

export const pathIsInside = (
  child: string,
  parent: string,
  platform: RuntimePlatform = "linux",
): boolean => {
  const normalizedChild = normalizePath(child, platform);
  const normalizedParent = normalizePath(parent, platform);

  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
};

export const detectInstallKind = ({
  scriptPath = "",
  env = {},
  platform = Runtime.platform,
  cwd,
  isSea: seaRuntime = false,
  nodeModulesGlobalRoot,
}: InstallDescriptor): InstallKind => {
  if (seaRuntime) return "sea";

  const path = normalizePath(scriptPath, platform);

  if (path.includes("/_npx/")) return "npx";
  if (path.includes("/pnpm/dlx/")) return "pnpm-dlx";
  if (path.includes("/.bun/install/cache/")) return "bunx";

  if (env.VOLTA_HOME || path.includes("/.volta/")) return "volta";
  if (env.PNPM_HOME) return "pnpm-global";
  if (env.BUN_INSTALL || path.includes("/.bun/install/global/")) {
    return "bun-global";
  }

  if (
    env.HOMEBREW_PREFIX ||
    path.includes("/cellar/") ||
    path.includes("/homebrew/") ||
    path.includes("/linuxbrew/")
  ) {
    return "homebrew";
  }

  if (env.SCOOP || path.includes("/scoop/apps/")) return "scoop";

  if (path.includes("/yarn/global/")) return "yarn-global";
  if (path.includes("/pnpm/global/")) return "pnpm-global";

  if (
    nodeModulesGlobalRoot &&
    pathIsInside(scriptPath, nodeModulesGlobalRoot, platform)
  ) {
    return "npm-global";
  }

  if (
    path.includes("/lib/node_modules/") ||
    path.includes("/appdata/roaming/npm/") ||
    path.includes("/.npm-global/") ||
    path.includes("/npm-global/")
  ) {
    return "npm-global";
  }

  if (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    (cwd && scriptPath && pathIsInside(scriptPath, cwd, platform))
  ) {
    return "dev";
  }

  return "unknown";
};

const INSTALL_LABELS: Record<InstallKind, string> = {
  "npm-global": "npm (global)",
  "pnpm-global": "pnpm (global)",
  "yarn-global": "yarn (global)",
  "bun-global": "bun (global)",
  volta: "Volta",
  npx: "npx (ephemeral)",
  "pnpm-dlx": "pnpm dlx (ephemeral)",
  bunx: "bunx (ephemeral)",
  homebrew: "Homebrew",
  scoop: "Scoop",
  dev: "development checkout",
  sea: "single executable",
  unknown: "unknown",
};

export const describeInstallKind = (kind: InstallKind): string =>
  INSTALL_LABELS[kind];

const COMMANDS: Record<InstallKind, Omit<InstallCommand, "kind">> = {
  "npm-global": {
    display: "npm install -g todotui@latest",
    command: "npm",
    args: ["install", "-g", "todotui@latest"],
    canSelfUpdate: true,
  },
  "pnpm-global": {
    display: "pnpm add -g todotui@latest",
    command: "pnpm",
    args: ["add", "-g", "todotui@latest"],
    canSelfUpdate: true,
  },
  "yarn-global": {
    display: "yarn global add todotui@latest",
    command: "yarn",
    args: ["global", "add", "todotui@latest"],
    canSelfUpdate: true,
  },
  "bun-global": {
    display: "bun add -g todotui@latest",
    command: "bun",
    args: ["add", "-g", "todotui@latest"],
    canSelfUpdate: true,
  },
  volta: {
    display: "volta install todotui@latest",
    command: "volta",
    args: ["install", "todotui@latest"],
    canSelfUpdate: true,
  },
  npx: {
    display: "npx todotui@latest",
    command: "npx",
    args: ["todotui@latest"],
    canSelfUpdate: false,
  },
  "pnpm-dlx": {
    display: "pnpm dlx todotui@latest",
    command: "pnpm",
    args: ["dlx", "todotui@latest"],
    canSelfUpdate: false,
  },
  bunx: {
    display: "bunx todotui@latest",
    command: "bunx",
    args: ["todotui@latest"],
    canSelfUpdate: false,
  },
  homebrew: {
    display: "brew upgrade todotui",
    command: "brew",
    args: ["upgrade", "todotui"],
    canSelfUpdate: true,
  },
  scoop: {
    display: "scoop update todotui",
    command: "scoop",
    args: ["update", "todotui"],
    canSelfUpdate: true,
  },
  dev: {
    display: "git pull && npm install",
    command: "",
    args: [],
    canSelfUpdate: false,
  },
  sea: {
    display:
      "Download the latest release from https://github.com/ArnoNuyts/todotui/releases",
    command: "",
    args: [],
    canSelfUpdate: false,
  },
  unknown: {
    display: "npm install -g todotui@latest",
    command: "",
    args: [],
    canSelfUpdate: false,
  },
};

export const getInstallCommand = (
  kind: InstallKind,
  platform: RuntimePlatform = Runtime.platform,
): InstallCommand => {
  const base = COMMANDS[kind];

  if (platform === "windows" && base.canSelfUpdate) {
    return {
      kind,
      ...base,
      command: "cmd.exe",
      args: ["/d", "/s", "/c", base.command, ...base.args],
    };
  }

  return { kind, ...base };
};

export const isSeaRuntime = (): boolean => {
  try {
    return isSea();
  } catch {
    return false;
  }
};

const getModulePath = (): string => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] ?? "";
  }
};

export const getDefaultInstallDescriptor = (): InstallDescriptor => ({
  scriptPath: getModulePath(),
  env: process.env,
  platform: Runtime.platform,
  cwd: process.cwd(),
  isSea: isSeaRuntime(),
});
