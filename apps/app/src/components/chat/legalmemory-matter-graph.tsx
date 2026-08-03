"use client"

import { useQuery } from "@tanstack/react-query"

import { MatterGraph } from "@/components/tools/legalmemory-graph"
import { parseLegalMemoryGraph } from "@/lib/legalmemory-graph"
import type { LegalworkServerClient } from "@/app/lib/legalwork-server"

/**
 * The matter graph for the document an answer rests on.
 *
 * The agent is told to traverse before concluding and does not. Measured on a
 * real run against a live appliance: six semantic searches, three entity
 * resolutions, and not one call to find_related_documents. The engine exposes
 * no way to force a tool call, so an instruction is the only lever there is and
 * it is not enough.
 *
 * Stored relations are the part of this index a search cannot reproduce, which
 * makes them the part worth showing, so the app fetches them itself for the
 * first document the answer cited. Same principle as opening a source: work the
 * user asked for is the app's job, not a task handed to a model.
 */
export function LegalMemoryMatterGraph({
  rootDocumentId,
  streaming,
  client,
  workspaceId,
}: {
  rootDocumentId: string | null
  streaming: boolean
  client: LegalworkServerClient | null
  workspaceId: string | null
}) {
  // The first document the turn retrieved is what the answer is built on;
  // traversing every one would draw several graphs of mostly the same thing.
  const rootId = streaming ? null : rootDocumentId

  const { data } = useQuery({
    queryKey: ["legalmemory-graph", workspaceId, rootId] as const,
    enabled: Boolean(rootId && workspaceId && client),
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const result = await client!.legalMemoryGraph(workspaceId!, { document_id: rootId! })
      return parseLegalMemoryGraph(result.graph)
    },
  })

  // A document with no stored relations draws nothing rather than an empty card:
  // "no graph" and "a graph of one node" say different things and only one of
  // them is true.
  if (!data || data.relatedCount === 0) return null

  return <MatterGraph graph={data} />
}
