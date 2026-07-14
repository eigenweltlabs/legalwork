import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

/**
 * Spinner — a circular loading indicator.
 *
 * Renders an SVG track + rotating arc (stroke via currentColor). Pair with a
 * visually-hidden `label` so screen readers announce the busy state.
 */
const spinner = cva("inline-flex shrink-0 items-center justify-center", {
  variants: {
    size: {
      sm: "size-4",
      md: "size-5",
      lg: "size-6",
    },
    tone: {
      default: "text-current",
      brand: "text-brand",
      subtle: "text-subtext",
    },
  },
  defaultVariants: { size: "md", tone: "default" },
});

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinner> {
  /** Accessible status text — visually hidden, announced to assistive tech. */
  label?: string;
}

export const Spinner = forwardRef<HTMLSpanElement, SpinnerProps>(function Spinner(
  { className, size, tone, label = "Loading", ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className={cn(spinner({ size, tone }), className)}
      {...rest}
    >
      <svg
        className="size-full animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="2.5"
          className="opacity-20"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
});

/**
 * Dots — a three-dot "thinking" ticker. The dots pulse in sequence via a
 * staggered animation delay, using the inherited text color (bg-current).
 */
export interface DotsProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Accessible status text — visually hidden, announced to assistive tech. */
  label?: string;
}

export const Dots = forwardRef<HTMLSpanElement, DotsProps>(function Dots(
  { className, label = "Thinking", ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      role="status"
      aria-label={label}
      className={cn("inline-flex items-center gap-1", className)}
      {...rest}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${i * 160}ms`, animationDuration: "1s" }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
});
