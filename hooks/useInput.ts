import { useEffect } from "react";
import { useStdin } from "ink";
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
};

type Handler = (input: string, key: Key) => void;

type Options = {
  /**
  Enable or disable capturing of user input. Useful when there are multiple `useInput` hooks used at once to avoid handling the same input several times.

  @default true
  */
  isActive?: boolean;
};

const keyName: Record<string, string> = {
  "\x1b[A": "up",
  "\x1bOA": "up",
  "\x1b[1;2A": "up", // Shift + Up
  "\x1b[B": "down",
  "\x1bOB": "down",
  "\x1b[1;2B": "down", // Shift + Down
  "\x1b[D": "left",
  "\x1bOD": "left",
  "\x1b[1;2D": "left", // Shift + Left
  "\x1b[C": "right",
  "\x1bOC": "right",
  "\x1b[1;2C": "right", // Shift + Right
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[H": "home",
  "\x1bOH": "home",
  "\x1b[1~": "home", // Alternative Home
  "\x1b[F": "end",
  "\x1bOF": "end",
  "\x1b[4~": "end", // Alternative End
  "\x1b[3~": "delete",
  "\x1b[Z": "tab", // Shift + Tab
};

/**
A custom version of Ink's useInput that correctly handles Home/End keys
and fixes Backspace/Delete issues on Windows.
*/
export const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    if (options.isActive === false || !stdin) {
      return;
    }

    setRawMode(true);

    const handleData = (data: Buffer) => {
      const s = data.toString();

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
      };

      let input = "";

      if (s === "\r" || s === "\n") {
        key.return = true;
      } else if (s === "\t") {
        key.tab = true;
      } else if (s === "\x1b[Z") {
        key.tab = true;
        key.shift = true;
      } else if (s === "\x08" || s === "\x7f") {
        // \x08 is Ctrl+H, \x7f is Backspace on Windows/Linux
        key.backspace = true;
      } else if (s === "\x1b" || s === "\x1b\x1b") {
        key.escape = true;
        key.meta = s.length === 2;
      } else if (keyName[s]) {
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
        
        // Check for Shift+Arrow keys
        if (["\x1b[1;2A", "\x1b[1;2B", "\x1b[1;2C", "\x1b[1;2D"].includes(s)) {
          key.shift = true;
        }
      } else if (s.length === 1 && s <= "\x1a") {
        // Ctrl + letter (except for handled ones like \r, \n, \t)
        input = String.fromCharCode(s.charCodeAt(0) + "a".charCodeAt(0) - 1);
        key.ctrl = true;
      } else {
        input = s;
      }

      if (input.length === 1 && /[A-Z]/.test(input)) {
        key.shift = true;
      }

      // Special case for Ctrl+C if you want to handle it manually or let it pass
      // if (input === 'c' && key.ctrl) process.exit(0);

      inputHandler(input, key);
    };

    stdin.on("data", handleData);

    return () => {
      stdin.off("data", handleData);
      setRawMode(false);
    };
  }, [options.isActive, stdin, setRawMode, inputHandler]);
};
