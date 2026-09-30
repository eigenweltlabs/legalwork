import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { parseOtsl, readBlocks, truncateRepetitiveContent, type VlRequest } from "./vl-blocks.js";
import { fillPolygon, layoutPolygons } from "./vl-outlines.js";

// Expected values come from PaddleX's Python code with OpenCV 5.0 and Python's random module.
const page = async (width: number, height: number, color: string) => {
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return { pageNumber: 1, mimeType: "image/png" as const, width, height, data: new Uint8Array(await canvas.encode("png")) };
};

test("polygon fills and layout outlines match OpenCV and PaddleX", async () => {
  const rows = (mask: Uint8Array) => Array.from({ length: 20 }, (_, y) => mask.subarray(y * 20, y * 20 + 20).join(""));
  const triangle = new Uint8Array(400);
  fillPolygon(triangle, 20, 20, [[2, 3], [17, 5], [8, 18]]);
  expect(rows(triangle)).toEqual(["00000000000000000000", "00000000000000000000", "00000000000000000000", "00111100000000000000",
    "00111111111111000000", "00011111111111111100", "00011111111111111000", "00001111111111111000", "00001111111111110000",
    "00001111111111100000", "00000111111111100000", "00000111111111000000", "00000011111110000000", "00000011111100000000",
    "00000011111100000000", "00000001111000000000", "00000001110000000000", "00000000110000000000", "00000000100000000000", "00000000000000000000"]);
  const clipped = new Uint8Array(400);
  fillPolygon(clipped, 20, 20, [[-5, 2], [25, 8], [10, 25]]);
  expect(rows(clipped)).toEqual(["00000000000000000000", "00000000000000000000", "00000000000000000000", "11100000000000000000",
    "11111111000000000000", "11111111111100000000", "11111111111111111000", "11111111111111111111", "11111111111111111111",
    "11111111111111111111", "01111111111111111111", "01111111111111111111", "00111111111111111111", "00011111111111111111",
    "00011111111111111111", "00001111111111111110", "00000111111111111100", "00000011111111111100", "00000011111111111000", "00000001111111110000"]);

  // An L-shaped layout mask in a larger block keeps its outline; everything outside it is whitened.
  const bits = new Uint8Array(5000);
  for (let y = 25; y < 125; y++) for (let x = 25; x < 125; x++) {
    if (y < 75 || x < 60) bits[(y * 200 + x) >> 3]! |= 128 >> ((y * 200 + x) & 7);
  }
  const mask = Buffer.from(bits).toString("base64");
  expect(layoutPolygons([{ px: [100, 100, 600, 600], mask }], 800, 800)).toEqual([[[100, 499], [239, 499], [240, 299], [499, 299], [499, 100], [100, 100]]]);
  let dark = 0;
  await readBlocks({ ...await page(800, 800, "black"), blocks: [{ label: "text", box: { x: 0.125, y: 0.125, width: 0.625, height: 0.625 }, mask }] }, [], async requests => {
    const image = await loadImage(Buffer.from(requests[0]!.image)), canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    for (let i = 0; i < data.length; i += 4) if (data[i] === 0) dark++;
    return requests.map(() => ({ text: "", cut: false }));
  });
  // After Paddle's resize to 504x504 (PIL bicubic gives the same count).
  expect(dark).toBe(109585);
});

test("table tokens and repetition trimming follow PaddleX", () => {
  expect(parseOtsl("<fcel>A<lcel><fcel>B<nl><fcel>C<fcel>D<fcel>E<nl>")).toEqual({ rows: 2, columns: 3, cells: [
    { row: 0, column: 0, rowSpan: 1, columnSpan: 2, text: "A" }, { row: 0, column: 2, rowSpan: 1, columnSpan: 1, text: "B" },
    { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: "C" }, { row: 1, column: 1, rowSpan: 1, columnSpan: 1, text: "D" },
    { row: 1, column: 2, rowSpan: 1, columnSpan: 1, text: "E" }] });
  expect(parseOtsl("<fcel>Name<fcel>Amount<nl><fcel>Fee<ucel>\n<nl><fcel>Total<fcel>12<nl>")).toEqual({ rows: 3, columns: 2, cells: [
    { row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: "Name" }, { row: 0, column: 1, rowSpan: 2, columnSpan: 1, text: "Amount" },
    { row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: "Fee" }, { row: 2, column: 0, rowSpan: 1, columnSpan: 1, text: "Total" },
    { row: 2, column: 1, rowSpan: 1, columnSpan: 1, text: "12" }] });
  expect(parseOtsl("<fcel>x<fcel><nl><ecel><fcel>y").cells.map(cell => cell.text)).toEqual(["x", "", "", "y"]);
  expect(truncateRepetitiveContent("ab".repeat(30), 50)).toBe("ab");
  expect(truncateRepetitiveContent(Array(12).fill("same line").join("\n"), 50)).toBe("same line");
  expect(truncateRepetitiveContent(`Hello world, ${"xyzxyzxy".repeat(12)}`, 50)).toBe("Hello world, ");
});

test("blocks and missed lines are read in one call and assembled like PaddleOCR-VL", async () => {
  const box = (x0: number, y0: number, x1: number, y1: number) => ({ x: x0 / 400, y: y0 / 200, width: (x1 - x0) / 400, height: (y1 - y0) / 200 });
  const blocks = [
    { label: "table", box: box(0, 0, 400, 120) },
    { label: "image", box: box(10, 10, 40, 40) }, { label: "image", box: box(100, 10, 140, 50) }, { label: "image", box: box(200, 10, 250, 60) },
    // The layout model is unsure and the line detector found nothing here: not read.
    { label: "text", box: box(0, 150, 200, 190), confidence: 0.3 },
    { label: "display_formula", box: box(250, 125, 390, 150) },
  ];
  let seen: VlRequest[] = [];
  const result = await readBlocks({ ...await page(400, 200, "white"), blocks }, [box(250, 160, 390, 180)], async requests => {
    seen = requests;
    // The table, the three pictures by width, the formula and the line outside every block.
    const answers = ["<fcel>[F2]<fcel>[F3]<fcel>[F4]<nl>", "w30", "w40", "w50", "\\[x^2\\]", "w140"];
    return requests.map((_, index) => ({ text: answers[index]!, cut: false }));
  });
  expect(seen.map(({ prompt, limit }) => [prompt, limit])).toEqual([["Table Recognition:", 4096], ["OCR:", 4096], ["OCR:", 4096], ["OCR:", 4096], ["Formula Recognition:", 4096], ["OCR:", 512]]);
  // Python's random.Random(1024) numbers the three pictures 4, 3 and 2.
  expect(result.regions.map(region => region.text)).toEqual(["[image] w50 | [image] w40 | [image] w30", " $$ x^2 $$ ", "w140"]);
  expect(result.regions[0]!.table?.cells.map(cell => cell.text)).toEqual(["[image] w50", "[image] w40", "[image] w30"]);
  expect(result.truncated).toBe(false);
});

test("without layout blocks only detected lines are read, and a blank page needs no model call", async () => {
  const blank = { ...await page(400, 200, "white"), blocks: [] };
  let calls = 0;
  const empty = await readBlocks(blank, [], async requests => { calls++; return requests.map(() => ({ text: "", cut: false })); });
  expect([calls, empty.text, empty.regions]).toEqual([0, "", []]);
  const missed = await readBlocks(blank, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.1 }], async requests => requests.map(({ limit }) => ({ text: `line ${limit}`, cut: false })));
  expect(missed.text).toBe("line 512");
});
