import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { IconTile } from "./surface";

type PanelHeaderProps = {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  wrapActions?: boolean;
};

/** Shared compact chrome for file browsers and document previews. */
export function PanelHeader({ title, icon, meta, children, className, wrapActions = false }: PanelHeaderProps) {
  return (
    <div className={cn("@container/panel-header shrink-0 border-b border-border/70 bg-background/80 backdrop-blur-xl mac:titlebar-no-drag", className)}>
      <div className={cn(
        "flex h-12 items-center gap-2 pe-2 ps-4",
        wrapActions && "h-auto flex-wrap gap-y-2 py-2 @min-[400px]/panel-header:h-12 @min-[400px]/panel-header:flex-nowrap @min-[400px]/panel-header:py-0",
      )}>
        {icon}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground" title={title}>{title}</h2>
        {meta ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span> : null}
        {children ? (
          <div className={cn(
            "flex shrink-0 items-center gap-0.5",
            wrapActions && "w-full justify-end border-t border-border/50 pt-1 @min-[400px]/panel-header:w-auto @min-[400px]/panel-header:border-t-0 @min-[400px]/panel-header:pt-0",
          )}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}

type PanelEmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
};

export function PanelEmptyState({ icon, title, description, children }: PanelEmptyStateProps) {
  return (
    <div className="flex h-full min-h-48 flex-1 flex-col items-center justify-center gap-4 px-7 py-10 text-center">
      <IconTile size="lg" variant="glass">{icon}</IconTile>
      <div className="max-w-64 space-y-1.5">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}
