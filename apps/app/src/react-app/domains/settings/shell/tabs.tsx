/** @jsxImportSource react */
import type * as React from "react";

import { cn } from "@/lib/utils";
import { Surface } from "@/react-app/design-system/surface";

type TabsSidebarProps = {
  children: React.ReactNode;
};

export function TabsSidebar(props: TabsSidebarProps) {
  return (
    <aside className={cn("space-y-6 md:sticky md:top-4 md:self-start")}>{props.children}</aside>
  );
}

type TabsGroupProps = {
  children: React.ReactNode;
};

export function TabsGroup(props: TabsGroupProps) {
  return (
    <Surface variant="glass" className="p-2.5">
      {props.children}
    </Surface>
  );
}

type TabsGroupTitleProps = {
  children: React.ReactNode;
};

export function TabsGroupTitle(props: TabsGroupTitleProps) {
  return (
    <div className="mb-2 px-2 py-1 text-[11px] font-medium tracking-[0.02em] text-muted-foreground">
      {props.children}
    </div>
  );
}

type TabsListProps = {
  children: React.ReactNode;
};

export function TabsList(props: TabsListProps) {
  return <div className={cn("space-y-1")}>{props.children}</div>;
}

type TabsTriggerProps = {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
};

export function TabsTrigger(props: TabsTriggerProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-lg border border-transparent px-3 py-2.5 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        props.active &&
          "border-border/70 bg-background text-foreground hover:bg-background hover:text-foreground",
      )}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onSelect}
    >
      <span>{props.children}</span>
    </button>
  );
}
