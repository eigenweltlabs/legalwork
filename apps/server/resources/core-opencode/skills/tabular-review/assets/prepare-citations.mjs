import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const normalized = value => String(value || "").replace(/\s+/g, " ").trim();
const needsReview = (cell, reason) => { cell.value = "Needs review"; cell.confidence = "low"; cell.reason = reason; cell.citations = []; cell.quote = ""; cell.page = null; delete cell.decision; delete cell.evidence; };

/** Resolve references against preparation evidence; never trust model-generated rectangles. */
export function prepareCitations(data, workspace = process.cwd()) {
  for (const row of data.rows || []) {
    const supported = /\.(pdf|png|jpe?g|webp)$/i.test(row.file || "");
    if (!row.preparationPath) {
      if (data.preparationRequired && supported) {
        if (!row.preparationError) throw new Error(`Missing document preparation for ${row.file}`);
        row.preparation = { status: "error", error: String(row.preparationError) };
        for (const cell of Object.values(row.cells || {})) needsReview(cell, row.preparation.error);
      }
      continue;
    }
    const prepared = JSON.parse(readFileSync(resolve(workspace, row.preparationPath), "utf8"));
    if (prepared.version !== "review-preparation-1" || !Array.isArray(prepared.pages)) throw new Error("Unsupported document preparation.");
    const source = realpathSync(resolve(workspace, row.file));
    if (source !== realpathSync(prepared.fileAbs) || createHash("sha256").update(readFileSync(source)).digest("hex") !== prepared.sourceSha256)
      throw new Error(`Source changed since preparation: ${row.file}. Prepare the document again.`);
    row.fileAbs = source;
    row.preparation = { status: prepared.status, engine: prepared.engine.label, pageCount: prepared.pageCount, pagesNeedingReview: prepared.pages.filter(page => page.status !== "complete").map(page => page.page), error: prepared.error };
    const incomplete = prepared.status !== "complete" || prepared.pages.length !== prepared.pageCount;
    for (const cell of Object.values(row.cells || {})) {
      if (row.review?.backend === "systemone" && cell.evidence === "uncited" && cell.decision) {
        if (incomplete) needsReview(cell, "Document extraction is incomplete or uncertain. Prepare the document again before running SystemOne decisions.");
        else { cell.citations = []; cell.quote = ""; cell.page = null; cell.confidence = null; }
        continue;
      }
      const absent = /^(not found|n\/a|na|unreadable|needs review)?$/i.test(String(cell.value || "").trim());
      if (absent) {
        if (incomplete || /unreadable|needs review/i.test(cell.value)) needsReview(cell, prepared.error || "Document extraction is incomplete or uncertain. Review the indicated source pages before concluding that this term is absent.");
        continue;
      }
      const citations = cell.citations?.length ? cell.citations : cell.quote && cell.page ? [{ page: cell.page, quote: cell.quote }] : [];
      let invalid = citations.length === 0;
      const resolved = citations.map(citation => {
        const page = prepared.pages.find(page => page.page === citation.page);
        const quote = normalized(citation.quote);
        if (!page || !quote) { invalid = true; return null; }
        const source = citation.source || (normalized(page.nativeText).includes(quote) ? "native" : "ocr");
        const text = source === "native" ? page.nativeText : source === "ocr" ? page.ocr?.text : "";
        if (!normalized(text).includes(quote)) { invalid = true; return null; }
        const regionIds = source === "ocr" && Array.isArray(citation.regionIds) ? citation.regionIds : [];
        const regions = regionIds.map(id => Number.isInteger(id) && id >= 0 ? page.ocr?.regions[id] : null);
        if (regions.some(region => !region) || (regions.length && !normalized(regions.map(region => region.text).join(" ")).includes(quote))) {
          invalid = true; return null;
        }
        return { page: page.page, quote: citation.quote, source, regions: regions.map(region => region.box) };
      }).filter(Boolean);
      if (invalid) { needsReview(cell, "A cited passage could not be verified against the prepared document. Recheck the source and rerun this field."); continue; }
      cell.citations = resolved;
      cell.page = resolved[0].page; cell.quote = resolved[0].quote;
      if (resolved.some(citation => prepared.pages.find(page => page.page === citation.page)?.status !== "complete")) cell.confidence = "low";
    }
  }
  return data;
}
