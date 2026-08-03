import { describe, expect, test } from "bun:test";
import { formatEdgeKind, parseLegalMemoryGraph } from "@/lib/legalmemory-graph";
import { isLegalMemoryGraphToolPart } from "@/lib/build-in-tools";

/** Mirrors what RetrievalService.find_related_documents returns. */
const RESULT = {
  root_document: {
    document_id: "doc-afl",
    version_id: "ver-afl-3",
    matter_id: "matter-meridian",
    title: "Agreement for Lease",
    doc_type: "agreement",
    version_status: "executed",
    citations: [{ document: { id: "doc-afl" } }],
  },
  related_documents: [
    { document_id: "doc-tsd", title: "Third Supplemental Deed", version_status: "executed", citations: [] },
    { document_id: "doc-s6", title: "Schedule 6 · Landlord's Works", version_status: "executed", citations: [] },
    { document_id: "doc-annex", title: "Annex 3 · Fee Schedule", version_status: "draft", citations: [] },
  ],
  edges: [
    {
      kind: "supersedes",
      basis: "stored_relation",
      from: { type: "document", id: "doc-tsd" },
      to: { type: "document", id: "doc-afl" },
    },
    {
      kind: "annex_of",
      basis: "stored_relation",
      from: { type: "document", id: "doc-annex" },
      to: { type: "document", id: "doc-tsd" },
    },
    {
      kind: "shared_matter",
      basis: "shared_matter",
      from: { type: "document", id: "doc-afl" },
      to: { type: "document", id: "doc-s6" },
    },
  ],
  result_count: 3,
};

describe("parseLegalMemoryGraph", () => {
  test("builds nodes and edges from the appliance payload", () => {
    const graph = parseLegalMemoryGraph(RESULT)!;
    expect(graph.root.title).toBe("Agreement for Lease");
    expect(graph.relatedCount).toBe(3);
    expect(graph.nodes).toHaveLength(4);
    expect(graph.edges).toHaveLength(3);
  });

  test("accepts the payload as serialized JSON, as MCP delivers it", () => {
    const graph = parseLegalMemoryGraph(JSON.stringify(RESULT))!;
    expect(graph.relatedCount).toBe(3);
  });

  test("keeps stored legal relations distinct from shared-matter context", () => {
    const graph = parseLegalMemoryGraph(RESULT)!;
    expect(graph.storedEdgeCount).toBe(2);
    const context = graph.edges.find((edge) => edge.kind === "shared_matter")!;
    expect(context.stored).toBe(false);
  });

  test("a stored relation wins when the same pair also arrives as context", () => {
    const graph = parseLegalMemoryGraph({
      ...RESULT,
      edges: [
        {
          kind: "shared_matter",
          basis: "shared_matter",
          from: { type: "document", id: "doc-afl" },
          to: { type: "document", id: "doc-tsd" },
        },
        {
          kind: "supersedes",
          basis: "stored_relation",
          from: { type: "document", id: "doc-tsd" },
          to: { type: "document", id: "doc-afl" },
        },
      ],
    })!;
    const between = graph.edges.filter(
      (edge) => [edge.from, edge.to].includes("doc-afl") && [edge.from, edge.to].includes("doc-tsd"),
    );
    expect(between).toHaveLength(1);
    expect(between[0]).toMatchObject({ kind: "supersedes", stored: true });
  });

  test("rings a document reachable only through another document outward", () => {
    const graph = parseLegalMemoryGraph(RESULT)!;
    const ringOf = (id: string) => graph.nodes.find((node) => node.id === id)!.ring;
    expect(ringOf("doc-afl")).toBe(0);
    expect(ringOf("doc-tsd")).toBe(1);
    // annex hangs off the supplemental deed, not off the root
    expect(ringOf("doc-annex")).toBe(2);
  });

  test("drops edge endpoints that are not documents", () => {
    const graph = parseLegalMemoryGraph({
      ...RESULT,
      edges: [
        {
          kind: "belongs_to_thread",
          basis: "stored_relation",
          from: { type: "document", id: "doc-afl" },
          to: { type: "thread", id: "thread-1" },
        },
      ],
    })!;
    expect(graph.edges).toHaveLength(0);
  });

  test("fits the viewBox to the nodes so small graphs carry no dead space", () => {
    const wide = parseLegalMemoryGraph(RESULT)!;
    const narrow = parseLegalMemoryGraph({
      ...RESULT,
      related_documents: RESULT.related_documents.slice(0, 1),
      edges: RESULT.edges.slice(0, 1),
    })!;
    const height = (graph: { viewBox: string }) => Number(graph.viewBox.split(" ")[3]);
    expect(height(narrow)).toBeLessThan(height(wide));
    // Every node stays inside the box, labels included.
    const [x, y, w, h] = wide.viewBox.split(" ").map(Number);
    for (const node of wide.nodes) {
      expect(node.x).toBeGreaterThan(x);
      expect(node.x).toBeLessThan(x + w);
      expect(node.y).toBeGreaterThan(y);
      expect(node.y).toBeLessThan(y + h);
    }
  });

  test("returns null rather than a blank card when the payload is unusable", () => {
    expect(parseLegalMemoryGraph(null)).toBeNull();
    expect(parseLegalMemoryGraph("not json")).toBeNull();
    expect(parseLegalMemoryGraph({ related_documents: [] })).toBeNull();
  });
});

describe("isLegalMemoryGraphToolPart", () => {
  const part = (toolName: string) => ({ type: "dynamic-tool" as const, toolName }) as never;

  test("matches whichever server name the firm connected under", () => {
    expect(isLegalMemoryGraphToolPart(part("legalmemory_find_related_documents"))).toBe(true);
    expect(isLegalMemoryGraphToolPart(part("knowledge-index_find_related_documents"))).toBe(true);
    expect(isLegalMemoryGraphToolPart(part("find_related_documents"))).toBe(true);
  });

  test("does not swallow other tools", () => {
    expect(isLegalMemoryGraphToolPart(part("legalmemory_search_semantic"))).toBe(false);
    expect(isLegalMemoryGraphToolPart(part("grep"))).toBe(false);
  });
});

describe("formatEdgeKind", () => {
  test("reads as prose in the edge label", () => {
    expect(formatEdgeKind("annex_of")).toBe("annex of");
    expect(formatEdgeKind("supersedes")).toBe("supersedes");
  });
});
