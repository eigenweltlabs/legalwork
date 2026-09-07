/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

type SurfaceVariant = "default" | "glass" | "inset";

/** A quiet, bounded surface. Reserve glass for chrome and floating controls. */
export function Surface({
  className,
  variant = "default",
  ...props
}: ComponentProps<"div"> & { variant?: SurfaceVariant }) {
  return (
    <div
      data-slot="surface"
      data-variant={variant}
      className={cn(
        "lw-panel rounded-[var(--lw-radius-2xl)] border border-border text-foreground",
        variant === "default" && "bg-background",
        variant === "glass" && "bg-[var(--lw-glass)] backdrop-blur-[var(--lw-glass-blur)]",
        variant === "inset" && "bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

/** Shared title hierarchy for pages, settings sections, and compact sidebars. */
export function SectionHeading({
  title,
  description,
  action,
  size = "section",
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  size?: "page" | "section" | "sidebar";
  className?: string;
}) {
  const Heading = size === "page" ? "h1" : size === "section" ? "h2" : "h3";

  return (
    <div data-slot="section-heading" className={cn("flex min-w-0 items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <Heading
          className={cn(
            "font-medium text-foreground",
            size === "page" && "text-2xl leading-tight tracking-[-0.035em]",
            size === "section" && "text-base leading-snug tracking-[-0.02em]",
            size === "sidebar" && "text-xs leading-5 tracking-[-0.01em]",
          )}
        >
          {title}
        </Heading>
        {description ? (
          <div className={cn("mt-1 text-muted-foreground", size === "sidebar" ? "text-xs leading-5" : "text-sm leading-relaxed")}>
            {description}
          </div>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  );
}

/** Neutral icon container; use semantic color on the glyph only when meaningful. */
export function IconTile({
  className,
  size = "md",
  variant = "default",
  ...props
}: ComponentProps<"div"> & {
  size?: "sm" | "md" | "lg";
  variant?: SurfaceVariant;
}) {
  return (
    <div
      data-slot="icon-tile"
      data-variant={variant}
      className={cn(
        "lw-icon-tile inline-flex shrink-0 items-center justify-center border border-border text-muted-foreground [&_svg]:shrink-0 [&_svg]:stroke-[1.6]",
        size === "sm" && "size-8 rounded-[var(--lw-radius-lg)] [&_svg]:size-4",
        size === "md" && "size-10 rounded-[var(--lw-radius-xl)] [&_svg]:size-5",
        size === "lg" && "size-12 rounded-[var(--lw-radius-2xl)] [&_svg]:size-6",
        variant === "default" && "bg-background",
        variant === "glass" && "bg-[var(--lw-glass)] backdrop-blur-[var(--lw-glass-blur)]",
        variant === "inset" && "bg-muted/60",
        className,
      )}
      {...props}
    />
  );
}
