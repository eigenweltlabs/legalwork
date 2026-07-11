// pdf-text.mjs — per-page text extraction for pdf-agent's `text` command.
//
// pdf-lib (the vendored engine behind annotate/fill/sign) cannot read page
// text, so this loads the pdf.js build vendored with the tabular-review skill.
// Both skills ship in the same bundled-core seed (see core-skills.ts /
// gen-core-skills.mjs) and are refreshed together, so the relative vendor path
// below always exists in a seeded workspace.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PDFJS_VENDOR_DIR = join(HERE, "..", "..", "tabular-review", "assets", "vendor");

export class PdfTextError extends Error {}

let pdfjsPromise = null;

function loadPdfjs() {
  // The vendored files are browser-style UMD bundles: requiring them registers
  // pdfjsLib / pdfjsWorker on globalThis rather than returning useful exports.
  // Registering the worker module up front makes pdf.js use it in-process (its
  // "fake worker" path) instead of trying to spawn a real Worker.
  pdfjsPromise ??= (async () => {
    const libPath = join(PDFJS_VENDOR_DIR, "pdf.min.js");
    const workerPath = join(PDFJS_VENDOR_DIR, "pdf.worker.min.js");
    if (!existsSync(libPath) || !existsSync(workerPath)) {
      throw new PdfTextError(
        `the vendored pdf.js build is missing (expected ${libPath}). ` +
          "It ships with the tabular-review skill in the same core bundle — reload the workspace to re-seed it.",
      );
    }
    const require = createRequire(import.meta.url);
    require(libPath);
    require(workerPath);
    const pdfjs = globalThis.pdfjsLib;
    globalThis.pdfjsWorker ??= globalThis["pdfjs-dist/build/pdf.worker"];
    if (!pdfjs || typeof pdfjs.getDocument !== "function") {
      throw new PdfTextError(`failed to initialize the vendored pdf.js build at ${libPath}`);
    }
    return pdfjs;
  })();
  return pdfjsPromise;
}

/** Parse a 1-based page selection like "3", "1-4", or "1,3,7-9". */
export function parsePageSelection(value, pageCount) {
  if (value === undefined) return null;
  const pages = new Set();
  for (const part of String(value).split(",")) {
    const range = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!range) throw new PdfTextError(`invalid --pages value "${value}" — use forms like "3", "1-4", or "1,3,7-9"`);
    const start = Number(range[1]);
    const end = range[2] === undefined ? start : Number(range[2]);
    if (start < 1 || end < start) throw new PdfTextError(`invalid --pages range "${part.trim()}"`);
    for (let page = start; page <= Math.min(end, pageCount); page += 1) pages.add(page);
  }
  return pages;
}

/**
 * Extract text per page. Returns { pageCount, pages: [{ page, text }] } where
 * `pages` covers the requested selection (default: every page).
 */
export async function extractPdfText(bytes, options = {}) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    throw new PdfTextError(`could not open PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const selection = parsePageSelection(options.pages, doc.numPages);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      if (selection && !selection.has(pageNumber)) continue;
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === "string" ? item.str : "") + (item.hasEOL ? "\n" : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      pages.push({ page: pageNumber, text });
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
