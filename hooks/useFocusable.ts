import { useLayoutEffect, useMemo } from "react";
import { useFocusManager } from "../contexts/focus-context.tsx";

export interface UseFocusableOptions {
  autoFocus?: boolean;
  tag?: string;
}

export const useFocusable = (opts: UseFocusableOptions = {}) => {
  const id = useMemo(() => Symbol(opts.tag || "focusable"), []);
  const { requestFocus, releaseFocus, activeId } = useFocusManager();

  const autoFocus = opts.autoFocus ?? false;

  useLayoutEffect(() => {
    if (autoFocus) requestFocus(id);
    return () => releaseFocus(id);
  }, [id, autoFocus, requestFocus, releaseFocus]);

  const isFocused = activeId === id;
  const focus = () => requestFocus(id);
  const blur = () => releaseFocus(id);

  return { id, isFocused, focus, blur };
};
