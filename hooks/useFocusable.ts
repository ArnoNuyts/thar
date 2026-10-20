import { useLayoutEffect, useState } from "react";
import { useFocusManager } from "../contexts/focus-context.tsx";

export interface UseFocusableOptions {
  autoFocus?: boolean;
  tag?: string;
}

export const useFocusable = (opts: UseFocusableOptions = {}) => {
  // The focus identity must stay stable for the lifetime of the component:
  // the id is used as the key in the focus stack and in the effect below.
  // The tag only labels the id for debugging, so capture it on mount instead
  // of listing it as a dependency (which would silently change the identity,
  // release focus, and re-request it whenever the tag changed).
  const [id] = useState(() => Symbol(opts.tag || "focusable"));
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
