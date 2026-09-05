import * as React from "react";
import { X } from "lucide-react";
import { Reorder, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PanelTabListProps<Value> = Omit<
  React.ComponentProps<typeof Reorder.Group<Value, "div">>,
  "as" | "axis" | "onReorder" | "values"
> & {
  onReorder: (newOrder: Value[]) => void;
  values: Value[];
};

function PanelTabList<Value>({ className, ...props }: PanelTabListProps<Value>) {
  return (
    <Reorder.Group<Value, "div">
      as="div"
      axis="x"
      className={cn("flex min-w-max items-center gap-1", className)}
      {...props}
    />
  );
}

function PanelTabItem({ className, ...props }: React.ComponentProps<typeof Reorder.Item>) {
  const reduceMotion = useReducedMotion();
  return (
    <Reorder.Item
      as="div"
      layout="position"
      transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 36 }}
      dragElastic={0}
      dragListener={false}
      className={cn("group relative w-40 min-w-0 shrink-0", className)}
      {...props}
    />
  );
}

type PanelTabProps = Omit<React.ComponentProps<typeof Button>, "size" | "variant"> & {
  active?: boolean;
};

function PanelTab({ active, className, ...props }: PanelTabProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={active}
      className={cn(
        "h-8 w-full min-w-0 justify-start gap-2 rounded-lg border border-transparent px-2.5 pr-8 text-left text-xs font-normal text-muted-foreground hover:bg-background/70 hover:text-foreground",
        active && "border-border/80 bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.03)] hover:bg-background",
        className,
      )}
      {...props}
    />
  );
}

type PanelTabCloseProps = Omit<React.ComponentProps<typeof Button>, "children" | "size" | "title" | "variant"> & {
  active?: boolean;
  label: string;
  onClose: () => void;
};

function PanelTabClose({
  active,
  className,
  label,
  onClick,
  onClose,
  onPointerDown,
  ...props
}: PanelTabCloseProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(
        "absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100",
        active && "opacity-100 hover:bg-muted hover:text-foreground",
        className,
      )}
      title="Close tab"
      aria-label={`Close tab: ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);

        if (!event.defaultPrevented) {
          onClose();
        }
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      {...props}
    >
      <X />
    </Button>
  );
}

export { PanelTabList, PanelTabItem, PanelTab, PanelTabClose };
