import { Runtime, type RuntimeCommand } from "../utils/runtime.ts";

export async function copyToClipboard(text: string) {
  let command: RuntimeCommand;

  if (Runtime.platform === "windows") {
    // Use clip.exe on Windows which reads from stdin
    command = new Runtime.Command("clip", {
      stdin: "piped",
    });
  } else if (Runtime.platform === "darwin") {
    // Use pbcopy on macOS
    command = new Runtime.Command("pbcopy", {
      stdin: "piped",
    });
  } else {
    // Try xclip on Linux
    command = new Runtime.Command("xclip", {
      args: ["-selection", "clipboard"],
      stdin: "piped",
    });
  }

  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  await child.status;
}

export async function readFromClipboard(): Promise<string> {
  let command: RuntimeCommand;

  if (Runtime.platform === "windows") {
    // Use powershell on Windows
    command = new Runtime.Command("powershell.exe", {
      args: ["-Command", "Get-Clipboard"],
      stdout: "piped",
    });
  } else if (Runtime.platform === "darwin") {
    // Use pbpaste on macOS
    command = new Runtime.Command("pbpaste", {
      stdout: "piped",
    });
  } else {
    // Try xclip on Linux
    command = new Runtime.Command("xclip", {
      args: ["-selection", "clipboard", "-o"],
      stdout: "piped",
    });
  }

  const { stdout } = await command.output();
  return new TextDecoder().decode(stdout).trim();
}
