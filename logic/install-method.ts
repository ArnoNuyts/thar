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
  // Windows and macOS filesystems are case-insensitive by default, and
  // Homebrew paths commonly mix case (`/usr/local/Cellar`).
  return platform === "windows" || platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
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
  // Layout markers (Cellar, scoop, _npx, ...) are matched case-insensitively
  // so Intel macOS Homebrew (`/usr/local/Cellar`) and Windows paths work.
  const markers = path.toLowerCase();

  // Ephemeral installs are identified by their cache paths.
  if (markers.includes("/_npx/")) return "npx";
  if (markers.includes("/pnpm/dlx/")) return "pnpm-dlx";
  if (markers.includes("/.bun/install/cache/")) return "bunx";

  // Path evidence outranks ambient package-manager variables. Homebrew and
  // Scoop both set global variables for their whole shell, which says nothing
  // about how this particular executable was installed.
  if (markers.includes("/cellar/")) return "homebrew";
  if (markers.includes("/scoop/apps/")) return "scoop";
  if (
    markers.includes("/yarn/global/") ||
    markers.includes("/yarn/data/global/") ||
    markers.includes("/.config/yarn/global/")
  ) {
    return "yarn-global";
  }
  if (markers.includes("/pnpm/global/")) return "pnpm-global";
  if (markers.includes("/.bun/install/global/")) return "bun-global";
  if (markers.includes("/.volta/")) return "volta";

  // An explicitly resolved global npm root is authoritative.
  if (
    nodeModulesGlobalRoot &&
    pathIsInside(scriptPath, nodeModulesGlobalRoot, platform)
  ) {
    return "npm-global";
  }

  if (
    markers.includes("/lib/node_modules/") ||
    markers.includes("/appdata/roaming/npm/") ||
    markers.includes("/.npm-global/") ||
    markers.includes("/npm-global/")
  ) {
    return "npm-global";
  }

  // Homebrew's bin shims live under the prefix rather than under Cellar.
  if (markers.includes("/homebrew/") || markers.includes("/linuxbrew/")) {
    return "homebrew";
  }

  // A source checkout or a path under the working tree is a dev install, even
  // when the shell exports PNPM_HOME, HOMEBREW_PREFIX, or similar markers.
  if (
    markers.endsWith(".ts") ||
    markers.endsWith(".tsx") ||
    (cwd && scriptPath && pathIsInside(scriptPath, cwd, platform))
  ) {
    return "dev";
  }

  // Fall back to environment markers only when the executable lives under the
  // manager's own directory. A bare marker is not enough evidence.
  if (env.VOLTA_HOME && pathIsInside(scriptPath, env.VOLTA_HOME, platform)) {
    return "volta";
  }
  if (env.PNPM_HOME && pathIsInside(scriptPath, env.PNPM_HOME, platform)) {
    return "pnpm-global";
  }
  if (env.BUN_INSTALL && pathIsInside(scriptPath, env.BUN_INSTALL, platform)) {
    return "bun-global";
  }
  if (env.HOMEBREW_PREFIX) {
    const cellar = `${env.HOMEBREW_PREFIX.replace(/\/+$/, "")}/Cellar`;
    if (pathIsInside(scriptPath, cellar, platform)) return "homebrew";
  }
  if (env.SCOOP) {
    const apps = `${env.SCOOP.replace(/\\+$/, "")}/apps`;
    if (pathIsInside(scriptPath, apps, platform)) return "scoop";
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
