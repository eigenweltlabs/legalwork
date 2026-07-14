import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

/** Square, icon-only button — toolbar controls, header actions, send. */
const iconButton = cva(
  "inline-flex shrink-0 items-center justify-center " +
    "transition-[background-color,color,box-shadow,transform] duration-[var(--lw-duration-fast)] ease-standard " +
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)] " +
    "disabled:pointer-events-none disabled:opacity-45 active:scale-95 " +
    "[&_svg]:shrink-0",
  {
    variants: {
      variant: {
        ghost: "bg-transparent text-subtext hover:bg-hover hover:text-ink",
        secondary: "bg-surface text-ink border border-line shadow-xs hover:bg-surface-hover",
        subtle: "bg-sunken text-ink hover:bg-active",
        primary: "bg-primary text-primary-fg hover:bg-primary-hover shadow-xs",
        accent: "bg-brand text-brand-fg hover:bg-brand-hover shadow-xs",
      },
      size: {
        sm: "size-7 [&_svg]:size-4",
        md: "size-8 [&_svg]:size-[18px]",
        lg: "size-10 [&_svg]:size-5",
      },
      shape: { square: "", round: "rounded-full" },
    },
    compoundVariants: [
      { shape: "square", size: "sm", class: "rounded-md" },
      { shape: "square", size: "md", class: "rounded-lg" },
      { shape: "square", size: "lg", class: "rounded-xl" },
    ],
    defaultVariants: { variant: "ghost", size: "md", shape: "square" },
  },
);

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButton> {
  /** Accessible label — required since there is no visible text. */
  "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ className, variant, size, shape, type, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(iconButton({ variant, size, shape }), className)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
