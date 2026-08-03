import { describe, expect, test } from "bun:test";
import { citedDocuments } from "@/components/markdown/legalmemory-ref";

describe("citedDocuments", () => {
  // The form the model actually writes, taken verbatim from the session store.
  test("reads the markdown citation the model emits", () => {
    const t = "That's in [Series B Preferred Stock Financing](legalmemory://document/6f6b886d-211c-4c6d-9f13-bc2a) and nowhere else.";
    expect(citedDocuments(t)).toEqual([
      { documentId: "6f6b886d-211c-4c6d-9f13-bc2a", title: "Series B Preferred Stock Financing" },
    ]);
  });

  test("keeps prose order across a list of sources", () => {
    const t = `See [Agreement for Lease](legalmemory://document/a1).\n\n**Sources:**\n- [Third Supplemental Deed](legalmemory://document/b2)`;
    expect(citedDocuments(t).map((d) => d.documentId)).toEqual(["a1", "b2"]);
  });

  test("dedupes by id, first title wins", () => {
    const t = "[Agreement for Lease](legalmemory://document/a1) ... [AFL](legalmemory://document/a1)";
    expect(citedDocuments(t)).toEqual([{ documentId: "a1", title: "Agreement for Lease" }]);
  });

  test("still accepts the bracket form for anything already written", () => {
    expect(citedDocuments("as [[doc:a1|Agreement for Lease]]")).toEqual([
      { documentId: "a1", title: "Agreement for Lease" },
    ]);
  });

  test("ignores a half-streamed citation rather than mangling it", () => {
    expect(citedDocuments("as [Agreement for Lease](legalmemory://docu")).toEqual([]);
  });

  test("returns nothing when the answer cites nothing", () => {
    expect(citedDocuments("No documents here.")).toEqual([]);
  });
});
