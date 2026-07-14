import { forwardRef, useState } from "react";
import { cn } from "../utils/cn";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

const track = {
  sm: "h-[18px] w-[30px]",
  md: "h-[22px] w-[38px]",
} as const;
const thumb = {
  sm: "size-[14px]",
  md: "size-[18px]",
} as const;
const travel = {
  sm: "translate-x-[12px]",
  md: "translate-x-[16px]",
} as const;

/** iOS-style toggle. Off = neutral track, on = interactive blue. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked, onCheckedChange, disabled, size = "md", className, ...aria },
  ref,
) {
  const [internal, setInternal] = useState(defaultChecked ?? false);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : internal;

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        const next = !on;
        if (!isControlled) setInternal(next);
        onCheckedChange?.(next);
      }}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full p-[2px]",
        "transition-colors duration-[var(--lw-duration-base)] ease-standard",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
        on ? "bg-brand" : "bg-gray-300",
        disabled && "cursor-not-allowed opacity-50",
        track[size],
        className,
      )}
      {...aria}
    >
      <span
        className={cn(
          "pointer-events-none rounded-full bg-white shadow-sm",
          "transition-transform duration-[var(--lw-duration-base)] ease-spring",
          thumb[size],
          on ? travel[size] : "translate-x-0",
        )}
      />
    </button>
  );
});
