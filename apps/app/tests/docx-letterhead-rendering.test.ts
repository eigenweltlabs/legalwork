import { expect, test } from "bun:test";
import JSZip from "jszip";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { parseDocx } from "@eigenpal/docx-editor-core/docx";
import { fromProseDoc, headerFooterToProseDoc, toProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { EditorState } from "prosemirror-state";
import { schema } from "@eigenpal/docx-editor-core/prosemirror";
import { computeLayout } from "@eigenpal/docx-editor-core/editor";
import { wordPageGeometry } from "../src/react-app/domains/session/artifacts/docx-page-geometry";
import { toFlowBlocks, getMargins, getPageSize, measureParagraph, resetCanvasContext, clearAllCaches, resolveHeaderFooter } from "@eigenpal/docx-editor-core/layout-bridge";
import type { Image } from "@eigenpal/docx-editor-core/types/document";
import { letterheadTemplate } from "../scripts/fixtures/letterhead-template";

test("page artwork keeps its authored size and independent paint properties through the live model", async () => {
  const document = await parseDocx(await letterheadTemplate());
  const header = document.package.headers?.values().next().value;
  if (!header) throw new Error("Missing synthetic header");
  const doc = headerFooterToProseDoc(header.content);
  const pictures = toFlowBlocks(doc, { pageContentHeight: 700 }).flatMap(block => block.kind === "paragraph" ? block.runs.filter(run => run.kind === "image") : []);
  expect(pictures).toHaveLength(2);
  expect(pictures[0].width).toBe(Math.round(7560310 / 9525));
  expect(pictures[0].height).toBe(Math.round(10685780 / 9525));
  expect(doc.firstChild?.firstChild?.attrs.drawingProps).toMatchObject({ behindDoc: true, relativeHeight: 1 });
  expect(doc.firstChild?.lastChild?.attrs).toMatchObject({ wrapType: "square", drawingProps: { behindDoc: true, relativeHeight: 2, colorChanges: [{ from: { rgb: [255, 255, 255], alpha: 255 }, to: { rgb: [255, 255, 255], alpha: 0 }, useAlpha: true }] } });
});

test("opening and saving retains colour-key transparency, square-wrap behind-text and stacking order", async () => {
  const input = await letterheadTemplate();
  const document = await parseDocx(input);
  const header = document.package.headers?.values().next().value;
  if (!header) throw new Error("Missing synthetic header");
  const liveHeader = headerFooterToProseDoc(header.content);
  header.content = fromProseDoc(liveHeader, document).package.document.content;
  const output = await new DocxReviewer(fromProseDoc(toProseDoc(document), document), "QA", input).toBuffer();
  const zip = await JSZip.loadAsync(output);
  const xml = await zip.file("word/header1.xml")!.async("string");
  expect(xml).toContain("<a:clrChange>"); expect(xml).toContain('<a:alpha val="0"/>');
  expect(xml).toMatch(/relativeHeight="1" behindDoc="1"/);
  expect(xml).toMatch(/relativeHeight="2" behindDoc="1"/);
  expect(xml).toContain('<wp:wrapSquare wrapText="bothSides"/>');
  const reopened = await parseDocx(output);
  const reopenedHeader = reopened.package.headers?.values().next().value;
  if (!reopenedHeader) throw new Error("Missing saved header");
  expect(headerFooterToProseDoc(reopenedHeader.content).firstChild?.lastChild?.attrs.drawingProps).toEqual(liveHeader.firstChild?.lastChild?.attrs.drawingProps);
});

test("colour-key rendering changes matched pixels only and follows Word's useAlpha rules", async () => {
  const effects: { applyImageColorChanges: (pixels: Uint8ClampedArray, changes: NonNullable<NonNullable<Image["drawingProps"]>["colorChanges"]>) => Uint8ClampedArray } = await import(new URL("./image-drawing-props.mjs", import.meta.resolve("@eigenpal/docx-editor-core")).href);
  const change = { from: { rgb: [255, 255, 255], alpha: 255 }, to: { rgb: [0, 0, 255], alpha: 0 }, useAlpha: true };
  const pixels = new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 255, 255, 255, 255, 128]);
  expect([...effects.applyImageColorChanges(pixels.slice(), [change])]).toEqual([0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 128]);
  expect([...effects.applyImageColorChanges(pixels.slice(), [{ ...change, useAlpha: false }])]).toEqual([0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 128]);
});


test("transparent wrapping header objects constrain body measurements and are visible without images", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => ({ font: "14px Arial", measureText: (text: string) => ({ width: text.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }) }) }) } });
  resetCanvasContext(); clearAllCaches();
  try {
  const document = await parseDocx(await letterheadTemplate());
  const section = document.package.document.finalSectionProperties;
  const doc = schema.node("doc", null, [schema.node("paragraph", { paraId: "BODY" }, schema.text("Body text must wrap clear of the sidebar. ".repeat(12)))]);
  const size = getPageSize(section), margins = getMargins(section), width = size.w - margins.left - margins.right;
  const hf = resolveHeaderFooter(document, section);
  const result = computeLayout({ state: EditorState.create({ doc }), document, pageSize: size, margins, columns: undefined, finalPageSize: size, finalMargins: margins, finalColumns: undefined, pageGap: 20, contentWidth: width, theme: document.package.theme, styles: document.package.styles, sectionProperties: section, finalSectionProperties: section, headerContent: hf.header, footerContent: null, firstPageHeaderContent: hf.firstHeader, firstPageFooterContent: null, getHfPmDoc: () => null,
    measureBlocks: (blocks, widths) => blocks.map((block, index) => { if (block.kind !== "paragraph") throw new Error("Expected paragraph fixture"); return measureParagraph(block, typeof widths === "number" ? widths : widths[index]); }),
  });
  const measure = result.measures[0]; if (measure.kind !== "paragraph") throw new Error("Missing body measurement");
  const block = result.blocks[0]; if (block.kind !== "paragraph") throw new Error("Missing paragraph");
  const normal = measureParagraph(block, width);
  expect(measure.lines.length).toBeGreaterThan(normal.lines.length);
  const geometry = wordPageGeometry(document, result.layout, 1);
  expect(geometry.wrappingExclusions).toHaveLength(1);
  expect(geometry.wrappingExclusions[0]).toMatchObject({ wrapType: "square", behindDoc: true });
  expect(geometry.hasPageBackgroundImage).toBe(true);
  const right = geometry.wrappingExclusions[0].x - geometry.wrappingExclusions[0].distLeft;
  expect(right).toBeLessThan(width);
  } finally { resetCanvasContext(); clearAllCaches(); if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document"); }
});
