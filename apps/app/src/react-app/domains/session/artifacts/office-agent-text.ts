/** Keep each untouched text run's formatting when a replacement crosses runs. */
export function replaceTextSegments<T extends { text: string }>(segments: T[], text: string, search: string, replacement: string): T[] {
  if (segments.map((segment) => segment.text).join("") !== text) throw new Error("This text has complex paragraph structure. Edit it in the presentation editor.");
  const start = text.indexOf(search), end = start + search.length;
  if (start < 0 || !search || text.indexOf(search, start + 1) >= 0) throw new Error("Search must match exactly once.");
  let offset = 0, inserted = false;
  return segments.map((segment) => {
    const from = offset, to = offset + segment.text.length;
    offset = to;
    if (to <= start || from >= end) return segment;
    const prefix = segment.text.slice(0, Math.max(0, start - from));
    const suffix = segment.text.slice(Math.max(0, end - from));
    const middle = inserted ? "" : replacement;
    inserted = true;
    return { ...segment, text: prefix + middle + suffix };
  });
}
