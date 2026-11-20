import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { PdfReader } from "../src/pdf-reader.js";
import { OcrService } from "../src/ocr/service.js";
import { createServerOcrEngine } from "../src/ocr/server-engine.js";

const [file, output, ...requestedLevels] = process.argv.slice(2);
if (!file || !output) throw new Error("Usage: bun scripts/benchmark-ocr-pages.ts /path/to/synthetic-scan.pdf /private/results.json [concurrency ...]");
const levels = z.array(z.coerce.number().int().min(1).max(8)).min(1).parse(requestedLevels.length ? requestedLevels : [1, 2, 4, 8]);
const directory = process.env.OCR_DEV_DIRECTORY || join(homedir(), ".config/eigenwelt-ocr-dev");
const config = z.object({ endpoint: z.string(), model: z.string(), apiKey: z.string() }).parse(JSON.parse(await readFile(join(directory, "legalwork.json"), "utf8")));
const expected = z.object({ pages: z.number(), markers: z.array(z.string()) }).parse(JSON.parse(await readFile(join(directory, "scan-test-expectations.json"), "utf8")));
const bytes = new Uint8Array(await readFile(file));
const results: Array<{ concurrency: number; seconds: number; pages: number; markers: number }> = [];

// Fresh PNG metadata preserves pixels but bypasses durable server-side deduplication.
// Reopening a PdfReader alone only clears its local cache.
function freshPng(bytes: Uint8Array, nonce: string) {
  const data = Buffer.from("ocr-benchmark\0" + nonce), payload = Buffer.concat([Buffer.from("tEXt"), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  if (Buffer.from(bytes.subarray(bytes.length - 8, bytes.length - 4)).toString() !== "IEND") throw new Error("Benchmark rendering must produce PNG pages");
  return new Uint8Array(Buffer.concat([bytes.subarray(0, bytes.length - 12), length, payload, checksum, bytes.subarray(bytes.length - 12)]));
}

async function run(concurrency: number) {
  const nonce = randomUUID();
  const engine = createServerOcrEngine({ id: "benchmark", label: "Gateway benchmark", kind: "mcp-ocr", model: config.model,
    endpoint: config.endpoint, apiKeyRef: "benchmark", languages: null, maxTokens: 8192 }, async () => config.apiKey);
  const reader = new PdfReader({ async serviceSnapshot() {
    return { fingerprint: String(concurrency), service: new OcrService([{ ...engine, info: { ...engine.info, concurrentPages: concurrency },
      recognize: (page, context) => engine.recognize({ ...page, data: freshPng(page.data, nonce) }, context) }], "benchmark") };
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

const warmup = Math.max(...levels);
console.log(JSON.stringify({ phase: "warmup", concurrency: warmup }));
console.log(JSON.stringify({ warmup: await run(warmup) }));
for (const concurrency of levels) {
  console.log(JSON.stringify({ phase: "measure", concurrency }));
  const result = await run(concurrency);
  results.push(result);
  await writeFile(output, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
