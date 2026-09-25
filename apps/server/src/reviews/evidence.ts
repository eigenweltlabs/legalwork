import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { unzipSync } from "fflate";
import { ApiError } from "../errors.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import { preparedSchema } from "../document-preparation/schema.js";
import type { EvidencePage } from "./chunks.js";
import { within } from "./storage.js";

export const REVIEW_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".docx", ".txt", ".md", ".markdown"]);
export async function reviewSource(workspace: string, input: string) {
  const root = await realpath(workspace), path = await realpath(resolve(root, input));
  if (!within(root, path) || !REVIEW_EXTENSIONS.has(extname(path).toLowerCase()))
    throw new ApiError(400, "review_source", "Choose a PDF, Word document, image or text file inside this project.");
  const info = await stat(path);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new ApiError(413, "review_source_size", "Review documents must be files of at most 64 MiB.");
  return { absolute: path, path: relative(root, path).split("\\").join("/"), name: basename(path), size: info.size };
}
export async function sourceHash(workspace: string, path: string) {
  const source = await reviewSource(workspace, path);
  const bytes = await readFile(source.absolute);
  if (bytes.length > 64 * 1024 * 1024) throw new ApiError(413, "review_source_size", "The source is too large.");
  return { source, bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}
function decodeXml(text: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity];
    const number = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number <= 0x10ffff ? String.fromCodePoint(number) : "�";
  });
}
export function docxEvidence(bytes: Uint8Array): EvidencePage[] {
  const zip = unzipSync(bytes, { filter: entry => {
    if (!/^word\/(document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(entry.name)) return false;
    if (entry.originalSize > 16 * 1024 * 1024) throw new ApiError(413, "review_source_size", "Word content exceeds the extraction limit.");
    return true;
  } });
  if (!zip["word/document.xml"]) throw new Error("The Word document has no readable document body.");
  return Object.entries(zip).sort(([a], [b]) => a === "word/document.xml" ? -1 : b === "word/document.xml" ? 1 : a.localeCompare(b)).map(([name, data]) => {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const text = decodeXml(xml.replace(/<w:tab[^>]*\/>/g, "\t").replace(/<w:(?:br|cr)[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n\n").replace(/<[^>]+>/g, ""));
    // Embedded drawings and unresolved tracked changes need visual human review.
    return { page: null, text: `[${name}]\n${text}`, source: "native", status: /<w:(?:drawing|pict|del|ins)\b/.test(xml) ? "needs-review" : "complete" };
  });
}
export type ReviewEvidence = { hash: string; pages: EvidencePage[]; preparationPath?: string; complete: boolean };
export async function prepareReviewEvidence(options: {
  workspace: string; path: string; preparation: DocumentPreparation; signal: AbortSignal; force: boolean;
  preparationJobId?: string;
  onProgress: (value: { completedPages: number; pageCount: number }) => Promise<void>;
}): Promise<ReviewEvidence> {
  const { source, bytes, hash } = await sourceHash(options.workspace, options.path);
  if (!/\.(pdf|png|jpe?g|webp)$/i.test(source.path)) {
    const pages: EvidencePage[] = source.path.toLowerCase().endsWith(".docx") ? docxEvidence(bytes)
      : [{ page: null, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), source: "native", status: "complete" }];
    if (!pages.some(page => page.text.trim())) throw new Error("The document contains no readable text.");
    return { hash, pages, complete: pages.every(page => page.status === "complete") };
  }
  const job = options.preparationJobId ? await options.preparation.status(options.workspace, options.preparationJobId)
    : await options.preparation.start(options.workspace, { files: [source.path], force: options.force });
  const cancel = () => { void options.preparation.cancel(options.workspace, job.id).catch(() => undefined); };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    let status = job;
    const document = () => { const entry = status.documents.find(entry => entry.file === source.path); if (!entry) throw new Error("The source is not part of this preparation run."); return entry; };
    while (["queued", "running"].includes(document().status) && ["queued", "running"].includes(status.status)) {
      options.signal.throwIfAborted();
      await options.onProgress(document());
      await new Promise<void>(resolve => setTimeout(resolve, 750));
      status = await options.preparation.status(options.workspace, job.id);
    }
    options.signal.throwIfAborted();
    const entry = document();
    await options.onProgress(entry);
    if (!entry.preparationPath) throw new Error(entry.error || "Document preparation failed.");
    const root = await realpath(options.workspace), path = await realpath(resolve(root, entry.preparationPath));
    if (!within(root, path) || (await stat(path)).size > 128 * 1024 * 1024) throw new Error("Invalid prepared document.");
    const prepared = preparedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (prepared.sourceSha256 !== hash || (await sourceHash(root, source.path)).hash !== hash) throw new Error("The source changed during preparation. Run the review again.");
    const complete = prepared.status === "complete" && prepared.pageCount > 0 && prepared.pages.length === prepared.pageCount && prepared.pages.every(page => page.status === "complete");
    const pages: EvidencePage[] = prepared.pages.flatMap(page => [
      { page: page.page, text: page.nativeText, source: "native", status: page.status },
      { page: page.page, text: page.ocr?.text ?? "", source: "ocr", status: page.status, regions: page.ocr?.regions.map(region => ({ text: region.text })) },
    ]);
    if (!complete) pages.push({ page: null, text: "", status: "needs-review" });
    if (!pages.some(page => page.text.trim())) throw new Error(entry.error || "No readable evidence. Check OCR settings and retry.");
    return { hash, pages, preparationPath: entry.preparationPath, complete };
  } finally { options.signal.removeEventListener("abort", cancel); }
}
