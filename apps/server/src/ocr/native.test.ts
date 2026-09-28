import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OcrRuntime, ocrTestPage } from "./runtime.js";
import { createLocalOcrEngine } from "./local.js";
import { OcrService } from "./service.js";
import type { VlRequest } from "./vl-blocks.js";

// A fixture worker that speaks the line protocol: `body` answers one parsed `request`.
const lineWorker = (body: string) => `let buffer = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => { buffer += chunk;
  for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) { const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
  const reply = result => process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n"); ${body} } });`;

test("native worker isolation and cancellation do not depend on Python", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-native-"));
  const runtime = new OcrRuntime(root), workerPath = join(root, "fixture.cjs"), hangingPath = join(root, "hanging.cjs");
  process.env.LEGALWORK_OCR_TEST_SECRET = "never-forward";
  const fast = (path: string) => createLocalOcrEngine({ id: "local-fast", label: "Fast", kind: "local", model: "pp-ocrv6-small" },
    { ...runtime.local, python: "/missing-python", native: { executable: process.execPath, workerPath: path, moduleDirectory: root } });
  const engine = fast(workerPath), hanging = fast(hangingPath);
  try {
    await writeFile(workerPath, lineWorker("if (process.env.LEGALWORK_OCR_TEST_SECRET || process.env.NODE_OPTIONS) process.exit(4); reply({ text: 'native ' + process.pid, regions: [], truncated: false });"));
    const request = { sourceId: "native", pages: [await ocrTestPage()], languages: [] };
    const first = (await new OcrService([engine]).extract(request)).pages[0]?.text;
    expect(first).toStartWith("native ");
    // The worker stays loaded: a second page is answered by the same process.
    expect((await new OcrService([engine]).extract(request)).pages[0]?.text).toBe(first!);
    await writeFile(hangingPath, lineWorker("/* Never answers. */"));
    await expect(new OcrService([hanging], "local-fast", 30).extract(request)).rejects.toMatchObject({ code: "timeout" });
  } finally { engine.close?.(); hanging.close?.(); delete process.env.LEGALWORK_OCR_TEST_SECRET; await rm(root, { recursive: true, force: true }); }
});

test("the quality model reads block crops and the text lines outside them, two at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-lines-"));
  const runtime = new OcrRuntime(root);
  const line = { x: 0.1, y: 0.8, width: 0.5, height: 0.05 };
  const quality = async (lines: object[] | "none") => {
    const nativePath = join(root, `native-${randomUUID()}.cjs`);
    await writeFile(nativePath, lines === "none" ? "process.exit(4);" : lineWorker(`if (!request.detectOnly) process.exit(4); reply({ lines: ${JSON.stringify(lines)} });`));
    const prompts: string[] = [];
    let active = 0, most = 0;
    // Answers with the prompt and the token limit; records how many crops were read at once.
    const reader = { close() {}, async read(request: VlRequest) {
      most = Math.max(most, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--; prompts.push(request.prompt);
      return { text: `${request.prompt} ${request.limit}`, cut: false };
    } };
    const engine = createLocalOcrEngine({ id: "local-quality", label: "Quality", kind: "local", model: "paddleocr-vl-1.6" },
      { ...runtime.local, native: { executable: process.execPath, workerPath: nativePath, moduleDirectory: root } }, reader);
    return { engine, prompts, most: () => most };
  };
  const context = { languages: [], signal: new AbortController().signal };
  try {
    const blocks = [{ label: "text", box: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 } }, { label: "text", box: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 } }];
    const read = await quality([line]);
    expect((await read.engine.recognize({ ...await ocrTestPage(), blocks }, context)).text).toBe("OCR: 4096\nOCR: 4096\nOCR: 512");
    expect(read.most()).toBe(2);
    // Layout without blocks: a page without text lines is blank and needs no model; text lines mean the page is read whole.
    const blank = await quality([]);
    expect((await blank.engine.recognize({ ...await ocrTestPage(), blocks: [] }, context)).text).toBe("");
    expect(blank.prompts).toEqual([]);
    expect((await read.engine.recognize({ ...await ocrTestPage(), blocks: [] }, context)).text).toBe("OCR: 4096");
    // Without layout the whole page is read and no line detection runs.
    const whole = await quality("none");
    expect((await whole.engine.recognize(await ocrTestPage(), context)).text).toBe("OCR: 4096");
    for (const item of [read, blank, whole]) item.engine.close?.();
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Opt in with a provisioned OCR root. No downloads happen in this test.
const smokeRoot = process.env.LEGALWORK_OCR_NATIVE_SMOKE_ROOT;
test.skipIf(!smokeRoot)("real native OCR reads multiple languages, skewed images and blank pages without Python", async () => {
  if (!smokeRoot) return;
  const runtime = new OcrRuntime(smokeRoot);
  expect(await runtime.ready("pp-ocrv6-small")).toBe(true);
  expect(await access(runtime.local.python).then(() => true, () => false)).toBe(false);
  const engine = createLocalOcrEngine({ id: "local-fast", label: "Fast", kind: "local", model: "pp-ocrv6-small" }, runtime.local);
  const service = new OcrService([engine]);
  const fixture = await ocrTestPage();
  const result = await service.extract({ sourceId: "native", pages: [fixture], languages: ["en", "de"] });
  expect(result.pages[0]?.text).toContain("Agreement"); expect(result.pages[0]?.text).toContain("fällig");
  expect(result.pages[0]?.regions.length).toBeGreaterThan(0);
  const canvas = createCanvas(1200, 400), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1200, 400);
  ctx.save(); ctx.translate(40, 20); ctx.rotate(0.045);
  ctx.fillStyle = "black"; ctx.font = "30px Arial";
  ctx.fillText("Français: Le paiement est dû vendredi.", 0, 70);
  ctx.fillText("Español: El pago vence el viernes.", 0, 140);
  ctx.fillText("Deutsch: Die Zahlung ist am Freitag fällig.", 0, 210); ctx.restore();
  const multilingual = await service.extract({ sourceId: "skewed", languages: ["fr", "es", "de"], pages: [{ ...fixture, width: 1200, height: 400, data: Uint8Array.from(canvas.toBuffer("image/png")) }] });
  expect(multilingual.pages[0]?.text).toContain("paiement"); expect(multilingual.pages[0]?.text).toContain("viernes"); expect(multilingual.pages[0]?.text).toContain("Zahlung");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1200, 400);
  const blank = await service.extract({ sourceId: "blank", languages: [], pages: [{ ...fixture, width: 1200, height: 400, data: Uint8Array.from(canvas.toBuffer("image/png")) }] });
  expect(blank.pages[0]?.text).toBe(""); expect(blank.pages[0]?.regions).toEqual([]);
  await expect(service.extract({ sourceId: "wrong-size", languages: [], pages: [{ ...fixture, width: 999 }] })).rejects.toMatchObject({ code: "local-failed" });
  const image = await loadImage(await readFile(new URL("../../resources/ocr/test-page.png", import.meta.url)));
  const converted = createCanvas(image.width, image.height); converted.getContext("2d").drawImage(image, 0, 0);
  for (const mimeType of ["image/jpeg", "image/webp"] as const) {
    const result = await service.extract({ sourceId: mimeType, languages: [], pages: [{ ...fixture, mimeType, data: Uint8Array.from(converted.toBuffer(mimeType)) }] });
    expect(result.pages[0]?.text).toContain("Agreement");
  }
  // With the quality model prepared, llama.cpp reads the page without Python.
  if (await runtime.ready("paddleocr-vl-1.6")) {
    const quality = createLocalOcrEngine({ id: "local-quality", label: "Quality", kind: "local", model: "paddleocr-vl-1.6" }, runtime.local);
    try { expect((await quality.recognize(fixture, { languages: [], signal: new AbortController().signal })).text).toContain("Agreement"); }
    finally { quality.close?.(); }
  }
  engine.close?.();
}, 120000);
