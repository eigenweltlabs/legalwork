import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { cn } from "../utils/cn";

type Tone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: Tone;
  /** ms before auto-dismiss; 0 = sticky. */
  duration?: number;
  action?: React.ReactNode;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

const toneIcon: Record<Tone, React.ReactNode> = {
  neutral: <Info className="size-[18px] text-brand" />,
  success: <CheckCircle2 className="size-[18px] text-success" />,
  warning: <TriangleAlert className="size-[18px] text-warning" />,
  danger: <XCircle className="size-[18px] text-danger" />,
};

const ToastContext = createContext<{ toast: (o: ToastOptions) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

/** Presentational toast card (also used standalone). */
export function Toast({
  title,
  description,
  tone = "neutral",
  action,
  onClose,
}: ToastOptions & { onClose?: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex w-80 items-start gap-3 rounded-2xl border border-subtle bg-surface p-3.5 shadow-lg",
        "animate-[lw-toast-in_180ms_var(--lw-ease-out)]",
      )}
    >
      <span className="mt-0.5 shrink-0">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-ink">{title}</div>
        {description ? <div className="mt-0.5 text-sm text-subtext">{description}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 rounded-md p-0.5 text-tertiary transition-colors hover:bg-hover hover:text-ink"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (o: ToastOptions) => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { ...o, id }]);
      const duration = o.duration ?? 4000;
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[120] flex flex-col items-end gap-2.5">
        {items.map((t) => (
          <Toast key={t.id} {...t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
