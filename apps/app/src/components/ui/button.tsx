import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "lw-control group/button relative inline-flex shrink-0 items-center justify-center rounded-[var(--lw-radius-lg)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--lw-duration-fast)] ease-[var(--lw-ease-out)] motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-foreground text-background hover:bg-foreground/85 active:bg-foreground/90 motion-safe:active:not-aria-[haspopup]:translate-y-px",
        outline:
          "border-border bg-background text-foreground hover:border-foreground/20 hover:bg-muted/60 aria-expanded:bg-muted motion-safe:active:not-aria-[haspopup]:translate-y-px",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-muted aria-expanded:bg-muted motion-safe:active:not-aria-[haspopup]:translate-y-px",
        ghost:
          "text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground",
        destructive:
          "border-destructive/20 bg-background text-destructive hover:border-destructive/35 hover:bg-destructive/10 focus-visible:border-destructive focus-visible:ring-destructive/20 motion-safe:active:not-aria-[haspopup]:translate-y-px",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pe-2.5 has-data-[icon=inline-start]:ps-2.5",
        xs: "h-6 gap-1 rounded-[var(--lw-radius-sm)] px-2.5 text-xs has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 px-3 has-data-[icon=inline-end]:pe-2 has-data-[icon=inline-start]:ps-2",
        lg: "h-10 gap-1.5 px-6 has-data-[icon=inline-end]:pe-4 has-data-[icon=inline-start]:ps-3",
        icon: "size-9 rounded-[var(--lw-radius-lg)]",
        "icon-xs": "size-6 rounded-[var(--lw-radius-sm)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8 rounded-[var(--lw-radius-md)]",
        "icon-lg": "size-10 rounded-[var(--lw-radius-xl)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
