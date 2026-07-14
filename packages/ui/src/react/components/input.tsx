import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Leading adornment (icon). */
  leading?: React.ReactNode;
  /** Trailing adornment (icon / button). */
  trailing?: React.ReactNode;
  /** Visual size. */
  inputSize?: "sm" | "md" | "lg";
  invalid?: boolean;
}

const sizeMap = {
  sm: "h-8 text-sm rounded-lg",
  md: "h-9 text-base rounded-lg",
  lg: "h-11 text-md rounded-xl",
} as const;

/**
 * Text input with an optional leading/trailing adornment. The wrapper carries
 * the border + focus ring so adornments sit inside the field, matching the
 * "search plugins" and settings fields in the reference.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, leading, trailing, inputSize = "md", invalid, disabled, ...rest },
  ref,
) {
  return (
    <div
      className={cn(
        "group/input flex items-center gap-2 bg-surface border transition-[border-color,box-shadow] duration-[var(--lw-duration-fast)] ease-standard",
        "border-line hover:border-strong",
        "focus-within:border-brand focus-within:ring-2 focus-within:ring-[var(--lw-focus-ring)]",
        invalid && "border-danger focus-within:border-danger focus-within:ring-[var(--lw-danger-soft)]",
        disabled && "opacity-55 pointer-events-none",
        sizeMap[inputSize],
        inputSize === "lg" ? "px-3.5" : "px-3",
        className,
      )}
    >
      {leading ? (
        <span className="shrink-0 text-tertiary [&_svg]:size-4">{leading}</span>
      ) : null}
      <input
        ref={ref}
        disabled={disabled}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-ink placeholder:text-placeholder",
          "outline-none border-0 focus:outline-none focus:ring-0",
        )}
        {...rest}
      />
      {trailing ? (
        <span className="shrink-0 text-tertiary [&_svg]:size-4">{trailing}</span>
      ) : null}
    </div>
  );
});
