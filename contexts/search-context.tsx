import {
  createContext,
  MutableRefObject,
  ReactNode,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

export interface SearchContextType {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  focusRef: MutableRefObject<(() => void) | null>;
  isSearchFocused: boolean;
  setIsSearchFocused: (focused: boolean) => void;
}

const SearchContext = createContext<SearchContextType | undefined>(undefined);

export const SearchProvider = ({ children }: { children: ReactNode }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const focusRef = useRef<(() => void) | null>(null);

  const value = useMemo(
    () => ({
      searchQuery,
      setSearchQuery,
      focusRef,
      isSearchFocused,
      setIsSearchFocused,
    }),
    [
      searchQuery,
      setSearchQuery,
      focusRef,
      isSearchFocused,
      setIsSearchFocused,
    ],
  );

  return (
    <SearchContext.Provider value={value}>
      {children}
    </SearchContext.Provider>
  );
};

export const useSearch = () => {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error("useSearch must be used within a SearchProvider");
  }
  return context;
};
