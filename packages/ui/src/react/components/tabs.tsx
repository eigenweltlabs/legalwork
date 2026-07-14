import { useState } from "react";
import { cn } from "../utils/cn";

export interface TabItem<T extends string = string> {
  value: T;
  label: React.ReactNode;
  badge?: React.ReactNode;
}

export interface TabsProps<T extends string = string> {
  items: TabItem<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  /** "pill" = filled chip tabs (Plugins / Skills header); "underline" = classic. */
  variant?: "pill" | "underline";
  className?: string;
  "aria-label"?: string;
}

/** Top-level view switcher. Pill variant matches the Plugins/Skills header. */
export function Tabs<T extends string = string>({
  items,
  value,
  defaultValue,
  onValueChange,
  variant = "pill",
  className,
  ...aria
}: TabsProps<T>) {
  const [internal, setInternal] = useState<T>(defaultValue ?? items[0]?.value);
  const active = value !== undefined ? value : internal;

  return (
    <div
      role="tablist"
      aria-label={aria["aria-label"]}
      className={cn(
        "flex items-center",
        variant === "pill" ? "gap-1" : "gap-1 border-b border-subtle",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === active;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              if (value === undefined) setInternal(item.value);
              onValueChange?.(item.value);
            }}
            className={cn(
              "inline-flex select-none items-center gap-1.5 font-medium outline-none",
              "transition-colors duration-[var(--lw-duration-fast)] ease-standard",
              "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
              variant === "pill"
                ? cn(
                    "h-8 rounded-lg px-3 text-base",
                    selected ? "bg-sunken text-ink" : "text-subtext hover:bg-hover hover:text-ink",
                  )
                : cn(
                    "relative h-9 px-1.5 text-base -mb-px border-b-2",
                    selected
                      ? "border-ink text-ink"
                      : "border-transparent text-subtext hover:text-ink",
                  ),
            )}
          >
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
