import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { unzipSync } from "fflate";
import { within } from "../reviews/storage.js";
import { docxEvidence, prepareReviewEvidence } from "../reviews/evidence.js";
import { inspectPdfText } from "../document-preparation/render.js";
import type { EvidencePage } from "../reviews/chunks.js";
import type { DocumentPreparation } from "../document-preparation/service.js";

const TEXT = new Set(["", ".rtf", ".js", ".ts", ".tsx", ".jsx", ".py", ".css", ".sql", ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".html", ".htm", ".log"]);
export const CORPUS_EXTENSIONS = new Set([...TEXT, ".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".png", ".jpg", ".jpeg", ".webp"]);
const MAX_TEXT = 2_000_000;
function xmlText(value: string) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(?:\w+:)?(?:p|row|tr|table-row|h[1-6])>/g, "\n").replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => { const n = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code); return n <= 0x10ffff ? String.fromCodePoint(n) : "�"; })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
}
export function officeText(bytes: Uint8Array, extension: string) {
  let total = 0;
  const files = unzipSync(bytes, { filter: entry => {
    const wanted = extension === ".xlsx" ? /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/.test(entry.name)
      : extension === ".pptx" ? /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(entry.name) : entry.name === "content.xml";
    if (!wanted) return false;
    total += entry.originalSize;
    if (total > 16 * 1024 * 1024) throw new Error("Office content exceeds the 16 MiB extraction limit.");
    return true;
  } });
  const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const strings = files["xl/sharedStrings.xml"] ? [...decode(files["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => xmlText(match[1])) : [];
  return Object.entries(files).filter(([name]) => name !== "xl/sharedStrings.xml").sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, bytes]) => {
    const xml = decode(bytes);
    if (extension !== ".xlsx") return `[${name}]\n${xmlText(xml)}`;
    return `[${name}]\n` + [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
      const value = cell[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      if (/\bt="s"/.test(cell[1])) return strings[Number(value)] ?? "";
      return value === undefined ? xmlText(cell[2]) : xmlText(value);
    }).join("\t")).join("\n");
  }).join("\n\n");
}
export type CorpusText = { text: string; pages: EvidencePage[]; complete: boolean; extraction: "native" | "ocr"; hash: string; preparationPath?: string; issue?: string };
export async function extractCorpusText(workspace: string, path: string, preparation: DocumentPreparation, signal: AbortSignal, options: { retry?: boolean } = {}): Promise<CorpusText> {
  signal.throwIfAborted();
  const root = await realpath(workspace), absolute = await realpath(resolve(root, path));
  if (!within(root, absolute)) throw new Error("The file is outside this project.");
  const size = await stat(absolute);
  if (!size.isFile() || size.size > 64 * 1024 * 1024) throw new Error("Files must be at most 64 MiB.");
  const bytes = await readFile(absolute), extension = extname(absolute).toLowerCase();
  if (bytes.length > 64 * 1024 * 1024) throw new Error("The file exceeds 64 MiB.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let text = "", complete = true;
  let pages: EvidencePage[] = [];
  let issue: string | undefined;
  let preparationPath: string | undefined;
  let needsOcr = [".png", ".jpg", ".jpeg", ".webp"].includes(extension);
  let extraction: "native" | "ocr" = "native";
  if (extension === ".pdf") {
    const inspected = await inspectPdfText(bytes, signal);
    pages = inspected.map((page, index) => ({ page: index + 1, text: page.text, source: "native", status: page.needsOcr ? "needs-review" : "complete" }));
    needsOcr = inspected.some(page => page.needsOcr);
  } else if (extension === ".docx") {
    pages = docxEvidence(bytes);
  } else if ([".xlsx", ".pptx", ".odt", ".ods", ".odp"].includes(extension)) text = officeText(bytes, extension);
  else if (TEXT.has(extension)) {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("The file is binary, not readable text.");
    if ([".html", ".htm", ".xml"].includes(extension)) text = xmlText(text);
  }
  if (needsOcr) {
    try {
      const evidence = await prepareReviewEvidence({ workspace, path, preparation, signal, force: options.retry ?? false, onProgress: async () => {} });
      pages = evidence.pages; preparationPath = evidence.preparationPath; complete = evidence.complete; extraction = "ocr";
    } catch (error) {
      signal.throwIfAborted();
      // Keep searchable native passages, but never present partial coverage as a
      // reliable negative. UI and agents receive the same incomplete document.
      complete = false;
      issue = error instanceof Error ? error.message : "Document preparation failed.";
    }
  }
  if (!pages.length && text) pages = [{ page: null, text, source: "native", status: "complete" }];
  complete = complete && pages.length > 0 && pages.every(page => page.status === "complete");
  text = pages.map(page => page.text).join("\n\n");
  if (!text.trim()) { complete = false; issue ??= "No readable text could be extracted. Check OCR settings and retry."; }
  if (!complete) issue ??= "Some document regions are unreadable or unprocessed. Matches may be incomplete.";
  if (text.length > MAX_TEXT) throw new Error("Extracted text exceeds 2 million characters; narrow the source. Nothing was silently truncated.");
  signal.throwIfAborted();
  if (createHash("sha256").update(await readFile(absolute)).digest("hex") !== hash) throw new Error("The source changed during extraction. Retry this file.");
  return { text, pages, complete, extraction, hash, preparationPath, issue };
}
