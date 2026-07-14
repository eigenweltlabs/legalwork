import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

const badge = cva(
  "inline-flex items-center gap-1 whitespace-nowrap font-medium [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-sunken text-subtext",
        primary: "bg-primary text-primary-fg",
        accent: "bg-brand-soft text-brand",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        outline: "border border-line text-subtext",
      },
      size: {
        sm: "h-5 rounded-md px-1.5 text-2xs",
        md: "h-6 rounded-md px-2 text-xs",
      },
      pill: { true: "rounded-full", false: "" },
    },
    defaultVariants: { tone: "neutral", size: "md", pill: false },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {
  /** Render a leading status dot in the current tone color. */
  dot?: boolean;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, size, pill, dot, children, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cn(badge({ tone, size, pill }), className)} {...rest}>
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-80" /> : null}
      {children}
    </span>
  );
});
