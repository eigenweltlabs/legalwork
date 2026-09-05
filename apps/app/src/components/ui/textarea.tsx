import * as React from "react";

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "lw-field w-full min-w-0 rounded-[var(--lw-radius-lg)] border border-border bg-background px-3 text-base text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-[var(--lw-duration-fast)] ease-[var(--lw-ease-out)] motion-reduce:transition-none placeholder:text-placeholder hover:enabled:border-foreground/20 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15 md:text-sm field-sizing-content flex min-h-20 resize-none py-2.5 leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
