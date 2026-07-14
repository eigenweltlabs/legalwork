import { forwardRef, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../utils/cn";

/**
 * Accordion — a stack of disclosure items separated by hairlines.
 *
 * Compose with AccordionItem children. Each item owns its open state
 * internally (uncontrolled via `defaultOpen`) unless you drive it with
 * the `open` / `onOpenChange` pair.
 */
export interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {}

export const Accordion = forwardRef<HTMLDivElement, AccordionProps>(function Accordion(
  { className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("divide-y divide-subtle border-y border-subtle", className)}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface AccordionItemProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "onChange"> {
  /** Header label shown in the trigger button. */
  title: React.ReactNode;
  /** Optional leading icon (e.g. a lucide icon) before the title. */
  icon?: React.ReactNode;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  /** Controlled open state. Pair with `onOpenChange`. */
  open?: boolean;
  /** Called with the next open state when the header is toggled. */
  onOpenChange?: (open: boolean) => void;
  /** Disable the trigger. */
  disabled?: boolean;
}

export const AccordionItem = forwardRef<HTMLDivElement, AccordionItemProps>(function AccordionItem(
  { className, title, icon, defaultOpen = false, open, onOpenChange, disabled, children, ...rest },
  ref,
) {
  const [internal, setInternal] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internal;

  const id = useId();
  const panelId = `${id}-panel`;
  const triggerId = `${id}-trigger`;

  function toggle() {
    const next = !isOpen;
    if (!isControlled) setInternal(next);
    onOpenChange?.(next);
  }

  return (
    <div ref={ref} className={cn("", className)} {...rest}>
      <h3 className="m-0">
        <button
          type="button"
          id={triggerId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          disabled={disabled}
          onClick={toggle}
          className={cn(
            "flex w-full items-center justify-between gap-3 py-3 text-left text-base font-medium text-ink",
            "outline-none transition-colors duration-[var(--lw-duration-fast)] ease-standard",
            "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
            "disabled:pointer-events-none disabled:opacity-45",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {icon ? (
              <span className="shrink-0 text-subtext [&_svg]:size-4">{icon}</span>
            ) : null}
            <span className="truncate">{title}</span>
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-tertiary",
              "transition-transform duration-[var(--lw-duration-fast)] ease-standard",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        </button>
      </h3>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        className={cn(
          "grid transition-[grid-template-rows] duration-[var(--lw-duration-fast)] ease-out-soft",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="pb-3 text-sm text-subtext">{children}</div>
        </div>
      </div>
    </div>
  );
});
