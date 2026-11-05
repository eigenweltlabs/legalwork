export type ToolImageRectangle = { x: number; y: number; width: number; height: number };
export type ToolImageRasterRuntime = { executable: string; canvas: string; imageSize: string };
export type ToolImageCrop = {
  bytes: Uint8Array;
  mime: string;
  rectangle: ToolImageRectangle;
  signal: AbortSignal;
};
export type ToolImageCropResult = {
  bytes: Uint8Array;
  mime: "image/png";
  originalSha256: string;
  source: {
    mime: "image/png" | "image/jpeg" | "image/webp";
    encodedWidth: number;
    encodedHeight: number;
    decodedWidth: number;
    decodedHeight: number;
    orientation: number | null;
    orientationSource: "jpeg-exif" | "not-exposed";
    orientationPolicy: "jpeg-exif-applied" | "png-webp-metadata-unhandled";
    coordinateSpace: "decoded-raster-pixels";
    decoder: { name: "@napi-rs/canvas"; version: string };
  };
  rectangle: ToolImageRectangle;
  output: { width: number; height: number; sha256: string; encoding: "png" };
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isRectangle(value: unknown): value is ToolImageRectangle {
  return isRecord(value) && exactKeys(value, ["x", "y", "width", "height"])
    && [value.x, value.y, value.width, value.height].every(Number.isSafeInteger)
    && typeof value.x === "number" && value.x >= 0 && typeof value.y === "number" && value.y >= 0
    && typeof value.width === "number" && value.width > 0 && typeof value.height === "number" && value.height > 0;
}
export function base64Bytes(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("Image bytes must be canonical base64.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Image bytes must be canonical base64.");
  return bytes;
}

export function rasterMime(bytes: Uint8Array) {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (value[0] === 255 && value[1] === 216 && value[2] === 255) return "image/jpeg";
  if (value.toString("ascii", 0, 4) === "RIFF" && value.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("Cropping supports PNG, JPEG and WebP raster bytes only; export the exact original for other formats.");
}
