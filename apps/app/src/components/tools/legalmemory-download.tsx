"use client"

import { FileText } from "lucide-react"

import { LEGALMEMORY_OPEN_EVENT } from "@/components/markdown/legalmemory-ref"
import type { LegalMemoryToolPart } from "@/lib/build-in-tools"
import { formatExportSize, parseLegalMemoryDownload } from "@/lib/legalmemory-download"
import { Tool } from "@/components/ui/tool"

interface LegalMemoryDownloadToolProps {
  part: LegalMemoryToolPart
}

/**
 * The exact original behind a citation, ready to open.
 *
 * `download_document` returns a short-lived link rather than the bytes, so the
 * transcript used to show a curl command the agent then had to run in a second
 * turn. Here the link becomes one button: the surface hands it to the server,
 * which checks it against the firm's configured appliance origins, saves the
 * file into the workspace, and opens it in the document viewer.
 *
 * If the link cannot be found in the payload the generic tool card is shown
 * instead, so a change in how the appliance answers degrades to the old
 * behavior rather than losing the result.
 */
export function LegalMemoryDownloadTool({ part }: LegalMemoryDownloadToolProps) {
  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  const download = parseLegalMemoryDownload(part.output)
  if (!download) {
    return <Tool toolPart={part} />
  }

  const size = formatExportSize(download.sizeBytes)

  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent(LEGALMEMORY_OPEN_EVENT, {
            detail: { url: download.url, filename: download.filename },
          }),
        )
      }
      title={`Save ${download.filename} into the workspace and open it`}
      className="flex w-full items-center gap-2.5 rounded-xl border border-[var(--lw-border)] bg-[var(--lw-surface)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--lw-surface-hover)]"
    >
      <FileText className="size-4 shrink-0 text-[var(--lw-accent)]" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--lw-text-primary)]">
          {download.filename}
        </span>
        <span className="block text-xs text-[var(--lw-text-secondary)]">
          Exact original from LegalMemory{size ? ` · ${size}` : ""}
        </span>
      </span>
      <span className="shrink-0 rounded-full border border-[var(--lw-border)] px-2.5 py-1 text-xs font-medium text-[var(--lw-text-secondary)]">
        Open
      </span>
    </button>
  )
}
