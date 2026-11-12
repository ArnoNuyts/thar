import { expect, test } from "vitest";

import {
  describeInstallKind,
  detectInstallKind,
  getInstallCommand,
  pathIsInside,
} from "../logic/install-method.ts";

test("install-method: detects SEA, npx, dlx and bunx installs", () => {
  expect(detectInstallKind({ isSea: true })).toEqual("sea");
  expect(
    detectInstallKind({
      scriptPath: "/home/me/.npm/_npx/123/node_modules/todotui/dist/main.js",
      env: {},
    }),
  ).toEqual("npx");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.local/share/pnpm/dlx/abc/node_modules/todotui/dist/main.js",
      env: {},
    }),
  ).toEqual("pnpm-dlx");
  expect(
    detectInstallKind({
      scriptPath: "/home/me/.bun/install/cache/todotui@0.5.0/dist/main.js",
      env: {},
    }),
  ).toEqual("bunx");
});

test("install-method: detects global package managers from paths", () => {
  expect(
    detectInstallKind({
      scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
      env: {},
      platform: "linux",
    }),
  ).toEqual("npm-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.local/share/pnpm/global/5/node_modules/todotui/dist/main.js",
      env: {},
      platform: "linux",
    }),
  ).toEqual("pnpm-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.config/yarn/global/node_modules/todotui/dist/main.js",
      env: {},
      platform: "linux",
    }),
  ).toEqual("yarn-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.bun/install/global/node_modules/todotui/dist/main.js",
      env: {},
      platform: "linux",
    }),
  ).toEqual("bun-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.volta/tools/image/packages/todotui/lib/node_modules/todotui/dist/main.js",
      env: {},
      platform: "linux",
    }),
  ).toEqual("volta");
});

test("install-method: uses environment markers only with matching paths", () => {
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.volta/tools/image/packages/todotui/lib/node_modules/todotui/dist/main.js",
      env: { VOLTA_HOME: "/home/me/.volta" },
    }),
  ).toEqual("volta");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.local/share/pnpm/global/5/node_modules/todotui/dist/main.js",
      env: { PNPM_HOME: "/home/me/.local/share/pnpm" },
    }),
  ).toEqual("pnpm-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/home/me/.bun/install/global/node_modules/todotui/dist/main.js",
      env: { BUN_INSTALL: "/home/me/.bun" },
    }),
  ).toEqual("bun-global");
  expect(
    detectInstallKind({
      scriptPath:
        "/opt/homebrew/Cellar/todotui/0.5.0/libexec/lib/node_modules/todotui/dist/main.js",
      env: { HOMEBREW_PREFIX: "/opt/homebrew" },
    }),
  ).toEqual("homebrew");
  expect(
    detectInstallKind({
      scriptPath: "C:\\Users\\me\\scoop\\apps\\todotui\\current\\dist\\main.js",
      env: { SCOOP: "C:\\Users\\me\\scoop" },
      platform: "windows",
    }),
  ).toEqual("scoop");

  // Bare shell markers must not override the real path.
  expect(
    detectInstallKind({
      scriptPath: "/opt/todotui/main.js",
      env: { VOLTA_HOME: "/home/me/.volta" },
    }),
  ).toEqual("unknown");
  expect(
    detectInstallKind({
      scriptPath: "/opt/todotui/main.js",
      env: { PNPM_HOME: "/home/me/.local/share/pnpm" },
    }),
  ).toEqual("unknown");
  expect(
    detectInstallKind({
      scriptPath: "/opt/todotui/main.js",
      env: { BUN_INSTALL: "/home/me/.bun" },
    }),
  ).toEqual("unknown");
  expect(
    detectInstallKind({
      scriptPath: "/opt/todotui/main.js",
      env: { HOMEBREW_PREFIX: "/opt/homebrew" },
    }),
  ).toEqual("unknown");
  expect(
    detectInstallKind({
      scriptPath: "/opt/todotui/main.js",
      env: { SCOOP: "C:\\Users\\me\\scoop" },
      platform: "windows",
    }),
  ).toEqual("unknown");
});

test("install-method: path evidence outranks ambient manager variables", () => {
  // A dev checkout in a shell that exports HOMEBREW_PREFIX is still a dev
  // checkout, not a Homebrew formula.
  expect(
    detectInstallKind({
      scriptPath: "/home/me/projects/todotui/dist/main.js",
      env: { HOMEBREW_PREFIX: "/opt/homebrew" },
      cwd: "/home/me/projects/todotui",
    }),
  ).toEqual("dev");
  expect(
    detectInstallKind({
      scriptPath: "/home/me/projects/todotui/dist/main.js",
      env: { PNPM_HOME: "/home/me/.local/share/pnpm" },
      cwd: "/home/me/projects/todotui",
    }),
  ).toEqual("dev");

  // An npm global package installed by a Homebrew-managed Node lives under
  // HOMEBREW_PREFIX but is still an npm install.
  expect(
    detectInstallKind({
      scriptPath: "/opt/homebrew/lib/node_modules/todotui/dist/main.js",
      env: { HOMEBREW_PREFIX: "/opt/homebrew" },
      platform: "darwin",
    }),
  ).toEqual("npm-global");
});

test("install-method: handles macOS and Windows path casing/layouts", () => {
  expect(
    detectInstallKind({
      scriptPath:
        "/usr/local/Cellar/todotui/0.5.0/libexec/lib/node_modules/todotui/dist/main.js",
      env: {},
      platform: "darwin",
    }),
  ).toEqual("homebrew");
  expect(
    detectInstallKind({
      scriptPath:
        "C:\\Users\\me\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\todotui\\dist\\main.js",
      env: {},
      platform: "windows",
    }),
  ).toEqual("yarn-global");
});

test("install-method: detects brew, scoop and an explicit global npm root", () => {
  expect(
    detectInstallKind({
      scriptPath:
        "/opt/homebrew/Cellar/todotui/0.5.0/libexec/lib/node_modules/todotui/dist/main.js",
      env: {},
    }),
  ).toEqual("homebrew");
  expect(
    detectInstallKind({
      scriptPath: "C:\\Users\\me\\scoop\\apps\\todotui\\current\\dist\\main.js",
      env: {},
      platform: "windows",
    }),
  ).toEqual("scoop");
  expect(
    detectInstallKind({
      scriptPath: "/usr/local/lib/node_modules/todotui/dist/main.js",
      env: {},
      nodeModulesGlobalRoot: "/usr/local/lib/node_modules",
    }),
  ).toEqual("npm-global");
});

test("install-method: detects dev checkouts and falls back to unknown", () => {
  expect(
    detectInstallKind({
      scriptPath: "/home/me/projects/todotui/main.tsx",
      env: {},
    }),
  ).toEqual("dev");
  expect(
    detectInstallKind({
      scriptPath: "/home/me/projects/todotui/dist/main.js",
      env: {},
      cwd: "/home/me/projects/todotui",
    }),
  ).toEqual("dev");
  expect(
    detectInstallKind({ scriptPath: "/usr/bin/todotui", env: {} }),
  ).toEqual("unknown");
  expect(detectInstallKind({})).toEqual("unknown");
});

test("install-method: pathIsInside respects path boundaries", () => {
  expect(
    pathIsInside("/usr/lib/node_modules/x", "/usr/lib/node_modules"),
  ).toEqual(true);
  expect(
    pathIsInside("/usr/lib/node_modules", "/usr/lib/node_modules"),
  ).toEqual(true);
  expect(
    pathIsInside("/usr/lib/node_modules-extra/x", "/usr/lib/node_modules"),
  ).toEqual(false);
  expect(
    pathIsInside(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\x",
      "C:\\Users\\me\\AppData\\Roaming\\npm",
      "windows",
    ),
  ).toEqual(true);
});

test("install-method: builds npm/pnpm/yarn/bun/volta commands", () => {
  expect(getInstallCommand("npm-global", "linux")).toMatchObject({
    command: "npm",
    args: ["install", "-g", "todotui@latest"],
    display: "npm install -g todotui@latest",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("pnpm-global", "linux")).toMatchObject({
    command: "pnpm",
    args: ["add", "-g", "todotui@latest"],
    display: "pnpm add -g todotui@latest",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("yarn-global", "linux")).toMatchObject({
    command: "yarn",
    args: ["global", "add", "todotui@latest"],
    display: "yarn global add todotui@latest",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("bun-global", "linux")).toMatchObject({
    command: "bun",
    args: ["add", "-g", "todotui@latest"],
    display: "bun add -g todotui@latest",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("volta", "linux")).toMatchObject({
    command: "volta",
    args: ["install", "todotui@latest"],
    display: "volta install todotui@latest",
    canSelfUpdate: true,
  });
});

test("install-method: ephemeral, brew and scoop commands", () => {
  expect(getInstallCommand("npx", "linux")).toMatchObject({
    display: "npx todotui@latest",
    canSelfUpdate: false,
  });
  expect(getInstallCommand("pnpm-dlx", "linux")).toMatchObject({
    display: "pnpm dlx todotui@latest",
    canSelfUpdate: false,
  });
  expect(getInstallCommand("bunx", "linux")).toMatchObject({
    display: "bunx todotui@latest",
    canSelfUpdate: false,
  });
  expect(getInstallCommand("homebrew", "darwin")).toMatchObject({
    command: "brew",
    args: ["upgrade", "todotui"],
    display: "brew upgrade todotui",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("scoop", "windows")).toMatchObject({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "scoop", "update", "todotui"],
    display: "scoop update todotui",
    canSelfUpdate: true,
  });
});

test("install-method: dev, sea and unknown never self-update", () => {
  for (const kind of ["dev", "sea", "unknown"] as const) {
    const command = getInstallCommand(kind, "linux");
    expect(command.canSelfUpdate).toEqual(false);
    expect(command.display.length).toBeGreaterThan(0);
  }
  expect(getInstallCommand("dev", "linux").display).toMatch(/git pull/);
  expect(getInstallCommand("sea", "linux").display).toMatch(
    /github\.com\/ArnoNuyts\/todotui\/releases/,
  );
  expect(getInstallCommand("unknown", "linux").display).toEqual(
    "npm install -g todotui@latest",
  );
});

test("install-method: Windows uses cmd.exe with fixed argv", () => {
  expect(getInstallCommand("npm-global", "windows")).toMatchObject({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "npm", "install", "-g", "todotui@latest"],
    display: "npm install -g todotui@latest",
    canSelfUpdate: true,
  });
  expect(getInstallCommand("pnpm-global", "windows")).toMatchObject({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "pnpm", "add", "-g", "todotui@latest"],
  });
});

test("install-method: describes every kind", () => {
  const kinds = [
    "npm-global",
    "pnpm-global",
    "yarn-global",
    "bun-global",
    "volta",
    "npx",
    "pnpm-dlx",
    "bunx",
    "homebrew",
    "scoop",
    "dev",
    "sea",
    "unknown",
  ] as const;

  for (const kind of kinds) {
    expect(describeInstallKind(kind)).toMatch(/\S/);
  }
});
