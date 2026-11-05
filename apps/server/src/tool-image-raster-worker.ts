import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { base64Bytes, exactKeys, isRecord, isRectangle, rasterMime } from "./tool-image-raster-contract.js";

const canvasEntry = process.argv[2], sizeEntry = process.argv[3];
const require = createRequire(canvasEntry);
const canvas: typeof import("@napi-rs/canvas") = require(canvasEntry);
const sizes: typeof import("image-size") = require(sizeEntry);
const version: unknown = require(join(dirname(canvasEntry), "package.json")).version;
if (typeof version !== "string") throw new Error("Canvas package version is unavailable.");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function send(value: object) {
  if (!process.send) throw new Error("Private image worker IPC is unavailable.");
  process.send(value, error => { if (error) process.exitCode = 1; });
}
let completing = false;
function finish(value: object) {
  completing = true;
  if (!process.send) throw new Error("Private image worker IPC is unavailable.");
  process.send(value, error => {
    if (error) process.exitCode = 1;
    process.disconnect();
  });
}
function rejectAnimation(bytes: Buffer, mime: string) {
  if (mime === "image/png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
      if (end > bytes.length) throw new Error("Invalid PNG chunk length.");
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") throw new Error("Animated PNG cropping is unsupported; export the exact original.");
      offset = end;
    }
  }
  if (mime === "image/webp") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size + size % 2;
      if (end > bytes.length) throw new Error("Invalid WebP chunk length.");
      const kind = bytes.toString("ascii", offset, offset + 4);
      if (kind === "ANIM" || kind === "ANMF" || kind === "VP8X" && size >= 1 && (bytes[offset + 8] & 2)) throw new Error("Animated WebP cropping is unsupported; export the exact original.");
      offset = end;
    }
  }
}
process.once("disconnect", () => { if (!completing) process.exit(1); });
let received = false;
process.on("message", async (value: unknown) => {
  if (received) { console.error("Duplicate private image worker request."); process.exit(1); }
  received = true;
  try {
    if (!isRecord(value) || !exactKeys(value, ["bytes", "mime", "rectangle"]) || typeof value.mime !== "string" || !isRectangle(value.rectangle)) throw new Error("Invalid private image worker request.");
    const bytes = base64Bytes(value.bytes), mime = rasterMime(bytes);
    if (mime !== value.mime) throw new Error("Declared image MIME does not match its raster bytes.");
    rejectAnimation(bytes, mime);
    const encoded = sizes.imageSize(bytes);
    if (!Number.isSafeInteger(encoded.width) || !Number.isSafeInteger(encoded.height) || encoded.width < 1 || encoded.height < 1) throw new Error("Image encoded dimensions are invalid.");
    send({ kind: "phase", phase: "decode", rss: process.memoryUsage().rss });
    const image = await canvas.loadImage(bytes);
    const { x, y, width, height } = value.rectangle;
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) throw new Error("Image decoded dimensions are invalid.");
    if (x > image.width - width || y > image.height - height) throw new Error("Crop rectangle exceeds the decoded image bounds; it was not clamped or scaled.");
    const surface = canvas.createCanvas(width, height), context = surface.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    send({ kind: "phase", phase: "encode", rss: process.memoryUsage().rss });
    const output = await surface.encode("png");
    const orientation = mime === "image/jpeg" && encoded.orientation !== undefined ? encoded.orientation : null;
    finish({ kind: "result", result: {
      bytes: output.toString("base64"), mime: "image/png", originalSha256: digest(bytes),
      source: { mime, encodedWidth: encoded.width, encodedHeight: encoded.height, decodedWidth: image.width, decodedHeight: image.height,
        orientation, orientationSource: orientation === null ? "not-exposed" : "jpeg-exif", orientationPolicy: mime === "image/jpeg" ? "jpeg-exif-applied" : "png-webp-metadata-unhandled", coordinateSpace: "decoded-raster-pixels",
        decoder: { name: "@napi-rs/canvas", version } },
      rectangle: value.rectangle, output: { width, height, sha256: digest(output), encoding: "png" },
    }, rss: process.memoryUsage().rss });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    finish({ kind: "error", error: { name: failure.name, message: failure.message, stack: failure.stack }, rss: process.memoryUsage().rss });
  }
});
send({ kind: "ready", pid: process.pid, node: process.versions.node, rss: process.memoryUsage().rss });
