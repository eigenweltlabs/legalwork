"use client"

import { FileText, ShieldCheck } from "lucide-react"

import {
  buildLegalMemoryRefPrompt,
  LEGALMEMORY_REF_EVENT,
} from "@/components/markdown/legalmemory-ref"
import type { LegalMemorySearchToolPart } from "@/lib/build-in-tools"
import {
  isAuthoritativeStatus,
  parseLegalMemorySources,
  type LegalMemorySource,
} from "@/lib/legalmemory-sources"
import { Tool } from "@/components/ui/tool"

interface LegalMemorySourcesToolProps {
  part: LegalMemorySearchToolPart
}

/**
 * The cited sources behind a LegalMemory answer.
 *
 * Clicking a row asks the agent to export that document into the workspace and
 * link it back, the same round-trip a reference chip performs — the app holds no
 * appliance credentials, so it cannot fetch the original itself.
 *
 * The status badge is the point of the row: the index holds drafts, redlines and
 * superseded originals alongside the operative document, so a source is close to
 * useless without saying which of those it is.
 */
export function LegalMemorySourcesTool({ part }: LegalMemorySourcesToolProps) {
  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  const parsed = parseLegalMemorySources(part.output)
  if (!parsed) {
    return <Tool toolPart={part} />
  }

  const open = (source: LegalMemorySource) => {
    window.dispatchEvent(
      new CustomEvent(LEGALMEMORY_REF_EVENT, {
        detail: {
          prompt: buildLegalMemoryRefPrompt({ kind: "document", id: source.documentId }, source.title),
        },
      }),
    )
  }

  return (
    <div className="w-full overflow-hidden rounded-xl border border-[var(--lw-border)] bg-[var(--lw-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--lw-border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--lw-text-secondary)]">
        <ShieldCheck className="size-3.5 text-[var(--lw-accent)]" />
        <span>Sources</span>
        <span className="ml-auto shrink-0 font-normal">
          {parsed.sources.length} permission-approved{" "}
          {parsed.sources.length === 1 ? "document" : "documents"}
        </span>
      </div>

      <ul className="divide-y divide-[var(--lw-border-subtle)]">
        {parsed.sources.map((source) => {
          const meta = [source.docType, source.system].filter(Boolean).join(" · ")
          return (
            <li key={source.documentId}>
              <button
                type="button"
                onClick={() => open(source)}
                title={`Export "${source.title}" into the workspace`}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--lw-surface-hover)]"
              >
                <FileText className="mt-0.5 size-4 shrink-0 text-[var(--lw-accent)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm font-medium text-[var(--lw-accent)]">
                      {source.title}
                    </span>
                    {source.versionStatus ? (
                      <span
                        className={
                          isAuthoritativeStatus(source.versionStatus)
                            ? "shrink-0 rounded-full bg-[var(--lw-success-soft)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--lw-success)]"
                            : "shrink-0 rounded-full border border-[var(--lw-border)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--lw-text-tertiary)]"
                        }
                      >
                        {source.versionStatus}
                      </span>
                    ) : null}
                  </span>
                  {meta ? (
                    <span className="mt-0.5 block truncate text-xs text-[var(--lw-text-secondary)]">
                      {meta}
                    </span>
                  ) : null}
                  {source.excerpt ? (
                    <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-[var(--lw-text-tertiary)]">
                      {source.excerpt}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
