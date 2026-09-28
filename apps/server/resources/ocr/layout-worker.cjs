// Serves pages until stdin closes: one JSON request per line, one JSON reply per line; the model stays loaded.
// The host prepares a pinned model; inference is offline.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { imageSize } = require("image-size");
const ort = require("onnxruntime-node");

globalThis.fetch = async () => { throw new Error("Network is disabled in the layout worker"); };
console.log = () => {};
console.error = () => {};

const labels = ["abstract", "algorithm", "aside_text", "chart", "content", "display_formula", "doc_title", "figure_title", "footer", "footer_image", "footnote", "formula_number", "header", "header_image", "image", "inline_formula", "number", "paragraph_title", "reference", "reference_content", "seal", "table", "text", "vertical_text", "vision_footnote"];
const side = 800;
function cubic(x) {
  const a = -0.75, distance = Math.abs(x);
  if (distance <= 1) return (a + 2) * distance ** 3 - (a + 3) * distance ** 2 + 1;
  if (distance < 2) return a * distance ** 3 - 5 * a * distance ** 2 + 8 * a * distance - 4 * a;
  return 0;
}

// OpenCV INTER_CUBIC: half-pixel centers, edge replication, 8-bit output before /255.
function axis(length) {
  return Array.from({ length: side }, (_, output) => {
    const source = (output + 0.5) * length / side - 0.5;
    const base = Math.floor(source);
    return Array.from({ length: 4 }, (_, index) => ({
      position: Math.max(0, Math.min(length - 1, base + index - 1)),
      weight: cubic(source - (base + index - 1)),
    }));
  });
}

function resizeRgb(pixels, width, height) {
  const xs = axis(width), ys = axis(height);
  const plane = side * side, output = new Float32Array(3 * plane);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const channels = [0, 0, 0];
    for (const sy of ys[y]) for (const sx of xs[x]) {
      const offset = (sy.position * width + sx.position) * 4;
      const weight = sy.weight * sx.weight;
      for (let channel = 0; channel < 3; channel++) channels[channel] += pixels[offset + channel] * weight;
    }
    const index = y * side + x;
    for (let channel = 0; channel < 3; channel++) output[channel * plane + index] = Math.max(0, Math.min(255, Math.round(channels[channel]))) / 255;
  }
  return output;
}

let session;
async function detect(request) {
  if (!Number.isInteger(request.width) || !Number.isInteger(request.height) || request.width < 1 || request.height < 1 ||
      request.width > 20000 || request.height > 20000 || request.width * request.height > 40000000 || typeof request.image !== "string") throw new Error("Invalid page");
  const bytes = Buffer.from(request.image, "base64");
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (bytes.length > 20 * 1024 * 1024 || !(png || jpeg || webp)) throw new Error("Unsupported image");
  const dimensions = imageSize(bytes);
  if (dimensions.width !== request.width || dimensions.height !== request.height) throw new Error("Invalid page dimensions");
  const image = await loadImage(bytes);
  if (image.width !== request.width || image.height !== request.height) throw new Error("Invalid page dimensions");
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, image.width, image.height);
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  const data = resizeRgb(pixels, image.width, image.height);
  if (!session) {
    const directory = process.argv[process.argv.indexOf("--model-dir") + 1];
    if (!directory) throw new Error("Missing model directory");
    const model = readFileSync(join(directory, "pp-doclayout-v3-onnx", "inference.onnx"));
    session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: 4, interOpNumThreads: 1 });
  }
  {
    const feeds = {
      image: new ort.Tensor("float32", data, [1, 3, side, side]),
      scale_factor: new ort.Tensor("float32", Float32Array.from([side / image.height, side / image.width]), [1, 2]),
      im_shape: new ort.Tensor("float32", Float32Array.from([side, side]), [1, 2]),
    };
    const output = await session.run(Object.fromEntries(session.inputNames.map(name => [name, feeds[name]])));
    const [detections, count, masks] = session.outputNames.map(name => output[name].data);
    const regionCount = Number(count[0]);
    if (!Number.isInteger(regionCount) || regionCount < 0 || regionCount > 1000 || regionCount * 7 > detections.length) throw new Error("Invalid region count");
    // Per-region 200x200 masks give PaddleX's layout outlines; ship them bit-packed.
    const maskCells = 200 * 200;
    if (masks.length < regionCount * maskCells) throw new Error("Invalid region masks");
    const packMask = index => {
      const packed = Buffer.alloc(maskCells / 8);
      for (let cell = 0; cell < maskCells; cell++) if (masks[index * maskCells + cell]) packed[cell >> 3] |= 128 >> (cell & 7);
      return packed.toString("base64");
    };
    const regions = [];
    for (let index = 0; index < regionCount; index++) {
      const row = Array.from(detections.slice(index * 7, index * 7 + 7), Number);
      if (row.some(value => !Number.isFinite(value))) throw new Error("Invalid region values");
      const [id, confidence, left, top, right, bottom, order] = row;
      if (!Number.isInteger(id) || id < 0 || id >= labels.length || confidence < 0 || confidence > 1 || !Number.isInteger(order) || order < 0) throw new Error("Invalid region");
      if (confidence <= 0.3) continue;
      const x0 = Math.max(0, Math.min(image.width, left)), y0 = Math.max(0, Math.min(image.height, top));
      const x1 = Math.max(0, Math.min(image.width, right)), y1 = Math.max(0, Math.min(image.height, bottom));
      if (x1 <= x0 || y1 <= y0) continue;
      regions.push({ label: labels[id], confidence, box: { x: x0 / image.width, y: y0 / image.height,
        width: (x1 - x0) / image.width, height: (y1 - y0) / image.height }, order, mask: packMask(index) });
    }
    regions.sort((a, b) => a.order - b.order);
    const result = JSON.stringify({ model: "pp-doclayout-v3-onnx", regions });
    if (Buffer.byteLength(result) > 8 * 1024 * 1024) throw new Error("Output too large");
    return result;
  }
}

async function reply(line) {
  let id = null;
  try {
    const request = JSON.parse(line);
    id = request.id;
    process.stdout.write(`{"id":${JSON.stringify(id)},"result":${await detect(request)}}\n`);
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
process.stdin.on("end", () => { void queue.then(() => session?.release()).finally(() => process.exit(0)); });
