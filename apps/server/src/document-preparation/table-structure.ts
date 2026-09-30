import type { DocumentBox, DocumentRegion, DocumentTable } from "@legalwork/types/document-structure";
import type { OcrContent } from "../ocr/types.js";

type OcrBox = { text: string; box: DocumentBox; table?: OcrContent["regions"][number]["table"] };
type Row = OcrBox[];

function centerX(item: OcrBox): number { return item.box.x + item.box.width / 2; }
function centerY(item: OcrBox): number { return item.box.y + item.box.height / 2; }
function union(items: OcrBox[]): DocumentBox {
  const x = Math.min(...items.map(item => item.box.x));
  const y = Math.min(...items.map(item => item.box.y));
  const right = Math.max(...items.map(item => item.box.x + item.box.width));
  const bottom = Math.max(...items.map(item => item.box.y + item.box.height));
  return { x, y, width: right - x, height: bottom - y };
}
function detected(regionId: string, reason: string): DocumentTable {
  return { regionId, rows: 0, columns: 0, cells: [], status: "detected", method: reason };
}

/** Builds only cells supported by OCR line boxes. It does not infer spanning or merged cells. */
export function buildTableStructure(region: DocumentRegion, ocrRegions: OcrBox[]): DocumentTable {
  if (region.kind !== "table") return detected(region.id, "not-a-table-region");
  // Table recognition (PaddleOCR-VL) returns the grid itself; its cells share the table's box.
  const recognized = region.ocrRegionIds.map(id => ocrRegions[id]?.table).find(table => table?.cells.length);
  if (recognized) return { regionId: region.id, rows: recognized.rows, columns: recognized.columns, status: "parsed", method: "vl-table-recognition",
    cells: recognized.cells.map(cell => ({ id: `${region.id}-r${cell.row}c${cell.column}`, ...cell, box: region.box, regionIds: [] })) };
  const lines = ocrRegions.filter(item => item.text.trim()
    && centerX(item) >= region.box.x && centerX(item) <= region.box.x + region.box.width
    && centerY(item) >= region.box.y && centerY(item) <= region.box.y + region.box.height)
    .sort((a, b) => centerY(a) - centerY(b) || a.box.x - b.box.x);
  if (lines.length < 4) return detected(region.id, "insufficient-ocr-boxes");
  const heights = lines.map(item => item.box.height).sort((a, b) => a - b);
  const rowTolerance = Math.max(.008, Math.min(.025, heights[Math.floor(heights.length / 2)] * .55));
  const bands: Row[] = [];
  for (const line of lines) {
    const current = bands.at(-1);
    if (current && Math.abs(centerY(line) - centerY(current[0])) <= rowTolerance) current.push(line);
    else bands.push([line]);
  }
  const seed = bands.filter(row => row.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!seed || seed.length > 12) return detected(region.id, "no-repeating-column-grid");
  const anchors = [...seed].sort((a, b) => a.box.x - b.box.x);
  const cuts: number[] = [];
  for (let column = 0; column < anchors.length - 1; column++) {
    const left = anchors[column];
    const right = anchors[column + 1];
    const gap = right.box.x - left.box.x - left.box.width;
    if (gap < .008) return detected(region.id, "overlapping-column-boxes");
    cuts.push(left.box.x + left.box.width + gap / 2);
  }
  const columnFor = (item: OcrBox): number | undefined => {
    if (cuts.some(cut => item.box.x < cut - .004 && item.box.x + item.box.width > cut + .004)) return;
    return cuts.findIndex(cut => centerX(item) < cut) === -1 ? cuts.length : cuts.findIndex(cut => centerX(item) < cut);
  };
  const rows: Array<Map<number, OcrBox[]>> = [];
  for (const band of bands) {
    const cells = new Map<number, OcrBox[]>();
    for (const line of band) {
      const column = columnFor(line);
      if (column === undefined) return detected(region.id, "ocr-box-crosses-column-boundary");
      cells.set(column, [...cells.get(column) ?? [], line]);
    }
    if (band.length === 1 && rows.length) {
      const column = [...cells.keys()][0];
      const previous = rows.at(-1);
      const previousCell = previous?.get(column);
      const previousBottom = previousCell ? Math.max(...previousCell.map(item => item.box.y + item.box.height)) : -1;
      if (previousCell && band[0].box.y - previousBottom >= 0 && band[0].box.y - previousBottom <= .01) {
        previousCell.push(band[0]);
        continue;
      }
    }
    rows.push(cells);
  }
  const complete = rows.filter(row => row.size === anchors.length);
  if (complete.length < 2 || rows.some(row => row.size < 1)) return detected(region.id, "no-repeating-column-grid");
  const cells: DocumentTable["cells"] = [];
  rows.forEach((row, rowIndex) => {
    for (const [column, items] of row) {
      cells.push({ id: `${region.id}-r${rowIndex}c${column}`, row: rowIndex, column,
        rowSpan: 1, columnSpan: 1, box: union(items), text: items.sort((a, b) => centerY(a) - centerY(b))
          .map(item => item.text.trim()).join("\n"), regionIds: [] });
    }
  });
  return { regionId: region.id, rows: rows.length, columns: anchors.length, cells,
    status: "uncertain", method: "ocr-coordinate-grid" };
}
