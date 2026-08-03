"use client"

import { Check, LoaderCircle, Network } from "lucide-react"

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
 * Every LegalMemory call renders as one of these lines, running or finished, so
 * a retrieval reads as a short list of steps rather than a stack of result
 * cards. The graph and the document open are the only things that earn more
 * room than a line.
 */
export function LegalMemoryActivityTool({ part }: LegalMemoryActivityToolProps) {
  const label = legalMemoryActivityLabel(part.toolName, part.input)
  if (!label) {
    return <Tool toolPart={part} />
  }

  // The line has to settle when the call does. Spinning on a finished part
  // reads as a query that never returned.
  const done = part.state === "output-available"

  return (
    <div className="flex items-center gap-2 text-sm text-[var(--lw-text-secondary)]">
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <Network className="size-3.5 text-[var(--lw-accent)]" />
      </span>
      <span className="min-w-0 truncate">{label}</span>
      {done ? (
        <Check className="size-3.5 shrink-0 text-[var(--lw-success)]" />
      ) : (
        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--lw-text-tertiary)]" />
      )}
    </div>
  )
}
