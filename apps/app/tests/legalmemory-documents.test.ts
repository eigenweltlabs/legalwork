import { describe, expect, test } from "bun:test";
import { collectLegalMemoryDocuments, isAuthoritativeStatus } from "@/lib/legalmemory-documents";

/** One hit, captured verbatim from a live appliance search_semantic result. */
const REAL_HIT = {
  document_id: "6f6b886d-211c-4c6d-9f13-bc2ce4b29c6e",
  title: "Series B Preferred Stock Financing",
  doc_type_label: "Term Sheet",
  version_status: "executed",
  excerpt: "**1.4 Pre-Money Valuation**\n\n**Pre-Money Valuation:** $130,000,000.",
  matter_id: "d392e7fe-af11-4ec4-9885-5777a69448df",
  citations: [{ source_objects: [{ connector: { display_name: "Index" } }] }],
};

describe("collectLegalMemoryDocuments", () => {
  test("pulls the document straight out of a real search result", () => {
    expect(collectLegalMemoryDocuments([[REAL_HIT]])).toEqual([
      {
        documentId: "6f6b886d-211c-4c6d-9f13-bc2ce4b29c6e",
        title: "Series B Preferred Stock Financing",
        versionStatus: "executed",
        matterId: "d392e7fe-af11-4ec4-9885-5777a69448df",
      },
    ]);
  });

  test("accepts the serialized form the tool part actually carries", () => {
    expect(collectLegalMemoryDocuments([JSON.stringify([REAL_HIT])])).toHaveLength(1);
  });

  test("dedupes a document that several chunks matched", () => {
    expect(collectLegalMemoryDocuments([[REAL_HIT, { ...REAL_HIT }]])).toHaveLength(1);
  });

  // The connector name reads "Index" for every row, which tells a reader
  // nothing; the matter is the useful context, so that is what is kept.
  test("keeps the matter id, not the connector name", () => {
    const doc = collectLegalMemoryDocuments([[REAL_HIT]])[0];
    expect(doc.matterId).toBe("d392e7fe-af11-4ec4-9885-5777a69448df");
    expect("system" in doc).toBe(false);
  });

  test("handles the find_related_documents shape, root first", () => {
    const graph = {
      root_document: { document_id: "r", title: "Root" },
      related_documents: [{ document_id: "x", title: "Annex" }],
    };
    expect(collectLegalMemoryDocuments([graph]).map((d) => d.documentId)).toEqual(["r", "x"]);
  });

  test("collects across several tool results in order", () => {
    const later = { document_id: "z9", title: "Supplemental Deed" };
    expect(collectLegalMemoryDocuments([[REAL_HIT], [later]]).map((d) => d.title)).toEqual([
      "Series B Preferred Stock Financing",
      "Supplemental Deed",
    ]);
  });

  test("ignores payloads that name no document", () => {
    expect(collectLegalMemoryDocuments([null, "not json", [], {}])).toEqual([]);
  });
});

describe("isAuthoritativeStatus", () => {
  test("marks operative versions, not drafts", () => {
    expect(isAuthoritativeStatus("executed")).toBe(true);
    expect(isAuthoritativeStatus("Final")).toBe(true);
    expect(isAuthoritativeStatus("draft")).toBe(false);
    expect(isAuthoritativeStatus(undefined)).toBe(false);
  });
});
