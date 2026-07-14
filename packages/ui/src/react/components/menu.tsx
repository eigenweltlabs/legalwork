import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "../utils/cn";

/* ------------------------------------------------------------------ context */

type MenuCtx = { close: () => void };
const MenuContext = createContext<MenuCtx | null>(null);

/* --------------------------------------------------------------------- root */

export interface MenuProps {
  /** The clickable element that opens the menu. */
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  sideOffset?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  contentClassName?: string;
  /** min width of the panel in px. */
  minWidth?: number;
}

/**
 * Dropdown menu with soft elevation, optional search header, nested submenus
 * and checkmark selection — the project picker / plugin picker in the
 * reference. Lightweight absolute positioning (no collision flipping).
 */
export function Menu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  sideOffset = 6,
  open,
  defaultOpen,
  onOpenChange,
  className,
  contentClassName,
  minWidth = 240,
}: MenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [internal, setInternal] = useState(defaultOpen ?? false);
  const isOpen = open !== undefined ? open : internal;

  const setOpen = (next: boolean) => {
    if (open === undefined) setInternal(next);
    onOpenChange?.(next);
  };

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (rootRef.current && t && !rootRef.current.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <span onClick={() => setOpen(!isOpen)} className="contents">
        {trigger}
      </span>
      {isOpen ? (
        <MenuContext.Provider value={{ close: () => setOpen(false) }}>
          <div
            role="menu"
            style={{ minWidth }}
            className={cn(
              "absolute z-50 rounded-2xl border border-subtle bg-surface p-1.5 shadow-pop",
              "origin-top animate-[lw-menu-in_120ms_var(--lw-ease-out)]",
              side === "bottom" ? "top-full" : "bottom-full",
              align === "start" ? "left-0" : "right-0",
              contentClassName,
            )}
            data-side={side}
            data-align={align}
          >
            <div style={side === "bottom" ? { marginTop: sideOffset } : { marginBottom: sideOffset }}>
              {children}
            </div>
          </div>
        </MenuContext.Provider>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------- item */

export interface MenuItemProps {
  children: React.ReactNode;
  icon?: React.ReactNode;
  /** Right-aligned hint (shortcut / meta). */
  shortcut?: React.ReactNode;
  /** Arbitrary trailing node (overrides checkmark/shortcut layout if set). */
  trailing?: React.ReactNode;
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** Provide nested items to turn this into a submenu parent. */
  submenu?: React.ReactNode;
  /** Keep the menu open after selecting. */
  keepOpen?: boolean;
}

export function MenuItem({
  children,
  icon,
  shortcut,
  trailing,
  checked,
  destructive,
  disabled,
  onSelect,
  submenu,
  keepOpen,
}: MenuItemProps) {
  const ctx = useContext(MenuContext);
  const [subOpen, setSubOpen] = useState(false);
  const subId = useId();

  const row = (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-haspopup={submenu ? "menu" : undefined}
      aria-expanded={submenu ? subOpen : undefined}
      onClick={() => {
        if (disabled) return;
        if (submenu) {
          setSubOpen((s) => !s);
          return;
        }
        onSelect?.();
        if (!keepOpen) ctx?.close();
      }}
      className={cn(
        "group/mi flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-base",
        "outline-none transition-colors duration-[var(--lw-duration-fast)]",
        "focus-visible:bg-hover",
        destructive ? "text-danger hover:bg-danger-soft" : "text-ink hover:bg-hover",
        disabled && "pointer-events-none opacity-45",
      )}
    >
      {icon ? (
        <span
          className={cn(
            "flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]",
            destructive ? "text-danger" : "text-subtext",
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ??
        (submenu ? (
          <ChevronRight className="size-4 shrink-0 text-tertiary" />
        ) : checked ? (
          <Check className="size-4 shrink-0 text-ink" />
        ) : shortcut ? (
          <span className="shrink-0 text-xs text-tertiary">{shortcut}</span>
        ) : null)}
    </button>
  );

  if (!submenu) return row;

  return (
    <div
      className="relative"
      onMouseEnter={() => setSubOpen(true)}
      onMouseLeave={() => setSubOpen(false)}
    >
      {row}
      {subOpen ? (
        <div
          id={subId}
          role="menu"
          className={cn(
            "absolute left-full top-0 z-50 ml-1 min-w-[220px] rounded-2xl border border-subtle bg-surface p-1.5 shadow-pop",
            "animate-[lw-menu-in_120ms_var(--lw-ease-out)]",
          )}
        >
          {submenu}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- label / search */

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wide text-tertiary">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1.5 h-px bg-subtle" />;
}

export function MenuSearch(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, placeholder = "Search", ...rest } = props;
  return (
    <div className="mb-1 flex items-center gap-2 px-2.5 py-1.5">
      <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-tertiary" fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" strokeLinecap="round" />
      </svg>
      <input
        className={cn("min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-placeholder", className)}
        placeholder={placeholder}
        {...rest}
      />
    </div>
  );
}
