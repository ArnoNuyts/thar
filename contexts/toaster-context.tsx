import { createContext, useContext, useRef, useState } from "react";

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

  const showToaster = (message: string) => {
    setToasterMessage(message);
    if (toasterTimeoutRef.current) {
      clearTimeout(toasterTimeoutRef.current);
    }
    toasterTimeoutRef.current = setTimeout(() => {
      setToasterMessage(undefined);
    }, 2000);
  };

  return (
    <ToasterContext.Provider value={{ toasterMessage, showToaster }}>
      {children}
    </ToasterContext.Provider>
  );
};
