export async function copyToClipboard(text: string) {
  let command: Deno.Command;

  if (Deno.build.os === "windows") {
    // Use clip.exe on Windows which reads from stdin
    command = new Deno.Command("clip", {
      stdin: "piped",
    });
  } else if (Deno.build.os === "darwin") {
    // Use pbcopy on macOS
    command = new Deno.Command("pbcopy", {
      stdin: "piped",
    });
  } else {
    // Try xclip on Linux
    command = new Deno.Command("xclip", {
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
  let command: Deno.Command;

  if (Deno.build.os === "windows") {
    // Use powershell on Windows
    command = new Deno.Command("powershell.exe", {
      args: ["-Command", "Get-Clipboard"],
      stdout: "piped",
    });
  } else if (Deno.build.os === "darwin") {
    // Use pbpaste on macOS
    command = new Deno.Command("pbpaste", {
      stdout: "piped",
    });
  } else {
    // Try xclip on Linux
    command = new Deno.Command("xclip", {
      args: ["-selection", "clipboard", "-o"],
      stdout: "piped",
    });
  }

  const { stdout } = await command.output();
  return new TextDecoder().decode(stdout).trim();
}
