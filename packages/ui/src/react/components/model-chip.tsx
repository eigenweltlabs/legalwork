import { forwardRef } from "react";
import { ChevronDown, Zap } from "lucide-react";
import { cn } from "../utils/cn";

export interface ModelChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "name"> {
  /** Model name, e.g. "5.6 Sol". */
  name: React.ReactNode;
  /** Effort / mode label, e.g. "High". */
  level?: React.ReactNode;
  active?: boolean;
}

/** The model + reasoning-effort selector pill from the composer. */
export const ModelChip = forwardRef<HTMLButtonElement, ModelChipProps>(function ModelChip(
  { className, name, level, active, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-base font-medium",
        "transition-colors duration-[var(--lw-duration-fast)] outline-none",
        "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)]",
        active ? "bg-active text-ink" : "bg-sunken text-ink hover:bg-active",
        className,
      )}
      {...rest}
    >
      <Zap className="size-4 fill-brand text-brand" />
      <span>{name}</span>
      {level ? <span className="font-normal text-tertiary">{level}</span> : null}
      <ChevronDown className="size-4 text-tertiary" />
    </button>
  );
});
