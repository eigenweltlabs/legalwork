import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../utils/cn";
import { Menu, MenuItem } from "./menu";

export interface SelectOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SelectProps<T extends string = string> {
  options: SelectOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  placeholder?: string;
  size?: "sm" | "md";
  align?: "start" | "end";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Compact value-picker (settings dropdowns). Trigger shows the current label;
 * the panel lists options with a checkmark on the selected one.
 */
export function Select<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select",
  size = "md",
  align = "end",
  disabled,
  className,
  ...aria
}: SelectProps<T>) {
  const [internal, setInternal] = useState<T | undefined>(defaultValue);
  const current = value !== undefined ? value : internal;
  const selected = options.find((o) => o.value === current);

  return (
    <Menu
      align={align}
      minWidth={180}
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={aria["aria-label"]}
          className={cn(
            "inline-flex items-center justify-between gap-2 rounded-lg border border-line bg-surface font-medium text-ink shadow-xs",
            "transition-colors duration-[var(--lw-duration-fast)] outline-none",
            "hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
            "disabled:opacity-55",
            size === "sm" ? "h-8 px-2.5 text-sm" : "h-9 px-3 text-base",
            className,
          )}
        >
          <span className="flex items-center gap-1.5 [&_svg]:size-4">
            {selected?.icon}
            {selected?.label ?? <span className="text-placeholder">{placeholder}</span>}
          </span>
          <ChevronDown className="size-4 text-tertiary" />
        </button>
      }
    >
      {options.map((o) => (
        <MenuItem
          key={o.value}
          icon={o.icon}
          checked={o.value === current}
          onSelect={() => {
            if (value === undefined) setInternal(o.value);
            onValueChange?.(o.value);
          }}
        >
          {o.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
