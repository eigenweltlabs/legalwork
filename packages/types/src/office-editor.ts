import { z } from "zod";

const path = z.string().min(1).describe("Exact file path returned by inapp_documents_list. Must match the active editor.");
export const officeFileSchema = z.object({ path });
export function officeRange(range: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(range.includes(":") ? range : `${range}:${range}`);
  if (!match) throw new Error("Use a bounded A1 range, for example A1:D10.");
  const col = (letters: string) => [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const startRow = Number(match[2]) - 1, endRow = Number(match[4]) - 1;
  const startColumn = col(match[1]!), endColumn = col(match[3]!);
  if (endRow < startRow || endColumn < startColumn || endRow >= 100000 || endColumn >= 1000 || (endRow - startRow + 1) * (endColumn - startColumn + 1) > 5000) throw new Error("Use an ordered range of at most 5,000 cells within rows 1–100,000 and columns A–ALL.");
  return { startRow, endRow, startColumn, endColumn };
}
const range = z.string().refine((value) => { try { officeRange(value); return true; } catch { return false; } }, "Invalid or oversized A1 range.");
export const xlsxReadSchema = z.object({ path, sheet: z.string().optional().describe("Sheet name; defaults to the active sheet."), range: range.optional().describe("Bounded A1 range; defaults to A1:T50. Read in pages for larger workbooks.") });
export const xlsxWriteSchema = z.object({ path, sheet: z.string().min(1), range, values: z.array(z.array(z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()])).min(1)).min(1).max(5000).describe("Rectangular values matching the range. Strings beginning '=' are formulas. Null clears a cell. Formatting is retained.") });
export const pptxReadSchema = z.object({ path, slideIndex: z.number().int().min(0).optional().describe("Zero-based slide index; defaults to active slide. Includes a slide inventory.") });
export const pptxReplaceSchema = z.object({ path, slideIndex: z.number().int().min(0), elementId: z.string().min(1).describe("Text/shape ID from inapp_pptx_read."), search: z.string().min(1).max(32767).describe("Exact unique text within the element."), replaceWith: z.string().max(32767) });
