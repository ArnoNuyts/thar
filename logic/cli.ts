export type CliCommand =
  | {
      kind: "tui";
      filename: string;
      noUpdateCheck: boolean;
    }
  | { kind: "version" }
  | { kind: "update"; checkOnly: boolean; yes: boolean };

export const parseCliArgs = (argv: readonly string[]): CliCommand => {
  if (argv.includes("--version") || argv.includes("-v")) {
    return { kind: "version" };
  }

  if (argv[0] === "update") {
    return {
      kind: "update",
      checkOnly: argv.includes("--check"),
      yes: argv.includes("--yes") || argv.includes("-y"),
    };
  }

  const filename =
    argv.find((argument) => !argument.startsWith("-")) ?? "todo.txt";

  return {
    kind: "tui",
    filename,
    noUpdateCheck: argv.includes("--no-update-check"),
  };
};

export const formatUsage = (): string =>
  [
    "Usage:",
    "  todotui [file]              open the TUI on <file> (default: todo.txt)",
    "  todotui --version | -v      print the version",
    "  todotui update [--check]    check for or install updates",
    "  todotui --no-update-check   skip the background update check",
    "",
    "Environment:",
    "  TODOTUI_NO_UPDATE_CHECK=1   skip the background update check",
    "  NO_UPDATE_NOTIFIER=1        skip the background update check",
    "  TODOTUI_REGISTRY=<url>      override the npm registry base URL",
    "  TODOTUI_STATE_DIR=<dir>     override the update-check cache directory",
  ].join("\n");
