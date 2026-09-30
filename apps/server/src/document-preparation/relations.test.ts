import { expect, test } from "bun:test";
import type { DocumentRegion, DocumentTable, PageStructure } from "@legalwork/types/document-structure";
import { linkDocumentStructure } from "./relations.js";

function region(id: string, kind: DocumentRegion["kind"], text: string, x: number, y: number,
  width = .75, height = .08): DocumentRegion {
  return { id, kind, label: kind, text, box: { x, y, width, height }, ocrRegionIds: [],
    order: 0, writing: "unknown", source: "ocr" };
}
function structure(regions: DocumentRegion[], overrides: Partial<PageStructure> = {}): PageStructure {
  return { version: "document-structure-1", model: "fixture", status: "complete", regions,
    readingOrder: regions.map(item => item.id), tables: [], marks: [], issues: [], ...overrides };
}
function table(regionId: string, header: string[]): DocumentTable {
  return { regionId, rows: 2, columns: header.length, status: "parsed", method: "fixture",
    cells: header.map((text, column) => ({ id: `${regionId}-${column}`, row: 0, column,
      rowSpan: 1, columnSpan: 1, box: { x: .1 + column * .38, y: .1, width: .35, height: .05 }, text, regionIds: [] })) };
}

test("explicit German and English references link to observed numbered targets", () => {
  const page = structure([
    region("clause", "heading", "4.1 Zahlungsfrist", .1, .1),
    region("note", "note", "Siehe Ziffer 4.1; see clause 4.1.", .01, .4, .08),
  ]);
  const links = linkDocumentStructure([{ page: 1, structure: page }]);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ kind: "references", status: "supported", basis: "text-reference",
    source: { page: 1, regionId: "note" }, target: { page: 1, regionId: "clause" } });
});

test("amendment wording and ambiguous numbering remain candidates", () => {
  const page = structure([
    region("h1", "heading", "§ 5 Payment", .1, .1), region("h2", "heading", "5 Other", .1, .2),
    region("note", "note", "Replace § 5 with the attached text.", .01, .3, .08),
  ]);
  const links = linkDocumentStructure([{ page: 1, structure: page }]);
  expect(links).toHaveLength(2);
  expect(links.every(link => link.kind === "replaces" && link.status === "candidate")).toBe(true);
  expect(new Set(links.map(link => link.target.regionId))).toEqual(new Set(["h1", "h2"]));
});

test("German amendment wording yields candidate relations without claiming validity", () => {
  const page = structure([
    region("h", "heading", "§ 7 Laufzeit", .1, .1),
    region("note", "note", "Ändert § 7 ab sofort.", .01, .3, .08),
  ]);
  expect(linkDocumentStructure([{ page: 1, structure: page }]))
    .toContainEqual(expect.objectContaining({ kind: "amends", status: "candidate", basis: "text-reference" }));
});

test("explicit insertion location links to observed clause as a candidate amendment", () => {
  const page = structure([
    region("h", "heading", "Section 4 Miscellaneous", .1, .1),
    region("instruction", "note", "Insert the attached paragraph after Section 4.", .01, .3, .08),
  ]);
  expect(linkDocumentStructure([{ page: 1, structure: page }]))
    .toContainEqual(expect.objectContaining({ kind: "amends", status: "candidate", basis: "text-reference",
      source: { page: 1, regionId: "instruction" }, target: { page: 1, regionId: "h" } }));
});

test("unrelated margin notes, numbers, headers, and unknown targets make no links", () => {
  const page = structure([
    region("h", "heading", "4.1 Terms", .1, .1),
    region("margin", "note", "4.1", .01, .3, .08),
    region("header", "header", "See clause 4.1", .1, .01),
    region("unknown", "note", "See clause 99.9", .01, .5, .08),
    region("mention", "text", "Clause 4.1 sets out the payment terms.", .1, .7),
  ]);
  expect(linkDocumentStructure([{ page: 1, structure: page }])).toEqual([]);
});

test("adjacent complete pages may have a candidate paragraph continuation", () => {
  const first = structure([region("p1", "text", "The payment will be made in", .1, .84, .75, .12),
    region("footer", "footer", "1", .1, .98, .75, .01)]);
  const second = structure([region("header", "header", "Agreement", .1, .01),
    region("p2", "text", "the following installments.", .1, .06)]);
  expect(linkDocumentStructure([{ page: 1, structure: first }, { page: 2, structure: second }]))
    .toContainEqual(expect.objectContaining({ kind: "continues", status: "candidate",
      source: { page: 1, regionId: "p1" }, target: { page: 2, regionId: "p2" } }));
  expect(linkDocumentStructure([{ page: 1, structure: first }, { page: 3, structure: second }])).toEqual([]);
  expect(linkDocumentStructure([{ page: 1, structure: first },
    { page: 2, structure: structure(second.regions, { status: "partial" }) }])).toEqual([]);
});

test("table continuation requires matching observed column count and repeated header", () => {
  const a = region("a", "table", "Item Amount", .1, .82, .75, .16);
  const b = region("b", "table", "Item Amount", .1, .05, .75, .2);
  const pageA = structure([a], { tables: [table("a", ["Item", "Amount"])] });
  const pageB = structure([b], { tables: [table("b", ["Item", "Amount"])] });
  expect(linkDocumentStructure([{ page: 1, structure: pageA }, { page: 2, structure: pageB }]))
    .toContainEqual(expect.objectContaining({ kind: "table-continues", status: "candidate" }));
  pageA.status = "partial";
  pageB.status = "partial";
  expect(linkDocumentStructure([{ page: 1, structure: pageA }, { page: 2, structure: pageB }]))
    .toContainEqual(expect.objectContaining({ kind: "table-continues", status: "candidate" }));
  pageB.tables = [table("b", ["Item", "Price"])];
  expect(linkDocumentStructure([{ page: 1, structure: pageA }, { page: 2, structure: pageB }])).toEqual([]);
  const shifted = table("b", ["Item", "Amount"]);
  shifted.cells[1].box.x += .12;
  pageB.tables = [shifted];
  expect(linkDocumentStructure([{ page: 1, structure: pageA }, { page: 2, structure: pageB }])).toEqual([]);
});

test("missing or duplicate page and region endpoints prevent reference links", () => {
  const source = structure([region("note", "note", "See clause 4.1", .01, .3, .08)]);
  const target = structure([region("heading", "heading", "4.1 Payment", .1, .1)]);
  expect(linkDocumentStructure([{ page: 1, structure: source }, { page: 3, structure: target }])).toEqual([]);
  expect(linkDocumentStructure([{ page: 1, structure: source }, { page: 2, structure: null },
    { page: 3, structure: target }])).toEqual([]);
  expect(linkDocumentStructure([{ page: 1, structure: source }, { page: 2, structure: target },
    { page: 2, structure: target }])).toEqual([]);
  const duplicateIds = structure([target.regions[0], region("heading", "heading", "4.1 Other", .1, .2)]);
  expect(linkDocumentStructure([{ page: 1, structure: source }, { page: 2, structure: duplicateIds }])).toEqual([]);
});
