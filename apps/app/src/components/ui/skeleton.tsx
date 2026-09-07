import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("motion-safe:animate-pulse rounded-[var(--lw-radius-md)] bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
