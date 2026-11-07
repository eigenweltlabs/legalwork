import type { Document } from "@eigenpal/docx-editor-core/types/document";
import type { FlowBlock, Layout, Measure } from "@eigenpal/docx-editor-core/layout-engine";
import { convertHeaderFooterPmDocToContent, convertHeaderFooterToContent, getMargins, getPageSize, headerFooterDrawingRects, headerFooterWrapRects, measureParagraph, measureTableBlock, resolveHeaderFooter } from "@eigenpal/docx-editor-core/layout-bridge";
import type { Node } from "prosemirror-model";

function measure(block: FlowBlock, width: number): Measure {
  if (block.kind === "paragraph") return measureParagraph(block, width);
  if (block.kind === "table") return measureTableBlock(block, width, measure);
  if (block.kind === "image") return { kind: "image", width: block.width, height: block.height };
  if (block.kind === "textBox") return { kind: "textBox", width: block.width, height: block.height ?? 0, innerMeasures: block.content.map(item => measureParagraph(item, block.width)) };
  return { kind: block.kind };
}

/** Use the painter's geometry, including transparent wrapping objects. */
export function wordPageGeometry(document: Document, layout: Layout | null, number: number, liveStories?: Map<string, Node>) {
  const rendered = layout?.pages.find(page => page.number === number);
  const section = document.package.document.sections?.[rendered?.sectionIndex ?? 0]?.properties ?? document.package.document.finalSectionProperties;
  const page = rendered ?? { number, size: getPageSize(section), margins: getMargins(section) };
  const width = page.size.w - page.margins.left - page.margins.right;
  const stories = resolveHeaderFooter(document, section);
  const header = section?.titlePg && number === 1 ? stories.firstHeader : stories.header;
  const footer = section?.titlePg && number === 1 ? stories.firstFooter : stories.footer;
  const content = (story: typeof header, area: "header" | "footer") => {
    const entries = area === "header" ? document.package.headers : document.package.footers;
    const rid = Array.from(entries ?? []).find(([, value]) => value === story)?.[0];
    const live = rid ? liveStories?.get(rid) : undefined;
    const options = { styles: document.package.styles, theme: document.package.theme, measureBlocks: (blocks: FlowBlock[], widths: number | number[]) => blocks.map((block, index) => measure(block, typeof widths === "number" ? widths : widths[index] ?? width)) };
    const metrics = { section: area, pageSize: page.size, margins: page.margins };
    return live ? convertHeaderFooterPmDocToContent(live, width, metrics, options) : convertHeaderFooterToContent(story, width, metrics, options);
  };
  const h = content(header, "header"), f = content(footer, "footer");
  const wrappingExclusions = headerFooterWrapRects(h, f, page);
  const drawings = [...headerFooterDrawingRects(h, page), ...headerFooterDrawingRects(f, page, "footer")];
  return { page, wrappingExclusions, drawings, hasPageBackgroundImage: drawings.some(rect => rect.behindDoc && rect.width >= page.size.w * .9 && rect.height >= page.size.h * .9) };
}
