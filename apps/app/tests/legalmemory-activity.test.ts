import { describe, expect, test } from "bun:test";
import { legalMemoryActivityLabel, legalMemoryToolName } from "@/lib/legalmemory-activity";
import { isLegalMemoryToolPart } from "@/lib/build-in-tools";

describe("legalMemoryToolName", () => {
  test("strips whichever server name the firm connected under", () => {
    expect(legalMemoryToolName("legalmemory_search_semantic")).toBe("search_semantic");
    expect(legalMemoryToolName("knowledge-index_search_semantic")).toBe("search_semantic");
    expect(legalMemoryToolName("search_semantic")).toBe("search_semantic");
  });

  test("rejects tools the appliance does not register", () => {
    expect(legalMemoryToolName("legalmemory_delete_everything")).toBeNull();
    expect(legalMemoryToolName("grep")).toBeNull();
  });
});

describe("legalMemoryActivityLabel", () => {
  test("names the query being searched", () => {
    expect(legalMemoryActivityLabel("legalmemory_search_semantic", { query: "longstop date" })).toBe(
      "Searching firm knowledge for “longstop date”",
    );
  });

  test("falls back when the query has not streamed in yet", () => {
    expect(legalMemoryActivityLabel("legalmemory_search_semantic", {})).toBe("Searching firm knowledge");
    expect(legalMemoryActivityLabel("legalmemory_search_semantic", undefined)).toBe(
      "Searching firm knowledge",
    );
  });

  test("distinguishes a final-versions-only filter, the behavior that matters", () => {
    expect(legalMemoryActivityLabel("legalmemory_search_filter", { only_final: true })).toBe(
      "Filtering to executed and effective documents",
    );
    expect(legalMemoryActivityLabel("legalmemory_search_filter", {})).toBe(
      "Filtering firm documents by legal metadata",
    );
  });

  test("describes graph and precedence work as such", () => {
    expect(legalMemoryActivityLabel("legalmemory_find_related_documents", {})).toBe(
      "Resolving amendments, annexes and precedence",
    );
    expect(legalMemoryActivityLabel("legalmemory_traverse", {})).toBe(
      "Following stored document relations",
    );
  });

  test("groups the ontology tools under one line", () => {
    for (const tool of ["list_taxonomies", "ontology_search", "ontology_children", "ontology_node"]) {
      expect(legalMemoryActivityLabel(`legalmemory_${tool}`, {})).toBe("Consulting the firm ontology");
    }
  });

  test("returns null for a tool that is not LegalMemory's", () => {
    expect(legalMemoryActivityLabel("bash", { command: "ls" })).toBeNull();
  });
});

describe("isLegalMemoryToolPart", () => {
  const part = (toolName: string) => ({ type: "dynamic-tool" as const, toolName }) as never;

  test("covers the whole appliance tool surface", () => {
    expect(isLegalMemoryToolPart(part("legalmemory_billing_rollup"))).toBe(true);
    expect(isLegalMemoryToolPart(part("legalmemory_preview_search_scope"))).toBe(true);
    expect(isLegalMemoryToolPart(part("knowledge-index_download_document"))).toBe(true);
  });

  test("does not claim unrelated tools", () => {
    expect(isLegalMemoryToolPart(part("bash"))).toBe(false);
    expect(isLegalMemoryToolPart(part("notion_search"))).toBe(false);
  });
});
