import { useEffect, useRef } from "react";
import { Key, useInput, useStdin } from "ink";
import { useFocusable, UseFocusableOptions } from "./useFocusable.ts";
import { Buffer } from "node:buffer";

export interface ExtendedKey extends Key {
  home?: boolean;
  end?: boolean;
}

export const useFocusedInput = (
  handler: (input: string, key: ExtendedKey) => void,
  options: UseFocusableOptions = {},
) => {
  const { isFocused } = useFocusable(options);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { stdin } = useStdin();

  useEffect(() => {
    if (!stdin || !isFocused) return;

    const onData = (data: Buffer) => {
      const seq = data.toString();

      if (seq === "\x1b[H") {
        handlerRef.current("", {
          home: true,
          return: false,
          escape: false,
          backspace: false,
          delete: false,
          tab: false,
          shift: false,
          meta: false,
          ctrl: false,
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
        });
      } else if (seq === "\x1b[F") {
        handlerRef.current("", {
          end: true,
          return: false,
          escape: false,
          backspace: false,
          delete: false,
          tab: false,
          shift: false,
          meta: false,
          ctrl: false,
          upArrow: false,
          downArrow: false,
          leftArrow: false,
          rightArrow: false,
          pageDown: false,
          pageUp: false,
        });
      }
    };

    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin, isFocused]);

  useInput((input, key) => {
    if (!isFocused) return;
    handlerRef.current(input, key);
  });

  return { isFocused };
};
