import type { DocumentRelation } from "@legalwork/types/document-structure";

export type EvidenceBlock = { id: string; kind: string; start: number; end: number; ocrRegionIds?: number[] };
export type EvidenceTable = { regionId: string; rows: number; columns: number; status: string;
  cells: Array<{ row: number; column: number; rowSpan: number; columnSpan: number; start: number; end: number }> };
export type EvidenceLink = Pick<DocumentRelation, "kind" | "status" | "basis" | "source" | "target">;
export type EvidencePage = {
  page: number | null; text: string; source?: "native" | "ocr";
  status?: "complete" | "needs-review" | "error"; regions?: Array<{ text: string; box?: { x: number; y: number; width: number; height: number } }>;
  blocks?: EvidenceBlock[]; tables?: EvidenceTable[]; links?: EvidenceLink[];
};
export type EvidenceChunk = { index: number; pages: EvidencePage[]; start: number; end: number };
type Span = { page: EvidencePage; start: number; end: number };
type Interval = { start: number; end: number };

/** OCR region text stays available for citation checks, but is never sent as duplicate inference context. */
export function inferencePages(pages: EvidencePage[]): Omit<EvidencePage, "regions">[] {
  // SystemOne validates structured content before JSON serialization. Omit absent
  // metadata here so optional fields never become invalid undefined JSON values.
  return pages.map(({ page, text, source, status, blocks, tables, links }) => ({
    page, text,
    ...(source !== undefined ? { source } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(blocks !== undefined ? { blocks: blocks.map(({ ocrRegionIds, ...block }) => ({
      ...block, ...(ocrRegionIds !== undefined ? { ocrRegionIds } : {}),
    })) } : {}),
    ...(tables !== undefined ? { tables } : {}),
    ...(links !== undefined ? { links } : {}),
  }));
}
export function serializedEvidenceLength(pages: EvidencePage[]): number {
  return JSON.stringify(inferencePages(pages)).length;
}
function spansFor(pages: EvidencePage[]): Span[] {
  let offset = 0;
  return pages.map((page, index) => {
    if (index) offset += 2;
    const span = { page, start: offset, end: offset + page.text.length };
    offset = span.end;
    return span;
  });
}
function slicePage(page: EvidencePage, start: number, end: number): EvidencePage {
  const blocks = page.blocks?.filter(block => block.start < end && block.end > start)
    .map(block => ({ ...block, start: Math.max(0, block.start - start), end: Math.min(end - start, block.end - start) }));
  const tables = page.tables?.map(table => ({ ...table,
    cells: table.cells.filter(cell => cell.start < end && cell.end > start)
      .map(cell => ({ ...cell, start: Math.max(0, cell.start - start), end: Math.min(end - start, cell.end - start) })) }))
    .filter(table => table.cells.length || blocks?.some(block => block.id === table.regionId));
  return { ...page, text: page.text.slice(start, end), blocks, tables, links: undefined };
}
function materialize(spans: Span[], intervals: Interval[]): EvidencePage[] {
  return spans.flatMap(span => intervals.flatMap(interval => interval.start < span.end && interval.end > span.start
    ? [slicePage(span.page, Math.max(0, interval.start - span.start), Math.min(span.page.text.length, interval.end - span.start))] : []));
}
function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}
function overlaps(intervals: Interval[], span: Interval): boolean {
  return intervals.some(interval => interval.start < span.end && interval.end > span.start);
}

/** The JEV demo's paragraph/sentence boundary strategy, retaining exact source offsets. */
export function splitReviewEvidence(pages: EvidencePage[], maxChars = 104_000, overlapChars = 2000, strictSerialized = false): EvidenceChunk[] {
  if (maxChars < 100 || overlapChars < 0 || overlapChars >= maxChars) throw new Error("Invalid review context budget.");
  const spans = spansFor(pages);
  const text = pages.map(page => page.text).join("\n\n");
  const chunks: EvidenceChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const searchStart = Math.max(start + Math.floor(maxChars / 2), hardEnd - 8000);
      const boundaries = [...text.slice(searchStart, hardEnd).matchAll(/\n\s*\n|(?<=[.!?])\s+(?=[A-Z0-9§])/g)];
      const last = boundaries.at(-1);
      if (last) end = searchStart + last.index + last[0].length;
    }
    if (strictSerialized) {
      let low = start + 1, high = end, fit = start;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (serializedEvidenceLength(materialize(spans, [{ start, end: middle }])) <= maxChars) { fit = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (fit === start) return [];
      end = fit;
    }
    chunks.push({ index: chunks.length, start, end, pages: materialize(spans, [{ start, end }]) });
    if (end >= text.length) break;
    const next = Math.max(0, end - overlapChars);
    start = next > start ? next : end;
  }
  return chunks;
}

/** Merge source intervals, then include one hop of linked regions in either direction. */
export function combineReviewChunks(chunks: EvidenceChunk[], allPages: EvidencePage[], maxChars: number,
  relations?: DocumentRelation[]): EvidencePage[] | null {
  const spans = spansFor(allPages);
  const selected = mergeIntervals(chunks.map(chunk => ({ start: chunk.start, end: chunk.end })));
  const added: Interval[] = [];
  if (relations) {
    if (relations.length > 2000) return null;
    const key = (endpoint: DocumentRelation["source"]) => `${endpoint.page}:${endpoint.regionId}`;
    const locations = new Map<string, Map<EvidencePage["source"], Interval[]>>();
    for (const span of spans) for (const block of span.page.blocks ?? []) {
      if (span.page.page === null) continue;
      const id = `${span.page.page}:${block.id}`;
      const variants = locations.get(id) ?? new Map<EvidencePage["source"], Interval[]>();
      variants.set(span.page.source, [...variants.get(span.page.source) ?? [],
        { start: span.start + block.start, end: span.start + block.end }]);
      locations.set(id, variants);
    }
    const adjacent = new Map<string, Set<string>>();
    for (const link of relations) {
      const a = key(link.source), b = key(link.target);
      adjacent.set(a, (adjacent.get(a) ?? new Set()).add(b));
      adjacent.set(b, (adjacent.get(b) ?? new Set()).add(a));
    }
    const queue: Array<{ id: string; source: EvidencePage["source"] }> = [];
    const seen = new Set<string>();
    const include = (id: string, preferred: EvidencePage["source"]): boolean => {
      const variants = locations.get(id);
      if (!variants?.size) return false;
      const source = variants.has(preferred) ? preferred : variants.keys().next().value;
      const marker = `${id}:${source ?? "unknown"}`;
      if (seen.has(marker)) return true;
      if (seen.size >= 64) return false;
      const intervals = variants.get(source) ?? [];
      if (added.length + intervals.length > 512) return false;
      seen.add(marker);
      added.push(...intervals);
      queue.push({ id, source });
      return true;
    };
    for (const [id, variants] of locations) {
      if (!adjacent.has(id)) continue;
      for (const [source, intervals] of variants) {
        if (intervals.some(interval => overlaps(selected, interval)) && !include(id, source)) return null;
      }
    }
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      for (const neighbor of adjacent.get(current.id) ?? []) if (!include(neighbor, current.source)) return null;
    }
  }
  const intervals = mergeIntervals([...selected, ...added]);
  if (intervals.reduce((size, interval) => size + interval.end - interval.start, 0) > maxChars) return null;
  const pages = materialize(spans, intervals);
  if (relations?.length && pages.length) {
    const present = (endpoint: DocumentRelation["source"]): boolean => pages.some(page => page.page === endpoint.page
      && page.blocks?.some(block => block.id === endpoint.regionId));
    const links = relations.filter(link => present(link.source) && present(link.target))
      .map(({ kind, status, basis, source, target }) => ({ kind, status, basis, source, target }));
    if (links.length) pages[0].links = links;
  }
  if (relations && serializedEvidenceLength(pages) > maxChars) return null;
  return pages;
}
