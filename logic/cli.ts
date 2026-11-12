export const DEFAULT_FILENAME = "todo.txt";

export type CliOptions = {
  file: string;
  help: boolean;
  version: boolean;
};

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export const formatUsage = (version: string) =>
  [
    `todotui ${version}`,
    "",
    "A keyboard-driven todo.txt TUI for the terminal.",
    "",
    "Usage:",
    "  todotui [options] [file]",
    "",
    "Arguments:",
    `  file                  Todo file to open (default: ./${DEFAULT_FILENAME})`,
    "",
    "Options:",
    "  -f, --file <path>     Todo file to open",
    "  -h, --help            Show this help",
    "  -v, --version         Show version",
    "",
    "Press x inside the app to open the command menu.",
  ].join("\n");

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
  let file: string | undefined;
  let help = false;
  let version = false;
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
  };
};
