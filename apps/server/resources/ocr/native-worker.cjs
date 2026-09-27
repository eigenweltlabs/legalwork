// One page per process. The host supplies model paths; document bytes arrive on stdin.
// Native libraries and the OCR pipeline ship with the application, never downloaded here.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const ort = require("onnxruntime-node");
const { PaddleOcrService } = require("paddleocr");
const { imageSize } = require("image-size");

// Explicit local assets only. Fail closed if a dependency ever attempts a fetch.
globalThis.fetch = async () => { throw new Error("Network is disabled in the OCR worker"); };
console.log = () => {};
console.error = () => {};

async function recognize() {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 28 * 1024 * 1024) throw new Error("Input too large");
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const modelDirectory = process.argv[process.argv.indexOf("--model-dir") + 1];
  const manifest = JSON.parse(readFileSync(join(modelDirectory, "pp-ocrv6-small.json"), "utf8"));
  if (manifest.version !== 1 || manifest.model !== "pp-ocrv6-small") throw new Error("Invalid manifest");
  const modelBuffer = path => Uint8Array.from(readFileSync(path)).buffer;
  const dictionary = readFileSync(manifest.keys, "utf8").replace(/\r/g, "").split("\n");
  if (dictionary.at(-1) === "") dictionary.pop();
  // The Paddle dictionary excludes CTC blank (handled by the decoder) and space.
  dictionary.push(" ");
  const engine = await PaddleOcrService.createInstance({
    ort: { Tensor: ort.Tensor, InferenceSession: { create: buffer => ort.InferenceSession.create(buffer, {
      executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1,
    }) } },
    modelPreset: "PP-OCRv6_small",
    detection: { modelBuffer: modelBuffer(manifest.det), maxSideLength: 960, limitType: "max" },
    recognition: { modelBuffer: modelBuffer(manifest.rec), charactersDictionary: dictionary },
  });
  try {
    const results = await engine.recognize({ width: image.width, height: image.height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) });
    const regions = results.filter(item => item.confidence >= 0.5 && item.text.trim()).flatMap(item => {
      const x = Math.max(0, item.box.x / image.width), y = Math.max(0, item.box.y / image.height);
      const right = Math.min(1, (item.box.x + item.box.width) / image.width), bottom = Math.min(1, (item.box.y + item.box.height) / image.height);
      return right > x && bottom > y ? [{ text: item.text, confidence: item.confidence, box: { x, y, width: right - x, height: bottom - y } }] : [];
    });
    const result = JSON.stringify({ text: regions.map(item => item.text).join("\n"), regions, truncated: false });
    if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("Output too large");
    process.stdout.write(result);
  } finally { await engine.destroy(); }
}

recognize().catch(() => {
  // Never include source text, paths, environment values or native error bodies.
  process.stderr.write("Local OCR processing failed\n");
  process.exitCode = 4;
});
