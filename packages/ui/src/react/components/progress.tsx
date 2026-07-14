import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

/**
 * Progress — a determinate (or indeterminate) linear progress bar.
 *
 * A sunken pill-shaped track holds a filled inner bar whose width tracks
 * `value / max`. When `indeterminate` is set, an animated segment slides
 * across the track instead (width/value are ignored for aria purposes).
 *
 * tone maps the fill color:
 *  - brand    interactive blue (default)
 *  - success  green
 *  - warning  amber
 *  - danger   red
 */
const progressFill = cva("h-full rounded-full", {
  variants: {
    tone: {
      brand: "bg-brand",
      success: "bg-success",
      warning: "bg-warning",
      danger: "bg-danger",
    },
  },
  defaultVariants: { tone: "brand" },
});

/**
 * Indeterminate stripe. A repeating gradient whose colored band is surrounded by
 * transparency; the shared `lw-aurora` keyframe slides `background-position`, so
 * the band travels across the track. `bg-current` inherits the tone color.
 */
const indeterminateStripe =
  "h-full w-full rounded-full text-current " +
  "bg-[linear-gradient(90deg,transparent_0%,currentColor_20%,currentColor_45%,transparent_65%,transparent_100%)] " +
  "bg-[length:250%_100%] bg-no-repeat animate-[lw-aurora_1.15s_linear_infinite]";

const indeterminateTone = cva(indeterminateStripe, {
  variants: {
    tone: {
      brand: "text-brand",
      success: "text-success",
      warning: "text-warning",
      danger: "text-danger",
    },
  },
  defaultVariants: { tone: "brand" },
});

export interface ProgressProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children">,
    VariantProps<typeof progressFill> {
  /** Current progress, 0..max. Ignored when `indeterminate`. */
  value?: number;
  /** Upper bound of `value`. */
  max?: number;
  /** Track height. */
  size?: "sm" | "md";
  /** Render a looping animated segment instead of a determinate fill. */
  indeterminate?: boolean;
}

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { className, value = 0, max = 100, tone, size = "md", indeterminate, ...rest },
  ref,
) {
  const clamped = Math.min(Math.max(value, 0), max);
  const pct = max > 0 ? (clamped / max) * 100 : 0;

  return (
    <div
      ref={ref}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
      className={cn(
        "w-full overflow-hidden rounded-full bg-sunken",
        size === "sm" ? "h-1.5" : "h-2",
        className,
      )}
      {...rest}
    >
      {indeterminate ? (
        <div className={cn(indeterminateTone({ tone }))} />
      ) : (
        <div
          className={cn(
            progressFill({ tone }),
            "transition-[width] duration-[var(--lw-duration-fast)] ease-standard",
          )}
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
});

export { progressFill as progressVariants };
