import { test, expect } from "bun:test";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { openWorkbook } from "../src/react-app/domains/session/artifacts/office-workbook";
const fixture = () => Bun.file(new URL("./fixtures/office-review.xlsx", import.meta.url)).arrayBuffer();
test("unchanged workbook is byte-for-byte identical", async () => {
  const buffer = await fixture(); const adapter = await openWorkbook(buffer, "test.xlsx");
  expect(new Uint8Array(await adapter.save(adapter.book))).toEqual(new Uint8Array(buffer));
  expect(adapter.book.sheetOrder).toHaveLength(2);
  expect(adapter.book.sheets["sheet-0"]?.freeze?.ySplit).toBe(3);
});
test("cell edits preserve charts, comments, validation, merges and freeze panes", async () => {
  const buffer = await fixture(); const adapter = await openWorkbook(buffer, "test.xlsx");
  const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.cellData![3]![1]!.v = 12;
  book.sheets["sheet-1"]!.cellData![0]![0]!.v = 0.2;
  const saved = await adapter.save(book); const reopened = XLSX.read(saved, { type: "array", cellFormula: true, sheetStubs: true });
  expect(reopened.Sheets["Matter budget"]?.B4.v).toBe(12);
  expect(reopened.Sheets["Matter budget"]?.D4.f).toBe("B4*C4");
  expect(reopened.Sheets.Rates?.A1.v).toBe(0.2);
  const original = await JSZip.loadAsync(buffer); const output = await JSZip.loadAsync(saved);
  for (const path of Object.keys(original.files).filter((path) => /chart|drawing|comment|vml/i.test(path))) {
    expect(await output.file(path)?.async("string")).toBe(await original.file(path)?.async("string"));
  }
  const xml = await output.file("xl/worksheets/sheet1.xml")!.async("string");
  expect(xml).toContain("dataValidations"); expect(xml).toContain('state="frozen"'); expect(xml).toContain('ref="A1:D1"');
  expect(await output.file("xl/workbook.xml")!.async("string")).toContain('fullCalcOnLoad="1"');
});
test("styles, formulas and repeated saves round-trip", async () => {
  const adapter = await openWorkbook(await fixture(), "test.xlsx"); const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.cellData![3]![1]!.s = { bl: 1, fs: 15, cl: { rgb: "#ab1234" }, n: { pattern: "0.00" }, ul: { s: 1 }, bd: { b: { s: 1, cl: { rgb: "#ab1234" } } } };
  book.sheets["sheet-0"]!.cellData![3]![3]!.f = "=B4*C4+100";
  const saved = await adapter.save(book); const reopened = await openWorkbook(saved, "test.xlsx");
  const cell = reopened.book.sheets["sheet-0"]!.cellData![3]![1]!;
  expect(typeof cell.s === "string" && reopened.book.styles[cell.s]?.bl).toBe(1);
  expect(typeof cell.s === "string" && reopened.book.styles[cell.s]?.ul?.s).toBe(1);
  expect(typeof cell.s === "string" && reopened.book.styles[cell.s]?.bd?.b?.cl.rgb).toBe("#ab1234");
  expect(reopened.book.sheets["sheet-0"]!.cellData![3]![3]!.f).toBe("=B4*C4+100");
  book.sheets["sheet-0"]!.cellData![3]![1]!.v = 21;
  expect(XLSX.read(await adapter.save(book), { type: "array" }).Sheets["Matter budget"]?.B4.v).toBe(21);
});
test("unsupported structure changes fail without modifying the source", async () => {
 const buffer = await fixture(); const adapter = await openWorkbook(buffer, "test.xlsx");
 const changed = structuredClone(adapter.book); changed.sheets["sheet-0"]!.name = "Renamed";
 await expect(adapter.save(changed)).rejects.toThrow("structure");
 expect(new Uint8Array(await adapter.save(adapter.book))).toEqual(new Uint8Array(buffer));
});

test("array formula result cells cannot be overwritten", async () => {
  const zip = await JSZip.loadAsync(await fixture());
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  zip.file("xl/worksheets/sheet1.xml", sheet.replace('<f>B4*C4</f>', '<f t="array" ref="D4:D6">B4:B6*C4:C6</f>'));
  const adapter = await openWorkbook(await zip.generateAsync({ type: "arraybuffer" }), "array.xlsx");
  const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.cellData![4]![3] = { v: 42, t: 2 };
  await expect(adapter.save(book)).rejects.toThrow("Array formula range");
});

test("calculated formula values and existing chart caches are updated together", async () => {
  const zip = await JSZip.loadAsync(await fixture());
  const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
  zip.file("xl/charts/chart1.xml", chart.replace("</numRef></val>", '<numCache><formatCode>General</formatCode><ptCount val="3"/><pt idx="0"><v>3500</v></pt><pt idx="1"><v>8000</v></pt><pt idx="2"><v>2500</v></pt></numCache></numRef></val>'));
  const adapter = await openWorkbook(await zip.generateAsync({ type: "arraybuffer" }), "cached.xlsx");
  const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.cellData![3]![1]!.v = 18;
  book.sheets["sheet-0"]!.cellData![3]![3]!.v = 6300;
  book.sheets["sheet-0"]!.cellData![4]![3]!.v = 8000;
  book.sheets["sheet-0"]!.cellData![5]![3]!.v = 2500;
  const saved = await adapter.save(book, true);
  expect(XLSX.read(saved, { type: "array" }).Sheets["Matter budget"]?.D4.v).toBe(6300);
  const output = await JSZip.loadAsync(saved);
  expect(await output.file("xl/charts/chart1.xml")!.async("string")).toContain(">6300<");
});

test("column resize and row height round-trip without losing adjacent dimensions or objects", async () => {
  const original = await JSZip.loadAsync(await fixture());
  const xml = await original.file("xl/worksheets/sheet1.xml")!.async("string");
  original.file("xl/worksheets/sheet1.xml", xml.replace(/<cols>[\s\S]*?<\/cols>/, '<cols><col min="1" max="4" width="20" customWidth="1" outlineLevel="1"/></cols>'));
  const buffer = await original.generateAsync({ type: "arraybuffer" });
  const adapter = await openWorkbook(buffer, "dimensions.xlsx");
  const book = structuredClone(adapter.book), sheet = book.sheets["sheet-0"]!;
  sheet.columnData![1]!.w = 300;
  sheet.rowData![3] = { ...sheet.rowData![3], h: 48 };
  const saved = await adapter.save(book), reopened = await openWorkbook(saved, "dimensions.xlsx");
  expect(reopened.book.sheets["sheet-0"]!.columnData![1]!.w).toBeCloseTo(300);
  expect(reopened.book.sheets["sheet-0"]!.columnData![0]!.w).toBe(145);
  expect(reopened.book.sheets["sheet-0"]!.columnData![2]!.w).toBe(145);
  expect(reopened.book.sheets["sheet-0"]!.rowData![3]!.h).toBe(48);
  const output = await JSZip.loadAsync(saved);
  expect(await output.file("xl/worksheets/sheet1.xml")!.async("string")).toContain('outlineLevel="1"');
  expect(await output.file("xl/charts/chart1.xml")!.async("string")).toBe(await original.file("xl/charts/chart1.xml")!.async("string"));
  expect(new Uint8Array(await reopened.save(reopened.book))).toEqual(new Uint8Array(saved));
});

test("dimension edits reject invalid sizes and still protect hidden columns", async () => {
  const adapter = await openWorkbook(await fixture(), "dimensions.xlsx");
  const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.columnData![0]!.w = NaN;
  await expect(adapter.save(book)).rejects.toThrow("Invalid column width");
  const hidden = structuredClone(adapter.book);
  hidden.sheets["sheet-0"]!.columnData![0]!.hd = 1;
  await expect(adapter.save(hidden)).rejects.toThrow("Column layout");
});

test("moving and clearing frozen panes persist without changing cells", async () => {
  const adapter = await openWorkbook(await fixture(), "freeze.xlsx");
  const book = structuredClone(adapter.book);
  book.sheets["sheet-0"]!.freeze = { startRow: 2, startColumn: 2, xSplit: 2, ySplit: 2 };
  const resized = await adapter.save(book), reopened = await openWorkbook(resized, "freeze.xlsx");
  expect(reopened.book.sheets["sheet-0"]!.freeze).toEqual(book.sheets["sheet-0"]!.freeze);
  reopened.book.sheets["sheet-0"]!.freeze = { startRow: -1, startColumn: -1, xSplit: 0, ySplit: 0 };
  const cleared = await reopened.save(reopened.book);
  const final = await openWorkbook(cleared, "freeze.xlsx");
  expect(final.book.sheets["sheet-0"]!.freeze?.xSplit).toBe(0);
  expect(final.book.sheets["sheet-0"]!.cellData![3]![3]!.f).toBe("=B4*C4");
});
