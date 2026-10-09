import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { IconTile } from "./surface";

type PanelHeaderProps = {
  title: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
  wrapActions?: boolean;
  headerTarget?: HTMLElement | null;
};

/** Keep panel controls with their owning component while placing them in window chrome. */
export function PanelHeaderPortal({ target, children }: { target?: HTMLElement | null; children: ReactNode }) {
  return target ? createPortal(children, target) : children;
}

/** Shared compact chrome for file browsers and document previews. */
export function PanelHeader({ title, icon, meta, children, className, wrapActions = false, headerTarget }: PanelHeaderProps) {
  return (
    <PanelHeaderPortal target={headerTarget}>
      <div className={cn("@container/panel-header shrink-0 titlebar-no-drag", headerTarget ? "h-full" : "bg-background/80 backdrop-blur-xl", className)}>
        <div className={cn(
          "flex h-(--lw-panel-toolbar-height) items-center gap-2 border-b border-border/70 pe-2 ps-4",
          headerTarget && "h-full border-b-0 ps-3 [&>svg]:size-4 [&>.lw-folder-icon]:size-4",
          wrapActions && !headerTarget && "h-auto flex-wrap gap-y-2 py-2 @min-[400px]/panel-header:h-(--lw-panel-toolbar-height) @min-[400px]/panel-header:flex-nowrap @min-[400px]/panel-header:py-0",
        )}>
          {icon}
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground" title={title}>{title}</h2>
          {meta ? <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span> : null}
          {children ? (
            <div className={cn(
              "flex shrink-0 items-center gap-0.5",
              wrapActions && !headerTarget && "w-full flex-wrap justify-end border-t border-border/50 pt-1 @min-[400px]/panel-header:w-auto @min-[400px]/panel-header:flex-nowrap @min-[400px]/panel-header:border-t-0 @min-[400px]/panel-header:pt-0",
            )}>{children}</div>
          ) : null}
        </div>
      </div>
    </PanelHeaderPortal>
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
