import { describe, expect, test } from "vitest";
import { getCopyCommands, getPasteCommands } from "../logic/clipboard.ts";

describe("clipboard command selection", () => {
  test("uses clip.exe on Windows", () => {
    expect(getCopyCommands("windows", {})).toEqual([
      { command: "clip", args: [] },
    ]);
    expect(getPasteCommands("windows", {})[0]?.command).toBe("powershell.exe");
  });

  test("uses pbcopy/pbpaste on macOS", () => {
    expect(getCopyCommands("darwin", {})).toEqual([
      { command: "pbcopy", args: [] },
    ]);
    expect(getPasteCommands("darwin", {})).toEqual([
      { command: "pbpaste", args: [] },
    ]);
  });

  test("uses xclip on X11 Linux", () => {
    expect(getCopyCommands("linux", {})).toEqual([
      { command: "xclip", args: ["-selection", "clipboard"] },
    ]);
    expect(getPasteCommands("linux", {})).toEqual([
      { command: "xclip", args: ["-selection", "clipboard", "-o"] },
    ]);
  });

  test("prefers wl-clipboard on Wayland with an xclip fallback", () => {
    expect(getCopyCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual([
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
    ]);
    expect(getPasteCommands("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(
      [
        { command: "wl-paste", args: ["--no-newline"] },
        { command: "xclip", args: ["-selection", "clipboard", "-o"] },
      ],
    );
  });
});
