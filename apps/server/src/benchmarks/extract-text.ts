/**
 * Server-side text extraction for judge prompts.
 *
 * Reading deliverables through the judge session's file tools costs several
 * LLM round-trips per criterion (and times out on slow models). Extracting the
 * text once and embedding it in the judge prompt turns every criterion into a
 * single fast completion. Formats we can't extract return null — the judge
 * falls back to reading the file with its own tools.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { unzipSync, type Unzipped } from "fflate";

/** Character cap per deliverable — keeps prompts inside sane context budgets. */
export const MAX_EXTRACTED_CHARS = 80_000;

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function stripTags(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, ""));
}

function truncate(text: string): string {
  const cleaned = text.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length <= MAX_EXTRACTED_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_EXTRACTED_CHARS)}\n\n[… truncated]`;
}

function unzip(buffer: Buffer): Unzipped | null {
  try {
    return unzipSync(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

function entryText(zip: Unzipped, path: string): string | null {
  const entry = zip[path];
  if (!entry) return null;
  return new TextDecoder("utf-8").decode(entry);
}

/** word/document.xml → paragraphs. Tabs and breaks become whitespace. */
function extractDocx(buffer: Buffer): string | null {
  const zip = unzip(buffer);
  if (!zip) return null;
  const xml = entryText(zip, "word/document.xml");
  if (!xml) return null;
  const withBreaks = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return truncate(stripTags(withBreaks));
}

/** pptx slides in order. */
function extractPptx(buffer: Buffer): string | null {
  const zip = unzip(buffer);
  if (!zip) return null;
  const slides = Object.keys(zip)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
  if (!slides.length) return null;
  const parts = slides.map((path, index) => {
    const xml = entryText(zip, path) ?? "";
    const withBreaks = xml.replace(/<\/a:p>/g, "\n");
    return `--- Slide ${index + 1} ---\n${stripTags(withBreaks)}`;
  });
  return truncate(parts.join("\n\n"));
}

/**
 * xlsx: emit rows per sheet as tab-separated values, resolving shared strings.
 * Good enough for judging content; formatting and formulas are dropped.
 */
function extractXlsx(buffer: Buffer): string | null {
  const zip = unzip(buffer);
  if (!zip) return null;
  const sharedXml = entryText(zip, "xl/sharedStrings.xml") ?? "";
  const shared = Array.from(sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)).map((match) => stripTags(match[1]!));
  const sheets = Object.keys(zip)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort();
  if (!sheets.length) return null;
  const parts = sheets.map((path) => {
    const xml = entryText(zip, path) ?? "";
    const rows = Array.from(xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)).map((row) => {
      const cells = Array.from(row[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)).map((cell) => {
        const attributes = cell[1] ?? "";
        const value = cell[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
        if (/t="s"/.test(attributes)) return shared[Number(value)] ?? "";
        const inline = cell[2]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
        return stripTags(inline ?? value);
      });
      return cells.join("\t");
    });
    return `--- ${path.replace("xl/worksheets/", "")} ---\n${rows.join("\n")}`;
  });
  return truncate(parts.join("\n\n"));
}

const PLAIN_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".eml",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
]);

/**
 * Best-effort plain-text extraction for a deliverable/input file.
 * Returns null when the format is unsupported (e.g. pdf) or parsing fails.
 */
export async function extractDeliverableText(path: string): Promise<string | null> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return null;
  }
  const extension = extname(path).toLowerCase();
  try {
    if (extension === ".docx") return extractDocx(buffer);
    if (extension === ".pptx") return extractPptx(buffer);
    if (extension === ".xlsx") return extractXlsx(buffer);
    if (PLAIN_TEXT_EXTENSIONS.has(extension)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return truncate(text);
    }
  } catch {
    return null;
  }
  return null;
}
