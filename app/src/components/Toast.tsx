import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  exiting: boolean;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const ICON: Record<ToastType, React.ReactNode> = {
  success: (
    <svg className="w-7 h-7 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  ),
  error: (
    <svg className="w-7 h-7 text-[var(--color-error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  info: (
    <svg className="w-7 h-7 text-[var(--color-primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type, exiting: false }]);

    // Start exit animation after 3.5s, remove after 4s
    setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    }, 3500);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={(id) => {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 500);
      }} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] flex flex-col items-center gap-3 pointer-events-none">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const borderColor =
    toast.type === "success"
      ? "rgba(34, 197, 94, 0.3)"
      : toast.type === "error"
        ? "rgba(239, 68, 68, 0.3)"
        : "rgba(37, 99, 235, 0.3)";

  const glowColor =
    toast.type === "success"
      ? "rgba(34, 197, 94, 0.15)"
      : toast.type === "error"
        ? "rgba(239, 68, 68, 0.15)"
        : "rgba(37, 99, 235, 0.15)";

  return (
    <div
      className={`pointer-events-auto flex items-center gap-4 px-6 py-4 rounded-xl cursor-pointer select-none ${
        toast.exiting ? "toast-exit" : "toast-enter"
      }`}
      style={{
        background: "rgba(17, 24, 39, 0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: `1.5px solid ${borderColor}`,
        boxShadow: `0 12px 48px rgba(0, 0, 0, 0.5), 0 0 30px ${glowColor}, 0 0 60px ${glowColor}`,
        minWidth: "280px",
        maxWidth: "450px",
      }}
      onClick={onDismiss}
    >
      {ICON[toast.type]}
      <span className="text-base font-medium text-[var(--color-text)]">{toast.message}</span>
    </div>
  );
}
