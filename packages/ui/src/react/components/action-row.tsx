import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronRight } from "lucide-react";
import { cn } from "../utils/cn";

/**
 * ActionRow — the large full-width action card (settings / navigation).
 *
 * A leading icon tile + title + optional description + trailing chevron,
 * rendered as a full-width button with a hover highlight. Use it for the big
 * tappable rows in settings and navigation surfaces.
 *
 * tone:
 *  - default   neutral sunken icon tile
 *  - accent    brand-soft icon tile in interactive blue
 */
const actionRow = cva(
  "group/action-row flex w-full items-center gap-3 rounded-xl border border-subtle bg-surface px-4 py-3.5 text-left " +
    "transition-[background-color,border-color,box-shadow,transform] duration-[var(--lw-duration-fast)] ease-standard " +
    "outline-none hover:bg-surface-hover hover:border-line " +
    "focus-visible:ring-2 focus-visible:ring-[var(--lw-focus-ring)] focus-visible:ring-offset-0 " +
    "disabled:pointer-events-none disabled:opacity-45 active:scale-[0.995]",
  {
    variants: {
      tone: { default: "", accent: "" },
    },
    defaultVariants: { tone: "default" },
  },
);

const iconTile = cva(
  "grid size-9 shrink-0 place-items-center rounded-lg [&_svg]:size-[1.1rem]",
  {
    variants: {
      tone: {
        default: "bg-sunken text-ink",
        accent: "bg-brand-soft text-brand",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

function Spinner() {
  return (
    <svg
      className="size-4 shrink-0 animate-spin text-tertiary"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.5"
        className="opacity-25"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface ActionRowProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">,
    VariantProps<typeof actionRow> {
  /** Leading icon element (e.g. a lucide icon). Rendered inside the icon tile. */
  icon: React.ReactNode;
  /** Primary label. */
  title: React.ReactNode;
  /** Optional supporting line under the title. */
  description?: React.ReactNode;
  /** Trailing element. Defaults to a chevron; replaced by a spinner while loading. */
  trailing?: React.ReactNode;
  /** Show an inline spinner in place of the trailing element. */
  loading?: boolean;
}

export const ActionRow = forwardRef<HTMLButtonElement, ActionRowProps>(
  function ActionRow(
    {
      className,
      tone,
      icon,
      title,
      description,
      trailing,
      loading,
      disabled,
      type,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        className={cn(actionRow({ tone }), className)}
        {...rest}
      >
        <span className={iconTile({ tone })}>{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-medium text-ink">{title}</span>
          {description ? (
            <span className="truncate text-sm text-subtext">{description}</span>
          ) : null}
        </span>
        <span className="grid shrink-0 place-items-center text-tertiary [&_svg]:size-4">
          {loading ? (
            <Spinner />
          ) : trailing !== undefined ? (
            trailing
          ) : (
            <ChevronRight className="transition-transform duration-[var(--lw-duration-fast)] ease-standard group-hover/action-row:translate-x-0.5" />
          )}
        </span>
      </button>
    );
  },
);
