import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

interface ToasterContextType {
  toasterMessage: string | undefined;
  showToaster: (message: string) => void;
}

const ToasterContext = createContext<ToasterContextType | undefined>(undefined);

export const useToaster = () => {
  const context = useContext(ToasterContext);
  if (!context) {
    throw new Error("useToaster must be used within a ToasterProvider");
  }
  return context;
};

export const ToasterProvider = (
  { children }: { children: React.ReactNode },
) => {
  const [toasterMessage, setToasterMessage] = useState<string | undefined>(
    undefined,
  );
  const toasterTimeoutRef = useRef<number | undefined>(undefined);

  const showToaster = useCallback((message: string) => {
    setToasterMessage(message);
    if (toasterTimeoutRef.current) {
      clearTimeout(toasterTimeoutRef.current);
    }
    toasterTimeoutRef.current = setTimeout(() => {
      setToasterMessage(undefined);
    }, 2000);
  }, []);

  const value = useMemo(
    () => ({ toasterMessage, showToaster }),
    [toasterMessage, showToaster],
  );

  return (
    <ToasterContext.Provider value={value}>
      {children}
    </ToasterContext.Provider>
  );
};
