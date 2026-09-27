import { expect, test } from "bun:test";
import { PageStructureSchema } from "@legalwork/types/document-structure";
import { assemblePageStructure } from "./structure.js";

test("preserves unmatched marginal text and detector column order without inventing handwriting", () => {
  const ocr = { text: "Left\nRight\nMargin", truncated: false, regions: [
    { text: "Left", box: { x: .1, y: .2, width: .2, height: .04 } },
    { text: "Right", box: { x: .6, y: .1, width: .2, height: .04 } },
    { text: "Margin", box: { x: .9, y: .4, width: .09, height: .04 } },
  ] };
  const result = assemblePageStructure(2, ocr, { model: "test", regions: [
    { label: "text", box: { x: .05, y: .05, width: .4, height: .8 }, confidence: .9, order: 0 },
    { label: "text", box: { x: .55, y: .05, width: .3, height: .8 }, confidence: .9, order: 1 },
  ] });
  expect(PageStructureSchema.parse(result)).toEqual(result);
  expect(result.regions.map(region => region.text)).toEqual(["Left", "Right", "Margin"]);
  expect(result.regions.map(region => region.ocrRegionIds)).toEqual([[0], [1], [2]]);
  expect(result.regions.every(region => region.writing === "unknown")).toBe(true);
  expect(result.readingOrder.indexOf("p2-r1")).toBeLessThan(result.readingOrder.indexOf("p2-r2"));
});

test("text-only providers retain layout boxes without fabricated text-to-position matches", () => {
  const result = assemblePageStructure(1, { text: "Contract", regions: [], truncated: false }, { model: "test", regions: [
    { label: "doc_title", box: { x: .1, y: .1, width: .8, height: .1 }, confidence: .95, order: 0 },
  ] });
  expect(result.status).toBe("partial"); expect(result.issues).toContain("ocr-coordinates-unavailable");
  expect(result.regions[0]).toMatchObject({ kind: "heading", text: "", source: "layout", ocrRegionIds: [] });
});

test("unclassified lines retain OCR order when inserted beside the same layout block", () => {
  const result = assemblePageStructure(1, { text: "Body\nFirst\nSecond", truncated: false, regions: [
    { text: "Body", box: { x: .2, y: .2, width: .4, height: .1 } },
    { text: "First", box: { x: .85, y: .2, width: .1, height: .02 } },
    { text: "Second", box: { x: .7, y: .2, width: .1, height: .02 } },
  ] }, { model: "test", regions: [{ label: "text", box: { x: .2, y: .2, width: .4, height: .1 }, confidence: 1, order: 0 }] });
  expect(result.readingOrder.map(id => result.regions.find(region => region.id === id)!.text)).toEqual(["Body", "First", "Second"]);
});
