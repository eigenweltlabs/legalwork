import { matchesSearch, searchExcerpt, searchTerms, type SearchSourceReference } from "../search-schema.js";
import type { CorpusText } from "./extract.js";
import { splitReviewEvidence, type EvidencePage } from "../reviews/chunks.js";

function reference(path: string, hash: string, page: EvidencePage, query: string): SearchSourceReference {
  const quote = searchExcerpt(page.text, query).replace(/^…|…$/g, "");
  const terms = searchTerms(query);
  const regions = page.regions?.filter(region => terms.some(term => region.text.normalize("NFC").toLowerCase().includes(term))).flatMap(region => region.box ? [region.box] : []);
  return { path, hash, page: page.page, source: page.source ?? "native", quote, ...(regions?.length ? { regions } : {}) };
}

/** Search overlapping passages without losing contributing pages or OCR regions.
 * Keep surrounding text on both sides of a page/chunk boundary. */
export function documentMatches(source: CorpusText, path: string, query: string) {
  if (!source.text.trim() || !matchesSearch(source.text, query)) return { sources: [], sourcesLimited: false };
  const allChunks = splitReviewEvidence(source.pages, 4000, 1000);
  const chunks = allChunks.filter(chunk => matchesSearch(chunk.pages.map(page => page.text).join("\n"), query));
  const terms = searchTerms(query);
  // Widely separated terms still identify a document, without pretending that
  // they form one clause. Include each contributing passage explicitly.
  const pages = chunks.length ? chunks.flatMap(chunk => chunk.pages) : allChunks.flatMap(chunk => chunk.pages).filter(page => terms.some(term => page.text.normalize("NFC").toLowerCase().includes(term)));
  const unique = new Map<string, SearchSourceReference>();
  for (const page of pages) {
    if (!page.text.trim()) continue;
    const ref = { ...reference(path, source.hash, page, query), preparationPath: source.preparationPath };
    unique.set(JSON.stringify([ref.page, ref.source, ref.quote]), ref);
  }
  return { sources: [...unique.values()].slice(0, 12), sourcesLimited: unique.size > 12 };
}
