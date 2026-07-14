import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../utils/cn";
import { IconButton } from "./icon-button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Panel width. */
  size?: "sm" | "md" | "lg";
  /** Hide the default close (X) button. */
  hideClose?: boolean;
  className?: string;
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
} as const;

/** Centered dialog with a scrim. Closes on Escape and backdrop click. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose,
  className,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-overlay animate-[lw-fade-in_140ms_var(--lw-ease-out)]"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative w-full rounded-3xl border border-subtle bg-surface shadow-lg",
          "animate-[lw-scale-in_160ms_var(--lw-ease-out)]",
          sizes[size],
          className,
        )}
      >
        {!hideClose ? (
          <IconButton
            aria-label="Close"
            variant="ghost"
            size="sm"
            className="absolute right-3 top-3"
            onClick={onClose}
          >
            <X />
          </IconButton>
        ) : null}
        {title || description ? (
          <div className="px-6 pb-2 pt-6 pr-12">
            {title ? <h2 className="text-lg font-semibold text-ink">{title}</h2> : null}
            {description ? (
              <p className="mt-1 text-base leading-relaxed text-subtext">{description}</p>
            ) : null}
          </div>
        ) : null}
        {children ? <div className="px-6 py-3">{children}</div> : null}
        {footer ? (
          <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-3">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
