import { forwardRef } from "react";
import { cn } from "../utils/cn";

/* ------------------------------------------------------------------ shell */

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {}

/** Left navigation rail. Light sunken surface, generous padding. */
export const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { className, children, ...rest },
  ref,
) {
  return (
    <nav
      ref={ref}
      className={cn("flex h-full w-64 flex-col gap-1 bg-sidebar px-3 py-3", className)}
      {...rest}
    >
      {children}
    </nav>
  );
});

/* ------------------------------------------------------------------- item */

export interface SidebarItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: React.ReactNode;
  active?: boolean;
  trailing?: React.ReactNode;
  /** Indent for nested items (project children). */
  indent?: boolean;
}

export const SidebarItem = forwardRef<HTMLButtonElement, SidebarItemProps>(function SidebarItem(
  { className, icon, active, trailing, indent, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/si flex w-full items-center gap-2.5 rounded-lg py-1.5 pr-2 text-left text-base",
        "outline-none transition-colors duration-[var(--lw-duration-fast)]",
        "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
        indent ? "pl-8" : "pl-2.5",
        active ? "bg-active font-medium text-ink" : "font-normal text-subtext hover:bg-hover hover:text-ink",
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span className={cn("flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]", active ? "text-ink" : "text-tertiary group-hover/si:text-subtext")}>
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? <span className="shrink-0 text-tertiary">{trailing}</span> : null}
    </button>
  );
});

/* ------------------------------------------------------------- group / label */

export function SidebarGroup({
  label,
  action,
  children,
  className,
}: {
  label?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-4 first:mt-1", className)}>
      {label ? (
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-2xs font-semibold uppercase tracking-wide text-tertiary">{label}</span>
          {action}
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
