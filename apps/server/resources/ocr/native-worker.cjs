// Serves pages until stdin closes: one JSON request per line, one JSON reply per line; the models stay loaded.
// The host supplies model paths. Native libraries and the OCR pipeline ship with the application, never downloaded here.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const ort = require("onnxruntime-node");
const { PaddleOcrService, normalizeInputToRgb } = require("paddleocr");
const { imageSize } = require("image-size");

// Explicit local assets only. Fail closed if a dependency ever attempts a fetch.
globalThis.fetch = async () => { throw new Error("Network is disabled in the OCR worker"); };
console.log = () => {};
console.error = () => {};

let engine;
async function load() {
  const modelDirectory = process.argv[process.argv.indexOf("--model-dir") + 1];
  const manifest = JSON.parse(readFileSync(join(modelDirectory, "pp-ocrv6-small.json"), "utf8"));
  if (manifest.version !== 1 || manifest.model !== "pp-ocrv6-small") throw new Error("Invalid manifest");
  const modelBuffer = path => Uint8Array.from(readFileSync(path)).buffer;
  const dictionary = readFileSync(manifest.keys, "utf8").replace(/\r/g, "").split("\n");
  if (dictionary.at(-1) === "") dictionary.pop();
  // The Paddle dictionary excludes CTC blank (handled by the decoder) and space.
  dictionary.push(" ");
  return PaddleOcrService.createInstance({
    ort: { Tensor: ort.Tensor, InferenceSession: { create: buffer => ort.InferenceSession.create(buffer, {
      executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
    }) } },
    modelPreset: "PP-OCRv6_small",
    detection: { modelBuffer: modelBuffer(manifest.det), maxSideLength: 960, limitType: "max" },
    recognition: { modelBuffer: modelBuffer(manifest.rec), charactersDictionary: dictionary },
  });
}

async function recognize(request) {
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1 ||
      request.width > 20000 || request.height > 20000 || request.width * request.height > 40000000 || typeof request.image !== "string") throw new Error("Invalid image");
  const bytes = Buffer.from(request.image, "base64");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (bytes.length > 20 * 1024 * 1024 || !(png || jpeg || webp)) throw new Error("Unsupported image");
  // Inspect encoded dimensions before allocating/decompressing potentially huge images.
  const dimensions = imageSize(bytes);
  if (dimensions.width !== request.width || dimensions.height !== request.height) throw new Error("Invalid dimensions");
  const image = await loadImage(bytes);
  if (image.width !== request.width || image.height !== request.height) throw new Error("Invalid dimensions");
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  engine ??= await load();
  const input = { width: image.width, height: image.height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
  const normalized = box => {
    const x = Math.max(0, box.x / image.width), y = Math.max(0, box.y / image.height);
    const right = Math.min(1, (box.x + box.width) / image.width), bottom = Math.min(1, (box.y + box.height) / image.height);
    return right > x && bottom > y ? [{ x, y, width: right - x, height: bottom - y }] : [];
  };
  let result;
  if (request.detectOnly) {
    // Text-line boxes only, used to find text outside layout blocks: no recognition, no confidence filter.
    // Up to 2000 px instead of 960, so isolated small text such as page numbers is still found.
    result = JSON.stringify({ lines: (await engine.detectionService.run(normalizeInputToRgb(input), { maxSideLength: 2000 })).flatMap(normalized) });
  } else {
    const regions = (await engine.recognize(input)).filter(item => item.confidence >= 0.5 && item.text.trim())
      .flatMap(item => normalized(item.box).map(box => ({ text: item.text, confidence: item.confidence, box })));
    result = JSON.stringify({ text: regions.map(item => item.text).join("\n"), regions, truncated: false });
  }
  if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("Output too large");
  return result;
}

// Never include source text, paths, environment values or native error bodies in replies.
async function reply(line) {
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id;
    process.stdout.write(`{"id":${JSON.stringify(id)},"result":${await recognize(request)}}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ id, error: "failed" })}\n`); }
}

let parts = [], size = 0, queue = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  let start = 0;
  for (let newline = chunk.indexOf("\n"); newline >= 0; newline = chunk.indexOf("\n", start)) {
    parts.push(chunk.slice(start, newline));
    const line = parts.join("");
    parts = []; size = 0; start = newline + 1;
    queue = queue.then(() => reply(line));
  }
  parts.push(chunk.slice(start));
  size += chunk.length - start;
  if (size > 30 * 1024 * 1024) process.exit(4);
});
process.stdin.on("end", () => { void queue.then(() => engine?.destroy()).finally(() => process.exit(0)); });
