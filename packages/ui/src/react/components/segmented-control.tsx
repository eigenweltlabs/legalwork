import { useId, useState } from "react";
import { cn } from "../utils/cn";

export interface SegmentedItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SegmentedControlProps<T extends string = string> {
  items: SegmentedItem<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  size?: "sm" | "md";
  /** Fill the container width, splitting segments evenly. */
  block?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Sunken-track segmented control (the Public / Eigenweltlabs / Personal and
 * Bottom / Right toggles in the reference). Selected segment lifts onto a
 * white pill with a hairline shadow.
 */
export function SegmentedControl<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  size = "md",
  block,
  className,
  ...aria
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const [internal, setInternal] = useState<T>(defaultValue ?? items[0]?.value);
  const active = value !== undefined ? value : internal;

  return (
    <div
      role="radiogroup"
      aria-label={aria["aria-label"]}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-xl bg-sunken p-0.5",
        block && "flex w-full",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === active;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            id={`${groupId}-${item.value}`}
            onClick={() => {
              if (value === undefined) setInternal(item.value);
              onValueChange?.(item.value);
            }}
            className={cn(
              "inline-flex select-none items-center justify-center gap-1.5 rounded-[10px] font-medium",
              "transition-[background-color,color,box-shadow] duration-[var(--lw-duration-base)] ease-standard",
              "outline-none focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
              "[&_svg]:size-4",
              size === "sm" ? "h-7 px-2.5 text-sm" : "h-8 px-3 text-base",
              block && "flex-1",
              selected
                ? "bg-surface text-ink shadow-xs"
                : "bg-transparent text-subtext hover:text-ink",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
