import { useRef } from "react";
import { Key, useInput } from "./useInput.ts";

export type MouseEvent = {
  wheelUp: boolean;
  wheelDown: boolean;
  leftClick: boolean;
  x?: number;
  y?: number;
  raw: Key;
};

type Options = {
  isActive?: boolean;
};

export const useMouseInput = (
  handler: (event: MouseEvent) => void,
  options: Options = {},
) => {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useInput((_input, key) => {
    const hasMouseEvent = key.mouseWheelUp || key.mouseWheelDown ||
      key.mouseLeft;
    if (!hasMouseEvent) return;

    handlerRef.current({
      wheelUp: key.mouseWheelUp,
      wheelDown: key.mouseWheelDown,
      leftClick: key.mouseLeft,
      x: key.mouseX,
      y: key.mouseY,
      raw: key,
    });
  }, { isActive: options.isActive, enableMouse: true });
};
