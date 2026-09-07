import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "lw-field w-full min-w-0 rounded-[var(--lw-radius-lg)] border border-border bg-background px-3 text-base text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-[var(--lw-duration-fast)] ease-[var(--lw-ease-out)] motion-reduce:transition-none placeholder:text-placeholder hover:enabled:border-foreground/20 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/15 md:text-sm h-9 py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export { Input }
