import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewResult, ReviewSourcePage } from "./schema.js";
import { preparedSchema, type PreparedDocument } from "../document-preparation/schema.js";
import { openDocument } from "../document-preparation/render.js";
import { ApiError } from "../errors.js";
import { sourceHash } from "./evidence.js";
import { within } from "./storage.js";
import { sourceQuote } from "./citations.js";
import { ocrQuoteRegions } from "../document-preparation/highlights.js";

/** Locate the saved quotation on the unchanged original page, including old results. */
export async function reviewSourcePage(workspace: string, file: string, result: Pick<ReviewResult, "sourceHash" | "preparationPath" | "citations">, citationIndex: number, signal: AbortSignal, requestedPage?: number): Promise<ReviewSourcePage> {
  const citation = result.citations[citationIndex];
  if (!citation?.page || !/\.(pdf|png|jpe?g|webp)$/i.test(file)) throw new ApiError(400, "review_citation", "This citation has no page preview.");
  if (requestedPage !== undefined && (!Number.isInteger(requestedPage) || requestedPage < 1)) throw new ApiError(400, "review_citation", "Invalid source page.");
  const { source, bytes, hash } = await sourceHash(workspace, file);
  if (hash !== result.sourceHash) throw new ApiError(409, "review_source_changed", "The source has changed. Rerun the review before using its evidence.");
  let regions: ReviewSourcePage["regions"] = [];
  let prepared: PreparedDocument | undefined;
  let ocrVerified = false;
  if (result.preparationPath) {
    const root = await realpath(workspace), path = await realpath(resolve(root, result.preparationPath));
    if (!within(root, path) || (await stat(path)).size > 128 * 1024 * 1024) throw new ApiError(403, "review_path", "Invalid document evidence.");
    prepared = preparedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (prepared.sourceSha256 !== hash || await realpath(prepared.fileAbs) !== source.absolute) throw new ApiError(409, "review_source_changed", "The evidence no longer matches this document.");
    const page = prepared.pages.find(page => page.page === citation.page);
    if (citation.source !== "native" && citation.regionIds?.length) {
      const selected = citation.regionIds.map(id => page?.ocr?.regions[id]);
      if (selected.some(region => !region) || !sourceQuote(selected.map(region => region?.text).join(" "), citation.quote)) throw new ApiError(409, "review_citation", "The citation no longer matches its OCR regions.");
      regions = ocrQuoteRegions(selected.flatMap(region => region ? [region] : []), citation.quote);
      ocrVerified = true;
    } else if (citation.source !== "native" && page?.ocr && sourceQuote(page.ocr.text, citation.quote)) {
      regions = ocrQuoteRegions(page.ocr.regions, citation.quote);
      ocrVerified = true;
    } else if (citation.source === "ocr") throw new ApiError(409, "review_citation", "The citation no longer matches its OCR text.");
  }
  const document = await openDocument(bytes, /\.pdf$/i.test(file) ? "pdf" : "image");
  try {
    const pageNumber = requestedPage ?? citation.page;
    if (citation.page > document.pageCount || pageNumber > document.pageCount) throw new ApiError(400, "review_citation", "The citation page does not exist.");
    const anchor = await document.page(citation.page, signal, citation.quote);
    const { nativeText, highlights } = anchor;
    if (citation.source === "native" && !sourceQuote(nativeText, citation.quote)) throw new ApiError(409, "review_citation", "The citation no longer matches its source page.");
    if (pageNumber !== citation.page && !ocrVerified && !sourceQuote(nativeText, citation.quote)) throw new ApiError(409, "review_citation", "The citation no longer matches its source page.");
    // Prefer exact PDF spans when the OCR quote matches native text too.
    // Otherwise retain only the matched OCR lines/words, never a guessed location.
    if (pageNumber === citation.page && highlights?.length) regions = highlights;
    const image = pageNumber === citation.page ? anchor.image : (await document.page(pageNumber, signal)).image;
    const structure = prepared?.pages.find(page => page.page === pageNumber)?.structure;
    const relatedPassages = prepared?.relations?.flatMap(relation => {
      const direction: "outgoing" | "incoming" | undefined = relation.source.page === pageNumber ? "outgoing" : relation.target.page === pageNumber ? "incoming" : undefined;
      if (!direction) return [];
      const peer = direction === "outgoing" ? relation.target : relation.source;
      if (peer.page > document.pageCount) return [];
      const region = prepared?.pages.find(page => page.page === peer.page)?.structure?.regions.find(item => item.id === peer.regionId);
      const onPage = structure?.regions.some(item => item.id === (direction === "outgoing" ? relation.source.regionId : relation.target.regionId));
      return region && onPage ? [{ relation, direction, page: peer.page, region }] : [];
    });
    return { name: source.name, path: source.path, page: pageNumber, pageCount: document.pageCount, quote: pageNumber === citation.page ? citation.quote : "",
      image: `data:image/png;base64,${Buffer.from(image.data).toString("base64")}`, width: image.width, height: image.height,
      regions: pageNumber === citation.page ? regions : [], structure, relatedPassages };
  } finally { await document.close(); }
}
