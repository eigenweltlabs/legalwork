"use client"

import { Network } from "lucide-react"

import type { LegalMemoryGraphToolPart } from "@/lib/build-in-tools"
import {
  formatEdgeKind,
  parseLegalMemoryGraph,
  type LegalMemoryGraphNode,
} from "@/lib/legalmemory-graph"
import { Tool } from "@/components/ui/tool"

interface LegalMemoryGraphToolProps {
  part: LegalMemoryGraphToolPart
}

const ROOT_RADIUS = 9
const NODE_RADIUS = 6
const OUTER_RADIUS = 4.5

function radiusOf(node: LegalMemoryGraphNode) {
  if (node.kind === "root") return ROOT_RADIUS
  return node.ring > 1 ? OUTER_RADIUS : NODE_RADIUS
}

/**
 * The matter graph for a LegalMemory document: what it supersedes, what annexes
 * it, what references it, and what merely shares its matter.
 *
 * Stored legal relations are solid and labeled; shared-matter and shared-thread
 * context is dashed and unlabeled, because "filed under the same matter" is not
 * a claim that one document varies another. Falling back to the generic tool
 * card whenever the payload doesn't parse keeps a shape change in the appliance
 * from blanking the transcript.
 */
export function LegalMemoryGraphTool({ part }: LegalMemoryGraphToolProps) {
  if (part.state !== "output-available") {
    return <Tool toolPart={part} />
  }

  const graph = parseLegalMemoryGraph(part.output)
  if (!graph || graph.relatedCount === 0) {
    return <Tool toolPart={part} />
  }

  const positions = new Map(graph.nodes.map((node) => [node.id, node]))

  return (
    <div className="w-full overflow-hidden rounded-xl border border-[var(--lw-border)] bg-[var(--lw-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--lw-border-subtle)] px-3 py-2 text-xs font-semibold text-[var(--lw-text-secondary)]">
        <Network className="size-3.5 text-[var(--lw-accent)]" />
        <span className="min-w-0 truncate">Matter graph · {graph.root.title}</span>
        <span className="ml-auto shrink-0 font-normal">
          {graph.relatedCount} linked {graph.relatedCount === 1 ? "document" : "documents"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={graph.viewBox}
          width="100%"
          className="block min-w-[420px]"
          role="img"
          aria-label={`Matter graph for ${graph.root.title}: ${graph.relatedCount} linked documents, ${graph.storedEdgeCount} stored legal relations`}
        >
          {graph.edges.map((edge) => {
            const from = positions.get(edge.from)
            const to = positions.get(edge.to)
            if (!from || !to) return null
            return (
              <g key={`${edge.from}-${edge.to}`}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="var(--lw-text-tertiary)"
                  strokeWidth={edge.stored ? 1.4 : 1}
                  strokeDasharray={edge.stored ? undefined : "3 3"}
                  opacity={edge.stored ? 0.75 : 0.4}
                />
                {edge.stored ? (
                  <text
                    x={(from.x + to.x) / 2}
                    y={(from.y + to.y) / 2 - 3}
                    textAnchor="middle"
                    className="text-[9px]"
                    fill="var(--lw-text-tertiary)"
                  >
                    {formatEdgeKind(edge.kind)}
                  </text>
                ) : null}
              </g>
            )
          })}

          {graph.nodes.map((node) => {
            const isRoot = node.kind === "root"
            const r = radiusOf(node)
            // Labels sit outward from the centre: above for the top half, below
            // for the bottom, so they never cross the edges converging on the hub.
            const above = node.y < graph.root.y && !isRoot
            const titleY = above ? node.y - r - 16 : node.y + r + 14
            const statusY = above ? node.y - r - 6 : node.y + r + 25
            const maxChars = isRoot ? 34 : node.ring > 1 ? 22 : 26
            return (
              <g key={node.id}>
                {isRoot ? (
                  <circle cx={node.x} cy={node.y} r={ROOT_RADIUS + 6} fill="var(--lw-accent)" opacity={0.16} />
                ) : null}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={r}
                  fill={isRoot ? "var(--lw-accent)" : "var(--lw-text-secondary)"}
                  opacity={node.ring > 1 ? 0.55 : 1}
                />
                <text
                  x={node.x}
                  y={titleY}
                  textAnchor="middle"
                  className={isRoot ? "text-[12px] font-semibold" : "text-[11px]"}
                  fill={isRoot ? "var(--lw-text-primary)" : "var(--lw-text-secondary)"}
                >
                  {node.title.length > maxChars ? `${node.title.slice(0, maxChars - 1)}…` : node.title}
                </text>
                {node.versionStatus ? (
                  <text
                    x={node.x}
                    y={statusY}
                    textAnchor="middle"
                    className="text-[9px] uppercase tracking-wide"
                    fill="var(--lw-text-tertiary)"
                  >
                    {node.versionStatus}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--lw-border-subtle)] px-3 py-2 text-[11px] text-[var(--lw-text-tertiary)]">
        <span className="flex items-center gap-1.5">
          <svg width="16" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          Stored legal relation
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="16" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" />
          </svg>
          Shared matter or thread
        </span>
        <span className="ml-auto">Permission-scoped to you</span>
      </div>
    </div>
  )
}
