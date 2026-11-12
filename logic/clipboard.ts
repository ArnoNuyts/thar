import { Runtime, type RuntimePlatform } from "../utils/runtime.ts";

type ClipboardEnvironment = {
  WAYLAND_DISPLAY?: string;
  DISPLAY?: string;
};

type ClipboardCommand = {
  command: string;
  args: string[];
};

export const getCopyCommands = (
  platform: RuntimePlatform,
  environment: ClipboardEnvironment = process.env,
): ClipboardCommand[] => {
  if (platform === "windows") {
    // clip.exe reads from stdin.
    return [{ command: "clip", args: [] }];
  }

  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }

  const xclip = { command: "xclip", args: ["-selection", "clipboard"] };

  // Prefer the Wayland-native tool when a Wayland session is active, but fall
  // back to xclip (XWayland) so the command still works on mixed setups.
  return environment.WAYLAND_DISPLAY
    ? [{ command: "wl-copy", args: [] }, xclip]
    : [xclip];
};

export const getPasteCommands = (
  platform: RuntimePlatform,
  environment: ClipboardEnvironment = process.env,
): ClipboardCommand[] => {
  if (platform === "windows") {
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-Command", "Get-Clipboard"],
      },
    ];
  }

  if (platform === "darwin") {
    return [{ command: "pbpaste", args: [] }];
  }

  const xclip = {
    command: "xclip",
    args: ["-selection", "clipboard", "-o"],
  };

  return environment.WAYLAND_DISPLAY
    ? [{ command: "wl-paste", args: ["--no-newline"] }, xclip]
    : [xclip];
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const copyWith = async (text: string, command: ClipboardCommand) => {
  const child = new Runtime.Command(command.command, {
    args: command.args,
    stdin: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();

  const status = await child.status;
  if (!status.success) {
    throw new Error(`${command.command} exited with code ${status.code}`);
  }
};

const pasteWith = async (command: ClipboardCommand) => {
  const result = await new Runtime.Command(command.command, {
    args: command.args,
    stdout: "piped",
  }).output();

  if (!result.success) {
    throw new Error(`${command.command} exited with code ${result.code}`);
  }

  return new TextDecoder().decode(result.stdout);
};

export async function copyToClipboard(text: string) {
  let lastError: unknown;

  for (const command of getCopyCommands(Runtime.platform)) {
    try {
      await copyWith(text, command);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Copy failed: ${describeError(lastError)}. On Linux, install xclip or wl-clipboard.`,
    { cause: lastError },
  );
}

export async function readFromClipboard(): Promise<string> {
  let lastError: unknown;

  for (const command of getPasteCommands(Runtime.platform)) {
    try {
      return (await pasteWith(command)).trim();
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Paste failed: ${describeError(lastError)}. On Linux, install xclip or wl-clipboard.`,
    { cause: lastError },
  );
}

export type { ClipboardCommand };
