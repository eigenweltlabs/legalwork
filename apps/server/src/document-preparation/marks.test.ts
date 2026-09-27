import { expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import type { DocumentRegion } from "@legalwork/types/document-structure";
import { detectDocumentMarks } from "./marks.js";

const width = 320, height = 160;
function region(id: string, kind: DocumentRegion["kind"], x: number, y: number, w: number, h: number): DocumentRegion {
  return { id, kind, label: kind, text: "Printed agreement text", box: { x: x / width, y: y / height, width: w / width, height: h / height },
    ocrRegionIds: [], order: 0, writing: "printed", source: "ocr" };
}
function page(draw: (context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void) {
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, width, height);
  draw(context);
  return { pageNumber: 1, mimeType: "image/png" as const, width, height, data: Uint8Array.from(canvas.toBuffer("image/png")) };
}
function line(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, color: string, points: [number, number][]) {
  context.strokeStyle = color; context.lineWidth = 3; context.lineCap = "round"; context.lineJoin = "round";
  context.beginPath(); context.moveTo(...points[0]);
  for (const point of points.slice(1)) context.lineTo(...point);
  context.stroke();
}

test("finds a colored stroke through printed text and a headed arrow", async () => {
  const image = page(context => {
    context.fillStyle = "#222"; context.font = "18px Arial"; context.fillText("Printed agreement text", 20, 50);
    line(context, "#d00020", [[20, 44], [180, 44]]);
    line(context, "#064bd5", [[195, 100], [285, 100]]);
    line(context, "#064bd5", [[285, 100], [270, 88]]);
    line(context, "#064bd5", [[285, 100], [270, 112]]);
  });
  const marks = await detectDocumentMarks(image, [region("text", "text", 20, 30, 160, 30)], new AbortController().signal);
  expect(marks.map(mark => mark.kind).sort()).toEqual(["arrow", "strikeout"]);
  const strike = marks.find(mark => mark.kind === "strikeout");
  expect(strike?.box.y).toBeGreaterThan(.2);
  expect(strike?.box.y).toBeLessThan(.31);
  const arrow = marks.find(mark => mark.kind === "arrow");
  expect(arrow?.start?.x).toBeLessThan(.65);
  expect(arrow?.end?.x).toBeGreaterThan(.85);
});

test("colored underline and table borders are not strikeouts or arrows", async () => {
  const image = page(context => {
    context.fillStyle = "#222"; context.font = "18px Arial"; context.fillText("Printed agreement text", 20, 50);
    line(context, "#d00020", [[20, 57], [180, 57]]);
    context.strokeStyle = "#064bd5"; context.lineWidth = 3; context.strokeRect(20, 90, 160, 50);
    line(context, "#064bd5", [[20, 115], [180, 115]]);
  });
  const regions = [region("text", "text", 20, 30, 160, 30), region("table", "table", 20, 90, 160, 50)];
  expect(await detectDocumentMarks(image, regions, new AbortController().signal)).toEqual([]);
});

test("OCR line geometry finds a strike on the first line of a paragraph without mistaking its underline", async () => {
  const paragraph = region("paragraph", "text", 20, 30, 160, 76);
  const lines = [35, 58, 81].map((y, index) => ({ text: `Printed line ${index + 1}`,
    box: { x: 20 / width, y: y / height, width: 160 / width, height: 18 / height } }));
  const draw = (strokeY: number) => page(context => {
    context.fillStyle = "#222"; context.font = "16px Arial";
    for (const y of [50, 73, 96]) context.fillText("Printed paragraph line", 20, y);
    line(context, "#d00020", [[20, strokeY], [180, strokeY]]);
  });
  const strike = await detectDocumentMarks(draw(43), [paragraph], new AbortController().signal, lines);
  expect(strike.map(mark => mark.kind)).toEqual(["strikeout"]);
  expect(await detectDocumentMarks(draw(55), [paragraph], new AbortController().signal, lines)).toEqual([]);
});

test("aborted, inconsistent, and blank pages yield no marks", async () => {
  const image = page(() => undefined);
  const controller = new AbortController(); controller.abort();
  await expect(detectDocumentMarks(image, [], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(await detectDocumentMarks({ ...image, width: width + 1 }, [], new AbortController().signal)).toEqual([]);
  expect(await detectDocumentMarks(image, [], new AbortController().signal)).toEqual([]);
});
