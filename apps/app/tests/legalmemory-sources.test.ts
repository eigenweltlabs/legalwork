import { describe, expect, test } from "bun:test";
import { isAuthoritativeStatus, parseLegalMemorySources } from "@/lib/legalmemory-sources";
import { isLegalMemorySearchToolPart } from "@/lib/build-in-tools";

/** Mirrors RetrievalService search hits (`SearchHit.as_dict`). */
const HIT = {
  document_id: "doc-afl",
  project_id: "proj-1",
  version_id: "ver-afl-3",
  matter_id: "matter-meridian",
  title: "Agreement for Lease",
  doc_type: "agreement",
  doc_type_label: "Agreement",
  version_status: "executed",
  score: 0.91,
  excerpt: "the Tenant may terminate this Agreement   by written notice\nserved within five Business Days",
  source_paths: ["/Meridian/AFL.docx"],
  matched_identifiers: [],
  citations: [
    {
      document: { id: "doc-afl" },
      source_objects: [
        { id: "so-1", path: "/Meridian/AFL.docx", connector: { display_name: "iManage", provider: "imanage" } },
      ],
    },
  ],
};

describe("parseLegalMemorySources", () => {
  test("builds a source row from a search hit", () => {
    const { sources } = parseLegalMemorySources([HIT])!;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      documentId: "doc-afl",
      title: "Agreement for Lease",
      docType: "Agreement",
      versionStatus: "executed",
      system: "iManage",
    });
  });

  test("accepts the payload as serialized JSON, as MCP delivers it", () => {
    expect(parseLegalMemorySources(JSON.stringify([HIT]))!.sources).toHaveLength(1);
  });

  test("collapses an excerpt to one readable line", () => {
    const { sources } = parseLegalMemorySources([HIT])!;
    expect(sources[0].excerpt).toBe(
      "the Tenant may terminate this Agreement by written notice served within five Business Days",
    );
  });

  test("falls back to the provider slug when the connector was never named", () => {
    const hit = {
      ...HIT,
      citations: [{ source_objects: [{ connector: { provider: "sharepoint" } }] }],
    };
    expect(parseLegalMemorySources([hit])!.sources[0].system).toBe("sharepoint");
  });

  test("drops a hit with no citations rather than presenting it as a source", () => {
    expect(parseLegalMemorySources([{ ...HIT, citations: [] }])).toBeNull();
  });

  test("keeps only the best-ranked hit per document", () => {
    const second = { ...HIT, score: 0.4, excerpt: "a lower-ranked chunk of the same document" };
    const { sources } = parseLegalMemorySources([HIT, second])!;
    expect(sources).toHaveLength(1);
    expect(sources[0].excerpt).toContain("the Tenant may terminate");
  });

  test("returns null for an unusable or empty payload", () => {
    expect(parseLegalMemorySources(null)).toBeNull();
    expect(parseLegalMemorySources("not json")).toBeNull();
    expect(parseLegalMemorySources([])).toBeNull();
    expect(parseLegalMemorySources({ hits: [HIT] })).toBeNull();
  });
});

describe("isAuthoritativeStatus", () => {
  test("marks operative versions, not drafts", () => {
    expect(isAuthoritativeStatus("executed")).toBe(true);
    expect(isAuthoritativeStatus("Final")).toBe(true);
    expect(isAuthoritativeStatus("draft")).toBe(false);
    expect(isAuthoritativeStatus("redline")).toBe(false);
    expect(isAuthoritativeStatus(undefined)).toBe(false);
  });
});

describe("isLegalMemorySearchToolPart", () => {
  const part = (toolName: string) => ({ type: "dynamic-tool" as const, toolName }) as never;

  test("matches both retrieval entry points under any server name", () => {
    expect(isLegalMemorySearchToolPart(part("legalmemory_search_semantic"))).toBe(true);
    expect(isLegalMemorySearchToolPart(part("knowledge-index_search_filter"))).toBe(true);
    expect(isLegalMemorySearchToolPart(part("search_semantic"))).toBe(true);
  });

  test("does not swallow other tools", () => {
    expect(isLegalMemorySearchToolPart(part("legalmemory_find_related_documents"))).toBe(false);
    expect(isLegalMemorySearchToolPart(part("legalmemory_search_decisions"))).toBe(false);
    expect(isLegalMemorySearchToolPart(part("grep"))).toBe(false);
  });
});
