import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface RowProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Leading visual (icon, avatar). */
  leading?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Trailing control (Switch, Select, Button, chevron). */
  trailing?: React.ReactNode;
  /** Adds hover affordance + pointer (use for navigable rows). */
  interactive?: boolean;
  /** Vertical density. */
  dense?: boolean;
}

/**
 * SettingsRow — a label/description pair with a trailing control. Stack these
 * inside a `Card` and separate with `<Divider inset />` to reproduce the
 * grouped settings panels in the reference.
 */
export const Row = forwardRef<HTMLDivElement, RowProps>(function Row(
  { className, leading, title, description, trailing, interactive, dense, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-3 px-4",
        dense ? "py-2.5" : "py-3.5",
        interactive &&
          "cursor-pointer transition-colors duration-[var(--lw-duration-fast)] hover:bg-hover",
        className,
      )}
      {...rest}
    >
      {leading ? (
        <span className="flex shrink-0 items-center text-subtext [&_svg]:size-[18px]">
          {leading}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="text-base font-medium text-ink">{title}</div> : null}
        {description ? (
          <div className="mt-0.5 text-sm leading-[1.35] text-subtext">{description}</div>
        ) : null}
        {children}
      </div>
      {trailing ? <div className="flex shrink-0 items-center">{trailing}</div> : null}
    </div>
  );
});
