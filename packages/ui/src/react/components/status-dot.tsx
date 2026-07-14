import { forwardRef, type CSSProperties } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

type Tone = "success" | "warning" | "danger" | "neutral" | "brand";

/**
 * Tones that map cleanly to a `bg-*` token get a class; the remaining tones
 * (warning, neutral) have no `bg-*` utility, so we drive them via an inline
 * `background-color` from the raw design-token CSS variable.
 */
const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success",
  danger: "bg-danger",
  brand: "bg-brand",
  warning: "",
  neutral: "",
};

const TONE_VAR: Partial<Record<Tone, string>> = {
  warning: "var(--lw-warning)",
  neutral: "var(--lw-text-tertiary)",
};

const wrap = cva("relative inline-flex items-center", {
  variants: {
    size: {
      sm: "gap-1.5",
      md: "gap-2",
    },
  },
  defaultVariants: { size: "md" },
});

const dot = cva("relative inline-block shrink-0 rounded-full", {
  variants: {
    size: {
      sm: "size-1.5",
      md: "size-2",
    },
  },
  defaultVariants: { size: "md" },
});

export interface StatusDotProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color">,
    VariantProps<typeof wrap> {
  /** Color of the indicator. */
  tone?: Tone;
  /** Optional trailing label. */
  label?: React.ReactNode;
  /** Animate a soft ping ring behind the dot (use for "live" state). */
  pulse?: boolean;
}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  function StatusDot(
    { className, tone = "neutral", size = "md", label, pulse, ...rest },
    ref,
  ) {
    const toneClass = TONE_CLASS[tone];
    const toneStyle: CSSProperties | undefined = TONE_VAR[tone]
      ? { backgroundColor: TONE_VAR[tone] }
      : undefined;

    return (
      <span ref={ref} className={cn(wrap({ size }), className)} {...rest}>
        <span className={cn(dot({ size }))}>
          {pulse ? (
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 rounded-full opacity-70 animate-ping",
                toneClass,
              )}
              style={toneStyle}
            />
          ) : null}
          <span
            aria-hidden
            className={cn("absolute inset-0 rounded-full", toneClass)}
            style={toneStyle}
          />
        </span>
        {label != null ? (
          <span className="text-sm text-subtext">{label}</span>
        ) : null}
      </span>
    );
  },
);
