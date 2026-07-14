import * as React from "react";
import { cn } from "@/lib/utils";

export interface LayoutStackProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutStack({ children, className }: LayoutStackProps) {
  return <div className={cn("@container/settings flex w-full max-w-3xl flex-col gap-y-6", className)}>{children}</div>;
}

interface LayoutSectionProps {
  children: React.ReactNode;
}

// Flatten children INCLUDING any Fragments (pages often wrap a mapped list of
// rows in a fragment / conditional), so consecutive setting rows are detected
// even across fragment boundaries. React.Children.toArray does not reliably
// flatten Fragments, which left mapped rows ungrouped ("no structure").
function flattenSectionChildren(children: React.ReactNode): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      out.push(...flattenSectionChildren((child.props as { children?: React.ReactNode }).children));
    } else if (child !== null && child !== undefined && child !== false) {
      out.push(child);
    }
  });
  return out;
}

export function LayoutSection({ children }: LayoutSectionProps) {
  // Group CONSECUTIVE setting rows (LayoutSectionItem) into a single card with
  // hairline dividers — the reference "grouped settings" look. Headers,
  // footnotes, notices and any other content render OUTSIDE the card (in place),
  // so nothing gets clipped by the card's overflow.
  const out: React.ReactNode[] = [];
  let run: React.ReactNode[] = [];
  let runKey = 0;
  const flush = () => {
    if (run.length === 0) return;
    out.push(
      <div
        key={`grp-${runKey++}`}
        className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs"
      >
        {run}
      </div>,
    );
    run = [];
  };
  flattenSectionChildren(children).forEach((child, i) => {
    if (React.isValidElement(child) && child.type === LayoutSectionItem) {
      run.push(React.isValidElement(child) && child.key == null ? React.cloneElement(child, { key: `row-${i}` }) : child);
    } else {
      flush();
      out.push(React.isValidElement(child) && child.key == null ? React.cloneElement(child, { key: `out-${i}` }) : child);
    }
  });
  flush();
  return (
    <div data-section className="group/section flex flex-col gap-3">
      {out}
    </div>
  );
}

interface LayoutSectionHeaderProps {
  children: React.ReactNode;
}

export function LayoutSectionHeader({ children }: LayoutSectionHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      {children}
    </div>
  );
}

interface LayoutSectionTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionTitle({ children, className }: LayoutSectionTitleProps) {
  return (
    <h3 className={cn("flex items-center gap-2 text-base font-medium text-foreground", className)}>
      {children}
    </h3>
  );
}

interface LayoutSectionDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionDescription({ children, className }: LayoutSectionDescriptionProps) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

interface LayoutSectionContentProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionContent({ children, className }: LayoutSectionContentProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItem({ children, className }: LayoutSectionItemProps) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3.5", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemHeader({ children, className }: LayoutSectionItemHeaderProps) {
  return (
    <div className={cn("grid auto-rows-min items-start gap-y-1 gap-x-3 has-data-[slot=item-header-actions]:grid-cols-[1fr_auto]", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemTitle({ children, className }: LayoutSectionItemTitleProps) {
  return (
    <h4 data-slot="item-title" className={cn("flex items-center gap-2 text-base font-medium text-foreground group-data-section/section:text-sm", className)}>
      {children}
    </h4>
  );
}

interface LayoutSectionItemDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemDescription({ children, className }: LayoutSectionItemDescriptionProps) {
  return (
    <p data-slot="item-description" className={cn("text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

interface LayoutSectionItemHeaderActionsProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemHeaderActions({ children, className }: LayoutSectionItemHeaderActionsProps) {
  return (
    <div data-slot="item-header-actions" className={cn("col-start-2 row-span-2 row-start-1 flex flex-wrap items-center gap-2 self-start justify-self-end", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemContentProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemContent({ children, className }: LayoutSectionItemContentProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemFootnoteProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemFootnote({ children, className }: LayoutSectionItemFootnoteProps) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}