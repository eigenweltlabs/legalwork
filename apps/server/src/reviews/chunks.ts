export type EvidencePage = {
  page: number | null; text: string; source?: "native" | "ocr";
  status?: "complete" | "needs-review" | "error"; regions?: Array<{ text: string }>;
};
export type EvidenceChunk = { index: number; pages: EvidencePage[]; start: number; end: number };

/** The JEV demo's paragraph/sentence boundary strategy, retaining exact source offsets. */
export function splitReviewEvidence(pages: EvidencePage[], maxChars = 104_000, overlapChars = 2000): EvidenceChunk[] {
  if (maxChars < 100 || overlapChars < 0 || overlapChars >= maxChars) throw new Error("Invalid review context budget.");
  const spans: Array<{ page: EvidencePage; start: number; end: number }> = [];
  let text = "";
  for (const [index, page] of pages.entries()) {
    if (index) text += "\n\n";
    spans.push({ page, start: text.length, end: text.length + page.text.length });
    text += page.text;
  }
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
    chunks.push({ index: chunks.length, start, end, pages: spans.filter(span => span.start < end && span.end > start).map(span => ({
      ...span.page, text: span.page.text.slice(Math.max(0, start - span.start), Math.min(span.page.text.length, end - span.start)),
    })) });
    if (end >= text.length) break;
    const next = Math.max(0, end - overlapChars);
    start = next > start ? next : end;
  }
  return chunks;
}

/** Merge overlaps without dropping intervening source identity or duplicating passages. */
export function combineReviewChunks(chunks: EvidenceChunk[], allPages: EvidencePage[], maxChars: number): EvidencePage[] | null {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const chunk of [...chunks].sort((a, b) => a.start - b.start)) {
    const previous = intervals.at(-1);
    if (previous && chunk.start <= previous.end) previous.end = Math.max(previous.end, chunk.end);
    else intervals.push({ start: chunk.start, end: chunk.end });
  }
  if (intervals.reduce((size, interval) => size + interval.end - interval.start, 0) > maxChars) return null;
  let offset = 0;
  return allPages.flatMap((page, index) => {
    if (index) offset += 2;
    const start = offset; offset += page.text.length;
    return intervals.flatMap(interval => interval.start < offset && interval.end > start
      ? [{ ...page, text: page.text.slice(Math.max(0, interval.start - start), Math.min(page.text.length, interval.end - start)) }] : []);
  });
}
