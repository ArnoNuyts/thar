import { useLayoutEffect, useRef } from "react";
import { useStdin } from "ink";
import { useStdout } from "ink";
import { Buffer } from "node:buffer";

/**
Handy information about a key that was pressed.
*/
export type Key = {
  /**
  Up arrow key was pressed.
  */
  upArrow: boolean;

  /**
  Down arrow key was pressed.
  */
  downArrow: boolean;

  /**
  Left arrow key was pressed.
  */
  leftArrow: boolean;

  /**
  Right arrow key was pressed.
  */
  rightArrow: boolean;

  /**
  Page Down key was pressed.
  */
  pageDown: boolean;

  /**
  Page Up key was pressed.
  */
  pageUp: boolean;

  /**
  Return (Enter) key was pressed.
  */
  return: boolean;

  /**
  Escape key was pressed.
  */
  escape: boolean;

  /**
  Ctrl key was pressed.
  */
  ctrl: boolean;

  /**
  Shift key was pressed.
  */
  shift: boolean;

  /**
  Tab key was pressed.
  */
  tab: boolean;

  /**
  Backspace key was pressed.
  */
  backspace: boolean;

  /**
  Delete key was pressed.
  */
  delete: boolean;

  /**
  [Meta key](https://en.wikipedia.org/wiki/Meta_key) was pressed.
  */
  meta: boolean;

  /**
  Home key was pressed.
  */
  home: boolean;

  /**
  End key was pressed.
  */
  end: boolean;

  /**
  Mouse wheel was scrolled up.
  */
  mouseWheelUp: boolean;

  /**
  Mouse wheel was scrolled down.
  */
  mouseWheelDown: boolean;

  /**
  Left mouse button press event.
  */
  mouseLeft: boolean;

  /**
  Mouse moved event (no click/wheel).
  */
  mouseMove: boolean;

  /**
  1-based terminal column for mouse events.
  */
  mouseX?: number;

  /**
  1-based terminal row for mouse events.
  */
  mouseY?: number;
};

type Handler = (input: string, key: Key) => void;

type Options = {
  /**
  Enable or disable capturing of user input. Useful when there are multiple `useInput` hooks used at once to avoid handling the same input several times.

  @default true
  */
  isActive?: boolean;
  /**
  Enable terminal mouse reporting while this hook is active.

  @default false
  */
  enableMouse?: boolean;
};

type WritableTerminal = {
  write: (chunk: string) => unknown;
  isTTY?: boolean;
} | undefined;

let mouseModeRefCount = 0;
const canToggleMouseMode = (stdout: WritableTerminal) => stdout?.isTTY === true;

const enableMouseMode = (stdout: WritableTerminal) => {
  if (!stdout) return;
  if (!canToggleMouseMode(stdout)) return;
  if (mouseModeRefCount === 0) {
    // 1000: click tracking, 1003: all motion tracking, 1006: SGR coordinates.
    stdout.write("\x1b[?1000h\x1b[?1003h\x1b[?1006h");
  }
  mouseModeRefCount++;
};
const disableMouseMode = (stdout: WritableTerminal) => {
  if (!stdout || mouseModeRefCount === 0) return;
  if (!canToggleMouseMode(stdout)) return;
  mouseModeRefCount--;
  if (mouseModeRefCount === 0) {
    stdout.write("\x1b[?1000l\x1b[?1003l\x1b[?1006l");
  }
};

const keyName: Record<string, string> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[1;2A": "up", // Shift + Up
  "\x1b[1;5A": "up", // Ctrl + Up
  "\x1b[1;3A": "up", // Alt + Up
  "\x1b[1;9A": "up", // Alt + Up (Windows Terminal sometimes)

  "\x1b[1;6A": "up", // Ctrl + Shift + Up
  "\x1b[1;8A": "up", // Ctrl + Shift + Alt + Up
  "\x1b[1;4A": "up", // Shift + Alt + Up
  "\x1b[1;7A": "up", // Ctrl + Alt + Up

  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[1;2B": "down", // Shift + Down
  "\x1b[1;5B": "down", // Ctrl + Down
  "\x1b[1;3B": "down", // Alt + Down
  "\x1b[1;9B": "down", // Alt + Down (Windows Terminal sometimes)
  "\x1b[1;6B": "down", // Ctrl + Shift + Down
  "\x1b[1;8B": "down", // Ctrl + Shift + Alt + Down
  "\x1b[1;4B": "down", // Shift + Alt + Down
  "\x1b[1;7B": "down", // Ctrl + Alt + Down

  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[1;2D": "left", // Shift + Left
  "\x1b[1;5D": "left", // Ctrl + Left
  "\x1b[1;3D": "left", // Alt + Left
  "\x1b[1;9D": "left", // Alt + Left (Windows Terminal sometimes)
  "\x1b[1;6D": "left", // Ctrl + Shift + Left
  "\x1b[1;8D": "left", // Ctrl + Shift + Alt + Left
  "\x1b[1;4D": "left", // Shift + Alt + Left
  "\x1b[1;7D": "left", // Ctrl + Alt + Left

  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[1;2C": "right", // Shift + Right
  "\x1b[1;5C": "right", // Ctrl + Right
  "\x1b[1;3C": "right", // Alt + Right
  "\x1b[1;9C": "right", // Alt + Right (Windows Terminal sometimes)
  "\x1b[1;6C": "right", // Ctrl + Shift + Right
  "\x1b[1;8C": "right", // Ctrl + Shift + Alt + Right
  "\x1b[1;4C": "right", // Shift + Alt + Right
  "\x1b[1;7C": "right", // Ctrl + Alt + Right

  "\x1b[3;2~": "delete", // Shift + Delete
  "\x1b[3;5~": "delete", // Ctrl + Delete
  "\x1b[3;3~": "delete", // Alt + Delete
  "\x1b[3;4~": "delete", // Shift + Alt + Delete
  "\x1b[3;6~": "delete", // Ctrl + Shift + Delete
  "\x1b[3;7~": "delete", // Ctrl + Alt + Delete
  "\x1b[3;8~": "delete", // Ctrl + Shift + Alt + Delete

  // Ink/Standard Delete
  "\x1b[3~": "delete",

  // Alternative codes sometimes seen
  "\x1b[3^": "delete", // Ctrl + Delete (urxvt)
  "\x1b[3$": "delete", // Shift + Delete (urxvt)
  "\x1b[3@": "delete", // Ctrl + Shift + Delete (urxvt)

  // Backspace modifiers
  // \x7f is standard backspace on many systems (DEL char but acts as BS)
  // \x08 is Ctrl+H, often BS
  "\x1b\x7f": "backspace", // Alt + Backspace or Meta + Backspace
  "\x1b\x08": "backspace", // Alt + Ctrl + H
  "\x17": "backspace", // Ctrl + W (often used as Ctrl+Backspace)

  // Ctrl+D is often Delete
  "\x04": "delete",
  "\x1b\x04": "delete", // Meta+Ctrl+D
  "\x1bd": "delete", // Often sent by Ctrl+Delete or Alt+D

  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home", // Alternative Home
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end", // Alternative End
  // "\x1b[3~": "delete", // Duplicate removal
  "\x1b[Z": "tab", // Shift + Tab
};

/**
A custom version of Ink's useInput that correctly handles Home/End keys
and fixes Backspace/Delete issues on Windows.
*/
export const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const handlerRef = useRef(inputHandler);
  handlerRef.current = inputHandler;

  useLayoutEffect(() => {
    if (options.isActive === false || !stdin) {
      return;
    }

    setRawMode(true);
    if (options.enableMouse) {
      enableMouseMode(stdout);
    }

    const handleData = (data: Buffer) => {
      const fullStr = data.toString();
      const parts = splitInputSequences(fullStr);

      for (const s of parts) {
        if (s.length === 0) continue;

        const key: Key = {
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
          return: false,
          escape: false,
          ctrl: false,
          shift: false,
          tab: false,
          backspace: false,
          delete: false,
          meta: false,
          home: false,
          end: false,
          mouseWheelUp: false,
          mouseWheelDown: false,
          mouseLeft: false,
          mouseMove: false,
          mouseX: undefined,
          mouseY: undefined,
        };

        let input = s;

        // Handle standard control characters
        if (s === "\r" || s === "\n") {
          key.return = true;
        } else if (s === "\t") {
          key.tab = true;
        } else if (s === "\x08" || s === "\x7f") {
          // \x08 is Ctrl+H (Backspace), \x7f is DEL (often Backspace)
          key.backspace = true;
        } else if (s === "\x1b" || s === "\x1b\x1b") {
          key.escape = true;
          key.meta = s.length === 2;
        } else if (s === " " || s === "\x1b ") {
          // Space
          // input is " " or "\x1b "
          key.meta = s.length === 2;
        } else if (keyName[s]) {
          // Known escape sequence
          const name = keyName[s];
          key.upArrow = name === "up";
          key.downArrow = name === "down";
          key.leftArrow = name === "left";
          key.rightArrow = name === "right";
          key.pageUp = name === "pageup";
          key.pageDown = name === "pagedown";
          key.home = name === "home";
          key.end = name === "end";
          key.delete = name === "delete";
          key.backspace = name === "backspace";

          // If it starts with ESC but NOT with ESC[, it's likely a Alt/Meta + key combination
          // Standard CSI sequences like \x1b[3~ should NOT set key.meta by default
          if (s.startsWith("\x1b") && !s.startsWith("\x1b[")) {
            key.meta = true;
          }
        } else if (s.startsWith("\x1b[<")) {
          // SGR mouse mode: \x1b[<Cb;Cx;CyM
          // deno-lint-ignore no-control-regex -- ESC (\x1b) is required for ANSI SGR mouse sequence parsing.
          const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(s);
          if (match) {
            const buttonCode = Number(match[1]);
            const baseCode = buttonCode & ~0b11100;
            const x = Number(match[2]);
            const y = Number(match[3]);
            const eventType = match[4];
            key.mouseX = x;
            key.mouseY = y;
            key.shift = (buttonCode & 0b00100) !== 0;
            key.meta = (buttonCode & 0b01000) !== 0;
            key.ctrl = (buttonCode & 0b10000) !== 0;
            key.mouseWheelUp = baseCode === 64;
            key.mouseWheelDown = baseCode === 65;
            key.mouseLeft = eventType === "M" &&
              (baseCode & 0b11) === 0 &&
              (baseCode & 0b100000) === 0 &&
              baseCode < 64;
            key.mouseMove = eventType === "M" && !key.mouseLeft &&
              !key.mouseWheelUp && !key.mouseWheelDown;
            // Mouse packets are control sequences, never text input.
            input = "";
          }
        } else if (s.startsWith("\x1b[M") && s.length >= 6) {
          // X10 mouse mode: \x1b[M Cb Cx Cy (3 bytes encoded with +32)
          const buttonCode = s.charCodeAt(3) - 32;
          const baseCode = buttonCode & ~0b11100;
          key.mouseX = s.charCodeAt(4) - 32;
          key.mouseY = s.charCodeAt(5) - 32;
          key.shift = (buttonCode & 0b00100) !== 0;
          key.meta = (buttonCode & 0b01000) !== 0;
          key.ctrl = (buttonCode & 0b10000) !== 0;
          key.mouseWheelUp = baseCode === 64;
          key.mouseWheelDown = baseCode === 65;
          key.mouseLeft = baseCode === 0;
          key.mouseMove = baseCode === 3;
          // Mouse packets are control sequences, never text input.
          input = "";
        } else if (s.length === 1 && s <= "\x1a") {
          // Ctrl + letter (A-Z)
          // s.charCodeAt(0) between 1 and 26
          input = String.fromCharCode(s.charCodeAt(0) + "a".charCodeAt(0) - 1);
          key.ctrl = true;
          // Map common ctrl codes to named keys if not handled above
          if (input === "h") key.backspace = true; // Ctrl+H
          if (input === "i") key.tab = true; // Ctrl+I
          if (input === "m") key.return = true; // Ctrl+M
        } else if (s.startsWith("\x1b")) {
          // Meta + character?
          // e.g. \x1b\x7f (Alt+Backspace), \x1ba (Alt+a)
          if (s.length === 2) {
            key.meta = true;
            // The second character is the key
            const char = s[1];
            if (char === "\x7f" || char === "\x08") {
              key.backspace = true;
            } else {
              input = char;
              if (/[A-Z]/.test(char)) key.shift = true;
            }
          }
        }

        // Modifier detection from escape sequences (redundant for named keys but useful for flags)
        // Check for Shift+Arrow keys
        if (
          [
            "\x1b[1;2A",
            "\x1b[1;2B",
            "\x1b[1;2C",
            "\x1b[1;2D",
            "\x1b[1;4A",
            "\x1b[1;4B",
            "\x1b[1;4C",
            "\x1b[1;4D",
            "\x1b[1;6A",
            "\x1b[1;6B",
            "\x1b[1;6C",
            "\x1b[1;6D",
            "\x1b[1;8A",
            "\x1b[1;8B",
            "\x1b[1;8C",
            "\x1b[1;8D",
            "\x1b[3;2~",
            "\x1b[3;4~",
            "\x1b[3;6~",
            "\x1b[3;8~",
            "\x1b[3$",
            "\x1b[3@",
            "\x1b[Z", // Shift+Tab
          ].includes(s)
        ) {
          key.shift = true;
        }

        // Check for Ctrl keys (Arrow, Delete, Backspace via Ctrl+H handled above)
        if (
          [
            "\x1b[1;5A",
            "\x1b[1;5B",
            "\x1b[1;5C",
            "\x1b[1;5D",
            "\x1b[1;6A",
            "\x1b[1;6B",
            "\x1b[1;6C",
            "\x1b[1;6D",
            "\x1b[1;7A",
            "\x1b[1;7B",
            "\x1b[1;7C",
            "\x1b[1;7D",
            "\x1b[1;8A",
            "\x1b[1;8B",
            "\x1b[1;8C",
            "\x1b[1;8D",
            "\x1b[3;5~",
            "\x1b[3;6~",
            "\x1b[3;7~",
            "\x1b[3;8~",
            "\x1b[3^",
            "\x1b[3@",
            "\x17", // Ctrl+W
            "\x1b\x08", // Alt+Ctrl+H
            "\x04", // Ctrl+D
            "\x1b\x04",
            "\x1bd",
          ].includes(s)
        ) {
          key.ctrl = true;
        }

        // Check for Meta/Alt keys
        if (
          key.meta || // already detected
          [
            "\x1b[1;3A",
            "\x1b[1;3B",
            "\x1b[1;3C",
            "\x1b[1;3D",
            "\x1b[1;9A",
            "\x1b[1;9B",
            "\x1b[1;9C",
            "\x1b[1;9D",
            "\x1b[1;4A",
            "\x1b[1;4B",
            "\x1b[1;4C",
            "\x1b[1;4D",
            "\x1b[1;7A",
            "\x1b[1;7B",
            "\x1b[1;7C",
            "\x1b[1;7D",
            "\x1b[1;8A",
            "\x1b[1;8B",
            "\x1b[1;8C",
            "\x1b[1;8D",
            "\x1b[3;3~",
            "\x1b[3;4~",
            "\x1b[3;7~",
            "\x1b[3;8~",
            "\x1b\x7f",
            "\x1b\x08",
            "\x1bd",
          ].includes(s)
        ) {
          key.meta = true;
        }

        if (input.length === 1 && /[A-Z]/.test(input)) {
          key.shift = true;
        }

        const isMouseEvent = key.mouseWheelUp || key.mouseWheelDown ||
          key.mouseLeft || key.mouseMove;
        if (isMouseEvent && !options.enableMouse) {
          continue;
        }

        handlerRef.current(input, key);
      }
    };

    stdin.on("data", handleData);

    return () => {
      stdin.off("data", handleData);
      if (options.enableMouse) {
        disableMouseMode(stdout);
      }
      setRawMode(false);
    };
  }, [options.isActive, options.enableMouse, stdin, setRawMode, stdout]);
};

const splitInputSequences = (input: string): string[] => {
  const parts: string[] = [];
  let index = 0;

  while (index < input.length) {
    if (input[index] === "\x1b") {
      if (input.startsWith("\x1b[<", index)) {
        const suffixIndex = input.slice(index).search(/[mM]/);
        if (suffixIndex >= 0) {
          const end = index + suffixIndex + 1;
          parts.push(input.slice(index, end));
          index = end;
          continue;
        }
      }

      if (input.startsWith("\x1b[M", index) && index + 6 <= input.length) {
        parts.push(input.slice(index, index + 6));
        index += 6;
        continue;
      }

      const knownEscapeSequence = ESCAPE_SEQUENCES.find((sequence) =>
        input.startsWith(sequence, index)
      );
      if (knownEscapeSequence) {
        parts.push(knownEscapeSequence);
        index += knownEscapeSequence.length;
        continue;
      }

      if (index + 1 < input.length && input[index + 1] !== "[") {
        parts.push(input.slice(index, index + 2));
        index += 2;
        continue;
      }

      parts.push("\x1b");
      index += 1;
      continue;
    }

    let end = index;
    while (end < input.length && input[end] !== "\x1b") {
      end++;
    }

    const chunk = input.slice(index, end);
    const hasPrintableContent = Array.from(chunk).some((char) =>
      !SIMPLE_CONTROL_INPUTS.has(char)
    );
    if (hasPrintableContent) {
      parts.push(chunk);
    } else {
      parts.push(...Array.from(chunk));
    }
    index = end;
  }

  return parts;
};

const SIMPLE_CONTROL_INPUTS = new Set(["\r", "\n", "\t", "\x08", "\x7f"]);
const ESCAPE_SEQUENCES = Object.keys(keyName).sort((a, b) =>
  b.length - a.length
);
