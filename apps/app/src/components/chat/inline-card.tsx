import type { ComponentProps, ReactNode } from "react";
import { Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";

/** Shared conversation-card layout for email drafts and sign-in requests. */
export function InlineCard({ className, ...props }: ComponentProps<typeof Surface>) {
  return <Surface data-inline-card className={cn("my-3 w-full max-w-2xl overflow-hidden rounded-2xl shadow-[0_2px_12px_-5px_rgb(0_0_0/0.12)]", className)} {...props} />;
}

export function InlineCardHeader({ icon, title, status, actions }: {
  icon: ReactNode; title: ReactNode; status?: ReactNode; actions?: ReactNode;
}) {
  return <div className="flex items-center gap-2 border-b border-border/60 bg-muted/25 px-5 py-3">
    {icon}
    <h3 className="flex-1 text-xs font-medium text-muted-foreground">{title}</h3>
    {status ? <span role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">{status}</span> : null}
    {actions}
  </div>;
}

export function InlineCardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-2 border-t border-border/60 px-4 py-3", className)} {...props} />;
}
