import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

interface Position {
  left: number;
  top: number;
}

interface SuggestionContextType {
  suggestions: string[];
  setSuggestions: (suggestions: string[]) => void;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  type: "project" | "context" | null;
  setType: (type: "project" | "context" | null) => void;
  position: Position;
  setPosition: (position: Position) => void;
  clearSuggestions: () => void;
}

const SuggestionContext = createContext<SuggestionContextType | undefined>(
  undefined,
);

export const SuggestionProvider = ({ children }: { children: ReactNode }) => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [type, setType] = useState<"project" | "context" | null>(null);
  const [position, setPosition] = useState<Position>({ left: 0, top: 0 });

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setSelectedIndex(0);
    setType(null);
  }, []);

  const value = useMemo(
    () => ({
      suggestions,
      setSuggestions,
      selectedIndex,
      setSelectedIndex,
      type,
      setType,
      position,
      setPosition,
      clearSuggestions,
    }),
    [
      suggestions,
      setSuggestions,
      selectedIndex,
      setSelectedIndex,
      type,
      setType,
      position,
      setPosition,
      clearSuggestions,
    ],
  );

  return (
    <SuggestionContext.Provider value={value}>
      {children}
    </SuggestionContext.Provider>
  );
};

export const useSuggestion = () => {
  const context = useContext(SuggestionContext);
  if (!context) {
    throw new Error("useSuggestion must be used within a SuggestionProvider");
  }
  return context;
};
