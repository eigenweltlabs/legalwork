import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewResult, ReviewSourcePage } from "./schema.js";
import { preparedSchema } from "../document-preparation/schema.js";
import { openDocument } from "../document-preparation/render.js";
import { ApiError } from "../errors.js";
import { sourceHash } from "./evidence.js";
import { within } from "./storage.js";
import { sourceQuote } from "./citations.js";
import { ocrQuoteRegions } from "../document-preparation/highlights.js";

/** Locate the saved quotation on the unchanged original page, including old results. */
export async function reviewSourcePage(workspace: string, file: string, result: ReviewResult, citationIndex: number, signal: AbortSignal): Promise<ReviewSourcePage> {
  const citation = result.citations[citationIndex];
  if (!citation?.page || !/\.(pdf|png|jpe?g|webp)$/i.test(file)) throw new ApiError(400, "review_citation", "This citation has no page preview.");
  const { source, bytes, hash } = await sourceHash(workspace, file);
  if (hash !== result.sourceHash) throw new ApiError(409, "review_source_changed", "The source has changed. Rerun the review before using its evidence.");
  let regions: ReviewSourcePage["regions"] = [];
  if (citation.source !== "native" && result.preparationPath) {
    const root = await realpath(workspace), path = await realpath(resolve(root, result.preparationPath));
    if (!within(root, path) || (await stat(path)).size > 128 * 1024 * 1024) throw new ApiError(403, "review_path", "Invalid document evidence.");
    const prepared = preparedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (prepared.sourceSha256 !== hash || await realpath(prepared.fileAbs) !== source.absolute) throw new ApiError(409, "review_source_changed", "The evidence no longer matches this document.");
    const page = prepared.pages.find(page => page.page === citation.page);
    if (citation.regionIds?.length) {
      const selected = citation.regionIds.map(id => page?.ocr?.regions[id]);
      if (selected.some(region => !region) || !sourceQuote(selected.map(region => region?.text).join(" "), citation.quote)) throw new ApiError(409, "review_citation", "The citation no longer matches its OCR regions.");
      regions = ocrQuoteRegions(selected.flatMap(region => region ? [region] : []), citation.quote);
    } else if (page?.ocr && sourceQuote(page.ocr.text, citation.quote)) {
      regions = ocrQuoteRegions(page.ocr.regions, citation.quote);
    } else if (citation.source === "ocr") throw new ApiError(409, "review_citation", "The citation no longer matches its OCR text.");
  }
  const document = await openDocument(bytes, /\.pdf$/i.test(file) ? "pdf" : "image");
  try {
    if (citation.page > document.pageCount) throw new ApiError(400, "review_citation", "The citation page does not exist.");
    const { image, nativeText, highlights } = await document.page(citation.page, signal, citation.quote);
    if (citation.source === "native" && !sourceQuote(nativeText, citation.quote)) throw new ApiError(409, "review_citation", "The citation no longer matches its source page.");
    // Prefer exact PDF spans when the OCR quote matches native text too.
    // Otherwise retain only the matched OCR lines/words, never a guessed location.
    if (highlights?.length) regions = highlights;
    return { name: source.name, path: source.path, page: citation.page, pageCount: document.pageCount, quote: citation.quote,
      image: `data:image/png;base64,${Buffer.from(image.data).toString("base64")}`, width: image.width, height: image.height, regions };
  } finally { await document.close(); }
}
