import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ToastContainer } from "../components/Toast";
import {
  type Toast,
  type ToastAction,
  isPriorityToast,
} from "../hooks/useToast";
import { generateUUID } from "../lib/uuid";

interface ToastContextValue {
  showToast: (
    message: string,
    type?: Toast["type"],
    action?: ToastAction,
  ) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (message: string, type: Toast["type"] = "info", action?: ToastAction) => {
      const toast = { id: generateUUID(), message, type, action };
      setToasts((previous) => [
        ...(isPriorityToast(toast)
          ? previous
          : previous.filter(isPriorityToast)),
        toast,
      ]);
    },
    [],
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ showToast, dismissToast }),
    [dismissToast, showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

/**
 * Hook to access toast functionality from any component.
 * Must be used within a ToastProvider.
 */
export function useToastContext() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToastContext must be used within a ToastProvider");
  }
  return context;
}

export function useOptionalToastContext() {
  return useContext(ToastContext);
}
