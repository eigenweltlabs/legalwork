"use client"

import { LoaderCircle, Network } from "lucide-react"

import type { LegalMemoryToolPart } from "@/lib/build-in-tools"
import { legalMemoryActivityLabel } from "@/lib/legalmemory-activity"
import { Tool } from "@/components/ui/tool"

interface LegalMemoryActivityToolProps {
  part: LegalMemoryToolPart
}

/**
 * The in-flight line for a LegalMemory call.
 *
 * Without it the transcript shows a bare `legalmemory_search_filter` while
 * retrieval runs, which tells a lawyer nothing about what is happening to their
 * question. The label describes what that specific tool actually does, so the
 * line stays honest instead of narrating a fixed script the way a demo would.
 *
 * Only the running state is handled here; completed calls keep the generic tool
 * card so their raw output stays inspectable.
 */
export function LegalMemoryActivityTool({ part }: LegalMemoryActivityToolProps) {
  const label = legalMemoryActivityLabel(part.toolName, part.input)
  if (!label) {
    return <Tool toolPart={part} />
  }

  return (
    <div className="flex items-center gap-2 text-sm text-[var(--lw-text-secondary)]">
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <Network className="size-3.5 text-[var(--lw-accent)]" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--lw-text-tertiary)]" />
    </div>
  )
}
