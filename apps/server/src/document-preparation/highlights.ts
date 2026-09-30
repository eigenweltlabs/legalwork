import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { PageViewport } from "pdfjs-dist/types/src/display/page_viewport.js";
import type { OcrContent } from "../ocr/types.js";

/** Match literal wording, allowing only layout whitespace to differ. */
export function quoteRange(text: string, quote: string) {
  if (!quote.trim()) return null;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const words = quote.trim().split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const match = new RegExp(words.join("\\s+"), "u").exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/** OCR engines provide line/word boxes; use only boxes intersecting the quote. */
export function ocrQuoteRegions(regions: OcrContent["regions"], quote: string) {
  const match = quoteRange(regions.map(region => region.text).join(" "), quote);
  if (!match) return [];
  let offset = 0;
  return regions.flatMap(region => {
    const start = offset; offset += region.text.length + 1;
    return start < match.end && offset - 1 > match.start ? [region.box] : [];
  });
}

type MeasureText = (text: string, fontFamily: string, fontSize: number) => number;

/** Locate the cited span within PDF text runs, including partial lines and rotation.
 * Widths are measured using the run's font and scaled to PDF.js's actual run width.
 * Geometry follows PDF.js's text layer; no LLM-provided coordinates are trusted.
 */
export function pdfQuoteRegions(content: TextContent, viewport: PageViewport, quote: string, measure: MeasureText): OcrContent["regions"][number]["box"][] {
  const items = content.items.filter((item): item is TextItem => "str" in item);
  const text = items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("");
  const match = quoteRange(text, quote);
  if (!match) return [];
  let offset = 0;
  const [a, b, c, d, e, f] = viewport.transform;
  return items.flatMap(item => {
    const start = offset; offset += item.str.length + 1;
    let from = Math.max(0, match.start - start), to = Math.min(item.str.length, match.end - start);
    while (from < to && /\s/u.test(item.str[from])) from++;
    while (to > from && /\s/u.test(item.str[to - 1])) to--;
    if (from >= to) return [];
    const style = content.styles[item.fontName];
    if (!style) return [];
    const [i, j, k, l, m, n] = item.transform;
    const tx = [a * i + c * j, b * i + d * j, a * k + c * l, b * k + d * l, a * m + c * n + e, b * m + d * n + f];
    const angle = Math.atan2(tx[1], tx[0]) + (style.vertical ? Math.PI / 2 : 0);
    const height = Math.hypot(tx[2], tx[3]), width = (style.vertical ? item.height : item.width) * viewport.scale;
    if (!height || !width) return [];
    const fullWidth = measure(item.str, style.fontFamily, height);
    if (!fullWidth) return [];
    const before = measure(item.str.slice(0, from), style.fontFamily, height) / fullWidth;
    const through = measure(item.str.slice(0, to), style.fontFamily, height) / fullWidth;
    const low = item.dir === "rtl" ? 1 - through : before, high = item.dir === "rtl" ? 1 - before : through;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const ascent = height * (style.ascent ?? (style.descent ? 1 + style.descent : .8));
    const left = tx[4] + ascent * sin, top = tx[5] - ascent * cos;
    const points = [[low * width, 0], [high * width, 0], [low * width, height], [high * width, height]]
      .map(([x, y]) => ({ x: left + x * cos - y * sin, y: top + x * sin + y * cos }));
    const x = Math.max(0, Math.min(...points.map(point => point.x))), y = Math.max(0, Math.min(...points.map(point => point.y)));
    const right = Math.min(Math.ceil(viewport.width), Math.max(...points.map(point => point.x)));
    const bottom = Math.min(Math.ceil(viewport.height), Math.max(...points.map(point => point.y)));
    if (right <= x || bottom <= y) return [];
    return [{ x: x / Math.ceil(viewport.width), y: y / Math.ceil(viewport.height), width: (right - x) / Math.ceil(viewport.width), height: (bottom - y) / Math.ceil(viewport.height) }];
  });
}
