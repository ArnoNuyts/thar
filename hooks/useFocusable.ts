import { useEffect, useMemo } from "react";
import { useFocusManager } from "../contexts/focus-context.tsx";

export interface UseFocusableOptions {
  autoFocus?: boolean;
}

export const useFocusable = (opts: UseFocusableOptions = {}) => {
  const id = useMemo(() => Symbol("focusable"), []);
  const { requestFocus, releaseFocus, activeId } = useFocusManager();

  const autoFocus = opts.autoFocus ?? false;

  useEffect(() => {
    if (autoFocus) requestFocus(id);
    return () => releaseFocus(id);
  }, [id, autoFocus, requestFocus, releaseFocus]);

  const isFocused = activeId === id;
  const focus = () => requestFocus(id);
  const blur = () => releaseFocus(id);

  return { id, isFocused, focus, blur };
};
