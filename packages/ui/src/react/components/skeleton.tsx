import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

/**
 * Skeleton loading placeholder. A sunken bar with a subtle shimmer pulse.
 * Defaults to a block; the caller sets dimensions via className (e.g. `h-4 w-32`).
 */
export const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  function Skeleton({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn(
          "block h-4 w-full animate-pulse overflow-hidden rounded-md bg-sunken",
          className,
        )}
        {...rest}
      />
    );
  },
);

export interface SkeletonTextProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of stacked skeleton lines to render. */
  lines?: number;
}

/** Varied line widths so a text block reads naturally instead of a uniform grid. */
const LINE_WIDTHS = ["w-full", "w-11/12", "w-10/12", "w-9/12", "w-8/12"];

/**
 * A stack of skeleton lines with varied widths, approximating a paragraph.
 * The last line is always shortest to mimic a trailing sentence.
 */
export const SkeletonText = forwardRef<HTMLDivElement, SkeletonTextProps>(
  function SkeletonText({ className, lines = 3, ...rest }, ref) {
    const count = Math.max(1, lines);
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn("flex flex-col gap-2", className)}
        {...rest}
      >
        {Array.from({ length: count }, (_, i) => (
          <Skeleton
            key={i}
            className={cn(
              "h-3.5",
              i === count - 1
                ? "w-7/12"
                : LINE_WIDTHS[i % LINE_WIDTHS.length],
            )}
          />
        ))}
      </div>
    );
  },
);
