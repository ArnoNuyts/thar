import { useRef } from "react";
import { useFocusable, UseFocusableOptions } from "./useFocusable.ts";
import { Key, useInput } from "./useInput.ts";

export type ExtendedKey = Key;

export const useFocusedInput = (
  handler: (input: string, key: Key) => void,
  options: UseFocusableOptions = {},
) => {
  const { isFocused } = useFocusable(options);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useInput((input, key) => {
    if (!isFocused) return;
    handlerRef.current(input, key);
  }, { isActive: isFocused });

  return { isFocused };
};
