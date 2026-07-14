import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckCircle2, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "../utils/cn";

type AlertTone = "info" | "success" | "warning" | "danger" | "neutral";

/** Inline callout / banner — tinted box with a tone icon, title, body, and optional action. */
const alert = cva("flex items-start gap-3 rounded-xl p-3.5 text-ink", {
  variants: {
    tone: {
      info: "bg-brand-soft",
      success: "bg-success-soft",
      warning: "bg-warning-soft",
      danger: "bg-danger-soft",
      neutral: "bg-sunken",
    },
  },
  defaultVariants: { tone: "info" },
});

const iconColor: Record<AlertTone, string> = {
  info: "text-brand",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-subtext",
};

const toneIcon: Record<AlertTone, React.ComponentType<{ className?: string }>> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: CircleAlert,
  neutral: Info,
};

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alert> {
  /** Emphasized heading line. */
  title?: React.ReactNode;
  /** Optional icon override; defaults to the tone icon. */
  icon?: React.ReactNode;
  /** Trailing action, e.g. a <Button size="sm">. */
  action?: React.ReactNode;
  /** When provided, renders a trailing close button. */
  onClose?: () => void;
}

export const Alert = forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, tone, title, icon, action, onClose, children, ...rest },
  ref,
) {
  const resolvedTone: AlertTone = tone ?? "info";
  const ToneIcon = toneIcon[resolvedTone];

  return (
    <div ref={ref} role="alert" className={cn(alert({ tone }), className)} {...rest}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-[18px]", iconColor[resolvedTone])}>
        {icon ?? <ToneIcon className="size-[18px]" />}
      </span>

      <div className="min-w-0 flex-1">
        {title ? <div className="text-base font-medium text-ink">{title}</div> : null}
        {children ? (
          <div className={cn("text-sm text-subtext", title ? "mt-0.5" : "")}>{children}</div>
        ) : null}
        {action ? <div className="mt-2.5">{action}</div> : null}
      </div>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className={cn(
            "-mr-1 -mt-1 shrink-0 rounded-md p-1 text-tertiary",
            "transition-colors duration-[var(--lw-duration-fast)] ease-standard",
            "outline-none hover:bg-hover hover:text-ink",
            "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
          )}
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
});
