import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../utils/cn";

const card = cva("bg-surface text-ink", {
  variants: {
    variant: {
      outline: "border border-subtle",
      elevated: "border border-subtle shadow-sm",
      ghost: "",
    },
    radius: {
      lg: "rounded-xl",
      xl: "rounded-2xl",
    },
    padding: {
      none: "",
      sm: "p-3",
      md: "p-4",
      lg: "p-5",
    },
  },
  defaultVariants: { variant: "outline", radius: "xl", padding: "none" },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof card> {}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant, radius, padding, ...rest },
  ref,
) {
  return <div ref={ref} className={cn(card({ variant, radius, padding }), className)} {...rest} />;
});

/** Optional card header: an eyebrow title + description + trailing action. */
export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-4 pb-3", className)}>
      <div className="min-w-0">
        {title ? <div className="text-md font-semibold text-ink">{title}</div> : null}
        {description ? (
          <div className="mt-0.5 text-base text-subtext">{description}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
