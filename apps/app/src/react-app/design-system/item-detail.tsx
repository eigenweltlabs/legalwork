import type { ComponentProps, ReactNode } from "react";
import { DialogContent } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Shared proportions for tasks and calendar entries. */
export function ItemDialogContent({ className, ...props }: ComponentProps<typeof DialogContent>) {
  return <DialogContent className={cn("flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-2xl", className)} {...props} />;
}

export function ItemDetailLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-2.5 text-xs font-medium text-muted-foreground">
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 [&_svg]:size-3.5">{icon}</span>
    <span className="truncate">{children}</span>
  </span>;
}

export function ItemTitleInput({ className, onKeyDown, ...props }: ComponentProps<typeof Textarea>) {
  return <Textarea rows={1} className={cn("min-h-0 rounded-none border-0 bg-transparent px-0 py-0 text-2xl font-semibold leading-tight tracking-[-0.025em] shadow-none placeholder:font-medium focus-visible:ring-0 md:text-2xl", className)} {...props}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (event.currentTarget.form) event.currentTarget.form.requestSubmit();
      else event.currentTarget.blur();
    }} />;
}

export function ItemDescriptionInput({ className, ...props }: ComponentProps<typeof Textarea>) {
  return <Textarea rows={2} className={cn("min-h-14 rounded-none border-0 bg-transparent px-0 py-0 text-sm leading-relaxed shadow-none focus-visible:ring-0", className)} {...props} />;
}
