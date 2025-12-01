import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";

interface FocusContextType {
  activeId: symbol | null;
  requestFocus: (id: symbol) => void;
  releaseFocus: (id: symbol) => void;
}

const FocusContext = createContext<FocusContextType | undefined>(undefined);

export const FocusProvider = ({ children }: { children?: ReactNode }) => {
  const [stack, setStack] = useState<symbol[]>([]);

  const requestFocus = useCallback((id: symbol) => {
    setStack((prev: symbol[]) => [...prev.filter((x: symbol) => x !== id), id]);
  }, []);

  const releaseFocus = useCallback((id: symbol) => {
    setStack((prev: symbol[]) => prev.filter((x: symbol) => x !== id));
  }, []);

  const activeId = stack[stack.length - 1] || null;

  return (
    <FocusContext.Provider value={{ activeId, requestFocus, releaseFocus }}>
      {children}
    </FocusContext.Provider>
  );
};

export const useFocusManager = () => {
  const context = useContext(FocusContext);
  if (!context) {
    throw new Error("useFocusManager must be used within a FocusProvider");
  }
  return context;
};
