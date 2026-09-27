import { z } from "zod";

export const DocumentBoxSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
}).refine(box => box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001);
export const DocumentRegionSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["text", "heading", "list", "table", "figure", "caption", "header", "footer", "footnote", "formula", "note", "unknown"]),
  label: z.string().max(100), box: DocumentBoxSchema, text: z.string().max(100_000),
  ocrRegionIds: z.array(z.number().int().nonnegative()).max(20000),
  order: z.number().int().nonnegative().nullable(), confidence: z.number().min(0).max(1).optional(),
  writing: z.enum(["printed", "handwritten", "unknown"]).default("unknown"),
  source: z.enum(["layout+ocr", "ocr", "provider", "layout"]),
});
export const DocumentCellSchema = z.object({
  id: z.string().min(1).max(100), row: z.number().int().nonnegative(), column: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive(), columnSpan: z.number().int().positive(),
  box: DocumentBoxSchema, text: z.string().max(100_000), regionIds: z.array(z.string()).max(20000),
});
export const DocumentTableSchema = z.object({
  regionId: z.string(), rows: z.number().int().nonnegative(), columns: z.number().int().nonnegative(),
  cells: z.array(DocumentCellSchema).max(20000),
  status: z.enum(["detected", "parsed", "uncertain"]), method: z.string().max(200),
});
export const DocumentMarkSchema = z.object({
  id: z.string().max(100), kind: z.enum(["arrow", "strikeout"]), box: DocumentBoxSchema,
  start: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  end: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  confidence: z.number().min(0).max(1),
});
export const PageStructureSchema = z.object({
  version: z.literal("document-structure-1"), model: z.string().max(200),
  status: z.enum(["complete", "partial", "unavailable"]),
  regions: z.array(DocumentRegionSchema).max(21000),
  readingOrder: z.array(z.string()).max(21000), tables: z.array(DocumentTableSchema).max(1000),
  marks: z.array(DocumentMarkSchema).max(2000), issues: z.array(z.string().max(500)).max(1000),
});
export const DocumentRelationSchema = z.object({
  id: z.string().max(200), kind: z.enum(["continues", "table-continues", "references", "annotates", "amends", "replaces", "deletes"]),
  source: z.object({ page: z.number().int().positive(), regionId: z.string() }),
  target: z.object({ page: z.number().int().positive(), regionId: z.string() }),
  status: z.enum(["supported", "candidate"]),
  basis: z.enum(["text-reference", "numbering", "page-boundary", "table-columns", "arrow", "strikeout", "proximity"]),
  explanation: z.string().max(500),
});
export type DocumentBox = z.infer<typeof DocumentBoxSchema>;
export type DocumentRegion = z.infer<typeof DocumentRegionSchema>;
export type DocumentTable = z.infer<typeof DocumentTableSchema>;
export type DocumentMark = z.infer<typeof DocumentMarkSchema>;
export type PageStructure = z.infer<typeof PageStructureSchema>;
export type DocumentRelation = z.infer<typeof DocumentRelationSchema>;
