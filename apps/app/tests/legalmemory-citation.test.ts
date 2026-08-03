import { describe, expect, test } from "bun:test";
import { citedDocuments } from "@/components/markdown/legalmemory-ref";
describe("citedDocuments", () => {
  test("collects citations in order, deduped by id", () => {
    const t = "Per [[doc:a1|Agreement for Lease]] and [[doc:b2|Third Supplemental Deed]], and again [[doc:a1|AFL]].";
    expect(citedDocuments(t)).toEqual([
      { documentId: "a1", title: "Agreement for Lease" },
      { documentId: "b2", title: "Third Supplemental Deed" },
    ]);
  });
  test("ignores a half-streamed citation rather than mangling it", () => {
    expect(citedDocuments("as [[doc:a1|Agreem")).toEqual([]);
  });
  test("returns nothing when the answer cites nothing", () => {
    expect(citedDocuments("No documents here.")).toEqual([]);
  });
});
