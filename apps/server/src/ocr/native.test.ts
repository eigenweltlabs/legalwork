import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrRuntime, ocrTestPage } from "./runtime.js";
import { createLocalOcrEngine } from "./local.js";
import { OcrService } from "./service.js";

test("native worker isolation and cancellation do not depend on Python", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-native-"));
  const runtime = new OcrRuntime(root), workerPath = join(root, "fixture.cjs");
  process.env.LEGALWORK_OCR_TEST_SECRET = "never-forward";
  try {
    await writeFile(workerPath, "if (process.env.LEGALWORK_OCR_TEST_SECRET || process.env.NODE_OPTIONS) process.exit(4); process.stdout.write(JSON.stringify({text:'native',regions:[],truncated:false}));");
    const local = { ...runtime.local, python: "/missing-python", native: { executable: process.execPath, workerPath, moduleDirectory: root } };
    const engine = createLocalOcrEngine({ id: "local-fast", label: "Fast", kind: "local", model: "pp-ocrv6-small" }, local);
    const request = { sourceId: "native", pages: [await ocrTestPage()], languages: [] };
    expect((await new OcrService([engine]).extract(request)).pages[0]?.text).toBe("native");
    await writeFile(workerPath, "setTimeout(() => process.stdout.write('{}'), 30000);");
    await expect(new OcrService([engine], "local-fast", 30).extract(request)).rejects.toMatchObject({ code: "timeout" });
  } finally { delete process.env.LEGALWORK_OCR_TEST_SECRET; await rm(root, { recursive: true, force: true }); }
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
}, 120000);
