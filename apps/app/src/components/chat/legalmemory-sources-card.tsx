"use client"

import { useState } from "react"
import { BookMarked, ChevronLeft, ChevronRight } from "lucide-react"

import { LEGALMEMORY_OPEN_EVENT } from "@/components/markdown/legalmemory-ref"
import { isAuthoritativeStatus, type LegalMemoryDocument } from "@/lib/legalmemory-documents"

const SOURCES_PER_PAGE = 5

/**
 * The sources under an answer.
 *
 * The retrieval steps above are what the model looked at, most of which did not
 * end up mattering. This is the other list: the documents the answer actually
 * rests on, which is the one a lawyer checks. Keeping them apart is the point,
 * because "what was searched" and "what this claim is based on" are different
 * questions and a single list conflating them answers neither.
 *
 * It is derived from the citations in the reply rather than from the tool
 * results, so it cannot drift from the prose. A document that was retrieved but
 * never cited does not appear, which is correct: it supported nothing.
 */
export function LegalMemorySourcesCard({
  documents,
  matters,
  streaming,
}: {
  documents: LegalMemoryDocument[]
  matters: Record<string, string>
  streaming: boolean
}) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(documents.length / SOURCES_PER_PAGE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageStart = currentPage * SOURCES_PER_PAGE
  const pagedDocuments = documents.slice(pageStart, pageStart + SOURCES_PER_PAGE)

  // Rendering mid-stream would grow the card a row at a time underneath a
  // paragraph still being written, moving the text the reader is reading.
  if (streaming) return null
  if (!documents.length) return null

  return (
    <section className="mt-3 w-full overflow-hidden rounded-xl border border-[var(--lw-border)] bg-[var(--lw-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--lw-border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--lw-text-secondary)]">
        <BookMarked className="size-3.5 text-[var(--lw-accent)]" />
        <span>Sources</span>
        <span className="ml-auto shrink-0 font-normal">
          {documents.length} {documents.length === 1 ? "document" : "documents"}
        </span>
      </div>
      <ul className="divide-y divide-[var(--lw-border-subtle)]">
        {pagedDocuments.map((document, index) => (
          <li key={document.documentId}>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent(LEGALMEMORY_OPEN_EVENT, {
                    detail: { documentId: document.documentId, label: document.title },
                  }),
                )
              }
              title={`Open ${document.title}`}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--lw-surface-hover)]"
            >
              <span className="w-4 shrink-0 text-right text-xs tabular-nums text-[var(--lw-text-tertiary)]">
                {pageStart + index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate text-sm font-medium text-[var(--lw-accent)]">{document.title}</span>
                  {document.versionStatus ? (
                    <span
                      className={
                        isAuthoritativeStatus(document.versionStatus)
                          ? "shrink-0 rounded-full bg-[var(--lw-success-soft)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--lw-success)]"
                          : "shrink-0 rounded-full border border-[var(--lw-border)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-[var(--lw-text-tertiary)]"
                      }
                    >
                      {document.versionStatus}
                    </span>
                  ) : null}
                </span>
                {document.matterId && matters[document.matterId] ? (
                  <span className="mt-0.5 block truncate text-xs text-[var(--lw-text-secondary)]">
                    {matters[document.matterId]}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {pageCount > 1 ? (
        <nav
          aria-label="Sources pagination"
          className="flex items-center justify-end gap-2 border-t border-[var(--lw-border-subtle)] px-3 py-2"
        >
          <button
            type="button"
            onClick={() => setPage(Math.max(0, currentPage - 1))}
            disabled={currentPage === 0}
            aria-label="Previous sources page"
            title="Previous page"
            className="grid size-7 place-items-center rounded-md text-[var(--lw-text-secondary)] transition-colors hover:bg-[var(--lw-surface-hover)] hover:text-[var(--lw-text)] disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="min-w-20 text-center text-xs tabular-nums text-[var(--lw-text-secondary)]">
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
            disabled={currentPage === pageCount - 1}
            aria-label="Next sources page"
            title="Next page"
            className="grid size-7 place-items-center rounded-md text-[var(--lw-text-secondary)] transition-colors hover:bg-[var(--lw-surface-hover)] hover:text-[var(--lw-text)] disabled:pointer-events-none disabled:opacity-35"
          >
            <ChevronRight className="size-4" />
          </button>
        </nav>
      ) : null}
    </section>
  )
}
