import { useId, useState } from "react";
import { cn } from "../utils/cn";

export interface SliderProps {
  value?: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number) => void;
  disabled?: boolean;
  /** "solid" = accent fill; "aurora" = animated blue gradient (reasoning slider). */
  variant?: "solid" | "aurora";
  className?: string;
  "aria-label"?: string;
}

/**
 * Single-thumb slider. The `aurora` variant renders the animated blue gradient
 * fill used by the reasoning-effort control in the reference.
 */
export function Slider({
  value,
  defaultValue = 50,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  disabled,
  variant = "solid",
  className,
  ...aria
}: SliderProps) {
  const id = useId();
  const [internal, setInternal] = useState(defaultValue);
  const current = value !== undefined ? value : internal;
  const pct = ((current - min) / (max - min)) * 100;

  return (
    <div className={cn("relative flex h-5 w-full items-center", disabled && "opacity-50", className)}>
      {/* track */}
      <div className="absolute inset-x-0 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className={cn(
            "h-full rounded-full",
            variant === "aurora"
              ? "bg-[linear-gradient(90deg,#083f8a,#0a58c2_45%,#3b82db)] bg-[length:200%_100%] animate-[lw-aurora_3s_linear_infinite]"
              : "bg-brand",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* thumb */}
      <div
        className="pointer-events-none absolute z-10 size-[18px] -translate-x-1/2 rounded-full border border-black/5 bg-white shadow-sm"
        style={{ left: `${pct}%` }}
      />
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        aria-label={aria["aria-label"]}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (value === undefined) setInternal(next);
          onValueChange?.(next);
        }}
        className="absolute inset-0 z-20 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}
