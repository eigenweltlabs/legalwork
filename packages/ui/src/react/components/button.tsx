import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

/**
 * Button — the primary action control.
 *
 * variants:
 *  - primary   filled navy (default high-emphasis action)
 *  - accent    filled interactive blue (send / confirm-in-flow)
 *  - secondary white surface + hairline border (the workhorse)
 *  - ghost     transparent, hover fill (toolbar / low emphasis)
 *  - subtle    sunken gray fill, no border (segmented / chip-like)
 *  - danger    destructive
 *  - link      inline text button
 */
const button = cva(
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium " +
    "transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--lw-duration-fast)] ease-standard " +
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)] focus-visible:ring-offset-0 " +
    "disabled:pointer-events-none disabled:opacity-45 active:scale-[0.985]",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-fg shadow-xs hover:bg-primary-hover",
        accent:
          "bg-brand text-brand-fg shadow-xs hover:bg-brand-hover",
        secondary:
          "bg-surface text-ink border border-line shadow-xs hover:bg-surface-hover hover:border-strong",
        ghost:
          "bg-transparent text-ink hover:bg-hover",
        subtle:
          "bg-sunken text-ink hover:bg-active",
        danger:
          "bg-danger text-white shadow-xs hover:bg-danger-hover",
        link:
          "bg-transparent text-brand hover:underline underline-offset-2 px-0 h-auto",
      },
      size: {
        sm: "h-8 rounded-lg px-3 text-sm",
        md: "h-9 rounded-lg px-3.5 text-base",
        lg: "h-11 rounded-xl px-5 text-md",
      },
      pill: { true: "rounded-full", false: "" },
      block: { true: "w-full", false: "" },
    },
    compoundVariants: [
      { variant: "link", size: "sm", class: "h-auto px-0" },
      { variant: "link", size: "md", class: "h-auto px-0" },
      { variant: "link", size: "lg", class: "h-auto px-0" },
    ],
    defaultVariants: { variant: "secondary", size: "md", pill: false, block: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /** Leading icon element (e.g. a lucide icon). */
  leading?: React.ReactNode;
  /** Trailing icon element. */
  trailing?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, pill, block, leading, trailing, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(button({ variant, size, pill, block }), className)}
      {...rest}
    >
      {leading ? <span className="-ml-0.5 shrink-0 [&_svg]:size-[1.05em]">{leading}</span> : null}
      {children}
      {trailing ? <span className="-mr-0.5 shrink-0 [&_svg]:size-[1.05em]">{trailing}</span> : null}
    </button>
  );
});

export { button as buttonVariants };
