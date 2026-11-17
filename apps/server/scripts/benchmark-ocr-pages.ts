import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PdfReader } from "../src/pdf-reader.js";
import { OcrService } from "../src/ocr/service.js";
import { createServerOcrEngine } from "../src/ocr/server-engine.js";

const [file, output] = process.argv.slice(2);
if (!file || !output) throw new Error("Usage: bun scripts/benchmark-ocr-pages.ts /path/to/synthetic-scan.pdf /private/results.json");
const directory = process.env.OCR_DEV_DIRECTORY || join(homedir(), ".config/eigenwelt-ocr-dev");
const config = z.object({ endpoint: z.string(), model: z.string(), apiKey: z.string() }).parse(JSON.parse(await readFile(join(directory, "legalwork.json"), "utf8")));
const expected = z.object({ pages: z.number(), markers: z.array(z.string()) }).parse(JSON.parse(await readFile(join(directory, "scan-test-expectations.json"), "utf8")));
const bytes = new Uint8Array(await readFile(file));
const results: Array<{ concurrency: number; seconds: number; pages: number; markers: number }> = [];

async function run(concurrency: number) {
  const engine = createServerOcrEngine({ id: "benchmark", label: "Gateway benchmark", kind: "mcp-ocr", model: config.model,
    endpoint: config.endpoint, apiKeyRef: "benchmark", languages: null, maxTokens: 8192 }, async () => config.apiKey);
  const reader = new PdfReader({ async serviceSnapshot() {
    return { fingerprint: String(concurrency), service: new OcrService([{ ...engine, info: { ...engine.info, concurrentPages: concurrency } }], "benchmark") };
  } });
  const started = performance.now();
  const result = await reader.read(bytes, { ocr: true, text: false }, AbortSignal.timeout(240_000));
  const text = result.pages.map(page => page.text).join("\n");
  const markers = expected.markers.filter(marker => text.includes(marker)).length;
  const invalid = result.pages.filter(page => page.error || !page.text.includes(expected.markers[page.page - 1]));
  if (!result.complete || result.pages.length !== expected.pages || markers !== expected.markers.length || invalid.length) {
    console.log(JSON.stringify({ failed: true, concurrency, complete: result.complete, markers,
      invalidPages: invalid.map(page => ({ page: page.page, error: page.error })) }));
    throw new Error("Synthetic page recognition failed; benchmark is invalid.");
  }
  return { concurrency, seconds: Math.round(performance.now() - started) / 1000, pages: result.pages.length, markers };
}

console.log(JSON.stringify({ phase: "warmup", concurrency: 8 }));
console.log(JSON.stringify({ warmup: await run(8) }));
for (const concurrency of [1, 2, 4, 8]) {
  console.log(JSON.stringify({ phase: "measure", concurrency }));
  const result = await run(concurrency);
  results.push(result);
  await writeFile(output, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
