import type { DocumentBox, DocumentRegion, PageStructure } from "@legalwork/types/document-structure";
import type { OcrContent } from "../ocr/types.js";
import { buildTableStructure } from "./table-structure.js";

export type LayoutDetection = {
  model: string;
  regions: Array<{ label: string; box: DocumentBox; confidence: number; order: number }>;
};
export interface DocumentLayout {
  readonly fingerprint: string;
  detect(page: import("../ocr/types.js").OcrPage, signal: AbortSignal): Promise<LayoutDetection>;
}
const kinds: Record<string, DocumentRegion["kind"]> = {
  text: "text", content: "text", abstract: "text", reference_content: "text", vertical_text: "text",
  doc_title: "heading", paragraph_title: "heading", table: "table", image: "figure", chart: "figure",
  seal: "figure", header_image: "header", footer_image: "footer", figure_title: "caption",
  header: "header", footer: "footer", number: "footer", footnote: "footnote", vision_footnote: "footnote",
  aside_text: "note", display_formula: "formula", inline_formula: "formula", formula_number: "formula",
};
function coverage(inner: DocumentBox, outer: DocumentBox) {
  const width = Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x));
  const height = Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
  return width * height / (inner.width * inner.height);
}

/** Associate observed OCR coordinates with layout blocks; never discard unmatched text. */
export function assemblePageStructure(page: number, ocr: OcrContent, detection: LayoutDetection): PageStructure {
  const issues: string[] = [];
  const regions: DocumentRegion[] = [...detection.regions].sort((a, b) => a.order - b.order).map((region, index) => ({
    id: `p${page}-r${index + 1}`, kind: kinds[region.label] ?? "unknown", label: region.label,
    box: region.box, confidence: region.confidence, text: "", ocrRegionIds: [], order: index,
    writing: "unknown", source: "layout",
  }));
  for (const [id, line] of ocr.regions.entries()) {
    // Prefer the most specific containing block when the detector returns overlapping boxes.
    const candidates = regions.filter(region => region.source !== "ocr" && coverage(line.box, region.box) >= 0.6)
      .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    const target = candidates.at(-1);
    if (target) { target.ocrRegionIds.push(id); target.source = "layout+ocr"; }
    else regions.push({ id: `p${page}-ocr${id}`, kind: "text", label: "unclassified text", box: line.box,
      text: line.text, ocrRegionIds: [id], order: null, confidence: line.confidence, writing: "unknown", source: "ocr" });
  }
  for (const region of regions.filter(region => region.source === "layout+ocr")) {
    // Line order from the OCR provider preserves scripts and multiline table content.
    region.text = region.ocrRegionIds.map(id => ocr.regions[id]!.text).join("\n");
    if (region.text.length > 100_000) { region.text = region.text.slice(0, 100_000); issues.push("region-text-truncated"); }
  }
  if (ocr.text.trim() && !ocr.regions.length) issues.push("ocr-coordinates-unavailable");
  if (!detection.regions.length) issues.push("layout-regions-unavailable");
  // Keep the detector's column-aware sequence. Insert unmatched OCR near its closest block.
  const layoutOrder = regions.filter(region => region.order !== null);
  const buckets = new Map<string, DocumentRegion[]>();
  const unmatched = regions.filter(region => region.order === null);
  for (const region of unmatched) {
    const nearest = layoutOrder.reduce<DocumentRegion | undefined>((best, item) => {
      const distance = (candidate: DocumentRegion) => Math.abs(candidate.box.y - region.box.y) + Math.abs(candidate.box.x - region.box.x) * 0.3;
      return !best || distance(item) < distance(best) ? item : best;
    }, undefined);
    if (!nearest) continue;
    const key = `${nearest.id}:${region.box.y >= nearest.box.y ? "after" : "before"}`;
    buckets.set(key, [...buckets.get(key) ?? [], region]);
  }
  // Bucket against original layout blocks only; retain OCR order within each insertion point.
  const ordered = layoutOrder.length ? layoutOrder.flatMap(region => [
    ...buckets.get(`${region.id}:before`) ?? [], region, ...buckets.get(`${region.id}:after`) ?? [],
  ]) : unmatched;
  ordered.forEach((region, index) => { region.order = index; });
  const tables = regions.filter(region => region.kind === "table").map(region => buildTableStructure(region, ocr.regions));
  if (tables.some(table => table.status !== "parsed")) issues.push("table-cells-need-review");
  return { version: "document-structure-1", model: detection.model, status: issues.length ? "partial" : "complete",
    regions, readingOrder: ordered.map(region => region.id), tables, marks: [], issues: [...new Set(issues)] };
}

export function unavailableStructure(): PageStructure {
  return { version: "document-structure-1", model: "pp-doclayout-v3-onnx", status: "unavailable",
    regions: [], readingOrder: [], tables: [], marks: [], issues: ["layout-unavailable"] };
}
