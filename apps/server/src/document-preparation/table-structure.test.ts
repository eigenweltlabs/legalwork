import { expect, test } from "bun:test";
import type { DocumentBox, DocumentRegion } from "@legalwork/types/document-structure";
import { buildTableStructure } from "./table-structure.js";

const table: DocumentRegion = { id: "table", kind: "table", label: "table",
  box: { x: .1, y: .1, width: .8, height: .8 }, text: "", ocrRegionIds: [], order: 0,
  writing: "printed", source: "layout+ocr" };
function line(text: string, x: number, y: number, width: number, height = .02): { text: string; box: DocumentBox } {
  return { text, box: { x, y, width, height } };
}

test("coordinate grid keeps numeric entries and marks cells uncertain", () => {
  const result = buildTableStructure(table, [
    line("Item", .12, .15, .2), line("Amount", .55, .15, .2),
    line("Rent", .12, .25, .2), line("1,250.00", .55, .25, .15),
    line("Tax", .12, .35, .2), line("250.00", .55, .35, .15),
  ]);
  expect(result).toMatchObject({ status: "uncertain", rows: 3, columns: 2 });
  expect(result.cells.map(cell => cell.text)).toEqual(["Item", "Amount", "Rent", "1,250.00", "Tax", "250.00"]);
  expect(result.cells.every(cell => cell.rowSpan === 1 && cell.columnSpan === 1)).toBe(true);
});

test("multiline OCR within one cell stays in the same row", () => {
  const result = buildTableStructure(table, [
    line("Description", .12, .15, .2), line("Amount", .55, .15, .2),
    line("A long", .12, .25, .2), line("10", .55, .25, .1),
    line("description", .12, .276, .2),
  ]);
  expect(result).toMatchObject({ status: "uncertain", rows: 2, columns: 2 });
  expect(result.cells.find(cell => cell.row === 1 && cell.column === 0)?.text).toBe("A long\ndescription");
});

test("one column, sparse boxes, and OCR crossing a column cut retain detection only", () => {
  expect(buildTableStructure(table, [line("A", .12, .15, .2), line("B", .12, .25, .2),
    line("C", .12, .35, .2), line("D", .12, .45, .2)])).toMatchObject({ status: "detected", cells: [] });
  expect(buildTableStructure(table, [line("A", .12, .15, .2), line("B", .55, .15, .2),
    line("C", .12, .25, .2)])).toMatchObject({ status: "detected", cells: [] });
  expect(buildTableStructure(table, [line("A", .12, .15, .2), line("B", .55, .15, .2),
    line("Spanning text", .12, .25, .7), line("C", .12, .35, .2), line("D", .55, .35, .2)]))
    .toMatchObject({ status: "detected", cells: [] });
});
