import { forwardRef, useState } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "../utils/cn";

export interface CheckboxProps {
  /** Controlled checked state. */
  checked?: boolean;
  /** Initial checked state for uncontrolled usage. */
  defaultChecked?: boolean;
  /** Fires with the next boolean state on toggle. */
  onCheckedChange?: (checked: boolean) => void;
  /** Renders the mixed/indeterminate state (a minus glyph). Purely visual. */
  indeterminate?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

const box = {
  sm: "size-4",
  md: "size-5",
} as const;
const glyph = {
  sm: "size-3",
  md: "size-3.5",
} as const;

/** Square boolean checkbox. Off = hairline box, on/indeterminate = interactive blue fill. */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    checked,
    defaultChecked,
    onCheckedChange,
    indeterminate,
    disabled,
    size = "md",
    className,
    ...aria
  },
  ref,
) {
  const [internal, setInternal] = useState(defaultChecked ?? false);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : internal;
  const filled = on || indeterminate;

  return (
    <button
      ref={ref}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : on}
      disabled={disabled}
      onClick={() => {
        const next = !on;
        if (!isControlled) setInternal(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] border",
        "transition-[background-color,border-color,box-shadow,transform] duration-[var(--lw-duration-fast)] ease-standard",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
        "active:scale-[0.94]",
        filled ? "bg-brand border-brand" : "bg-surface border-strong hover:bg-surface-hover",
        disabled && "cursor-not-allowed opacity-50",
        box[size],
        className,
      )}
      {...aria}
    >
      {indeterminate ? (
        <Minus className={cn("text-brand-fg", glyph[size])} strokeWidth={3} />
      ) : on ? (
        <Check className={cn("text-brand-fg", glyph[size])} strokeWidth={3} />
      ) : null}
    </button>
  );
});
