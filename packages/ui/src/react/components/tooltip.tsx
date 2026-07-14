import { useId, useRef, useState } from "react";
import { cn } from "../utils/cn";

export interface TooltipProps {
  label: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  /** Delay before showing, ms. */
  delay?: number;
  className?: string;
}

const sideClasses = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
  left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
  right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
} as const;

/**
 * Lightweight hover/focus tooltip. Wraps a single trigger element; positioning
 * is anchor-relative (no collision flipping).
 */
export function Tooltip({ label, children, side = "top", delay = 250, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = () => {
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={hide}
    >
      <span aria-describedby={open ? id : undefined} className="contents">
        {children}
      </span>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={cn(
            "pointer-events-none absolute z-[60] whitespace-nowrap rounded-lg bg-primary px-2 py-1 text-xs font-medium text-primary-fg shadow-md",
            "animate-[lw-fade-in_100ms_var(--lw-ease-out)]",
            sideClasses[side],
            className,
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
