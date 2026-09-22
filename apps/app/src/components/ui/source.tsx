"use client"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { Globe } from "lucide-react"
import { createContext, useContext } from "react"
import { t } from "@/i18n";

const SourceContext = createContext<{
  href: string
  domain: string
} | null>(null)

function useSourceContext() {
  const ctx = useContext(SourceContext)
  if (!ctx) throw new Error("Source.* must be used inside <Source>")
  return ctx
}

export type SourceProps = {
  href: string
  children: React.ReactNode
}

export function Source({ href, children }: SourceProps) {
  let domain = ""
  try {
    domain = new URL(href).hostname
  } catch {
    domain = href.split("/").pop() || href
  }

  return (
    <SourceContext.Provider value={{ href, domain }}>
      <HoverCard>
        {children}
      </HoverCard>
    </SourceContext.Provider>
  )
}

export type SourceTriggerProps = {
  label?: string | number
  /**
   * Show a leading site glyph. A generic mark, not the site's real favicon:
   * fetching that would hand the cited URL to whichever service served it.
   */
  showFavicon?: boolean
  className?: string
}

export function SourceTrigger({
  label,
  showFavicon = false,
  className,
}: SourceTriggerProps) {
  const { href, domain } = useSourceContext()
  const labelToShow = label ?? domain.replace("www.", "")

  return (
    <HoverCardTrigger render={<a href={href} target="_blank" rel="noopener noreferrer" className={cn(
                "bg-muted text-muted-foreground hover:bg-muted-foreground/30 hover:text-primary inline-flex h-5 max-w-32 items-center gap-1 overflow-hidden rounded-full py-0 text-xs no-underline transition-colors duration-150",
                showFavicon ? "pe-2 ps-1" : "px-1",
                className
              )} />}>{showFavicon && (
                <Globe className="size-3.5 shrink-0" aria-hidden />
              )}<span className="truncate tabular-nums text-center font-normal">{labelToShow}</span></HoverCardTrigger>
  )
}

export type SourceContentProps = {
  title: string
  description?: string
  className?: string
}

export function SourceContent({
  title,
  description,
  className,
}: SourceContentProps) {
  const { href, domain } = useSourceContext()

  return (
    <HoverCardContent className={cn("w-80 p-0 shadow-xs", className)}>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col gap-2 p-3"
      >
        <div className="flex items-center gap-1.5">
          <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="text-primary truncate text-sm">
            {domain.replace("www.", "")}
          </div>
        </div>
        <div className="line-clamp-2 text-sm font-medium">{title}</div>
        <div className="text-muted-foreground line-clamp-2 text-sm">
          {description ? description : <span className="text-muted-foreground">{t("source.no_description")}</span>}
        </div>
      </a>
    </HoverCardContent>
  )
}
