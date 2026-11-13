export const DEFAULT_FILENAME = "todo.txt";

export type CliOptions = {
  file: string;
  help: boolean;
  version: boolean;
  noUpdateCheck: boolean;
  update: boolean;
  updateCheckOnly: boolean;
  updateYes: boolean;
};

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const formatUsage = (version: string) =>
  [
    `thar ${version}`,
    "",
    "A keyboard-driven todo.txt TUI for the terminal.",
    "",
    "Usage:",
    "  thar [options] [file]",
    "  thar update [--check] [--yes]",
    "",
    "Arguments:",
    `  file                  Todo file to open (default: ./${DEFAULT_FILENAME})`,
    "",
    "Options:",
    "  -f, --file <path>     Todo file to open",
    "  -h, --help            Show this help",
    "  -v, --version         Show version",
    "  --no-update-check     Skip the background update check",
    "",
    "Environment:",
    "  THAR_NO_UPDATE_CHECK=1   skip the background update check",
    "  NO_UPDATE_NOTIFIER=1     skip the background update check",
    "  THAR_REGISTRY=<url>      override the npm registry base URL",
    "  THAR_STATE_DIR=<dir>     override the update-check cache directory",
    "",
    "Press x inside the app to open the command menu.",
  ].join("\n");

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  if (argv[0] === "update") {
    return {
      file: DEFAULT_FILENAME,
      help: false,
      version: argv.includes("--version") || argv.includes("-v"),
      noUpdateCheck: false,
      update: true,
      updateCheckOnly: argv.includes("--check"),
      updateYes: argv.includes("--yes") || argv.includes("-y"),
    };
  }

  let file: string | undefined;
  let help = false;
  let version = false;
  let noUpdateCheck = false;
  let endOfOptions = false;

  const setFile = (value: string) => {
    if (value.length === 0) {
      throw new CliError("Todo file path cannot be empty.");
    }
    if (file !== undefined) {
      throw new CliError("Only one todo file may be specified.");
    }
    file = value;
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (!endOfOptions && argument === "--") {
      endOfOptions = true;
      continue;
    }

    if (!endOfOptions && (argument === "-h" || argument === "--help")) {
      help = true;
      continue;
    }

    if (!endOfOptions && (argument === "-v" || argument === "--version")) {
      version = true;
      continue;
    }

    if (!endOfOptions && argument === "--no-update-check") {
      noUpdateCheck = true;
      continue;
    }

    if (!endOfOptions && (argument === "-f" || argument === "--file")) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CliError(`${argument} requires a path.`);
      }
      setFile(value);
      index++;
      continue;
    }

    if (!endOfOptions && argument.startsWith("--file=")) {
      setFile(argument.slice("--file=".length));
      continue;
    }

    if (!endOfOptions && argument.startsWith("-") && argument !== "-") {
      throw new CliError(`Unknown option: ${argument}`);
    }

    setFile(argument);
  }

  return {
    file: file ?? DEFAULT_FILENAME,
    help,
    version,
    noUpdateCheck,
    update: false,
    updateCheckOnly: false,
    updateYes: false,
  };
};
