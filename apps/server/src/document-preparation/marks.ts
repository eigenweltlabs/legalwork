import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { DocumentBox, DocumentMark, DocumentRegion } from "@legalwork/types/document-structure";
import type { OcrPage } from "../ocr/types.js";

const MAX_SIDE = 1600;
const MAX_PIXELS = 1_600_000;
const MAX_COMPONENT_PIXELS = 100_000;
const MAX_COMPONENTS = 10_000;
const MAX_MARKS = 200;
const TIME_BUDGET_MS = 1500;

type Point = { x: number; y: number };
type Component = { pixels: number[]; left: number; top: number; right: number; bottom: number };

function chromatic(data: Uint8ClampedArray, offset: number): boolean {
  const r = data[offset], g = data[offset + 1], b = data[offset + 2];
  const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
  return data[offset + 3] >= 160 && maximum >= 100 && maximum - minimum >= 75;
}

function components(data: Uint8ClampedArray, width: number, height: number, signal: AbortSignal, deadline: number): Component[] {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if ((y & 63) === 0) { signal.throwIfAborted(); if (Date.now() > deadline) return []; }
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (chromatic(data, index * 4)) mask[index] = 1;
    }
  }
  const output: Component[] = [];
  let seen = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] !== 1) continue;
    if (++seen > MAX_COMPONENTS || Date.now() > deadline) return output;
    const queue = [index];
    mask[index] = 2;
    let left = index % width, right = left, top = Math.floor(index / width), bottom = top;
    for (let at = 0; at < queue.length; at++) {
      if ((at & 4095) === 0) { signal.throwIfAborted(); if (Date.now() > deadline) return output; }
      const current = queue[at], x = current % width, y = Math.floor(current / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] !== 1) continue;
        mask[next] = 2;
        if (queue.length < MAX_COMPONENT_PIXELS) queue.push(next);
      }
    }
    if (queue.length >= MAX_COMPONENT_PIXELS) continue;
    if (queue.length >= 30) output.push({ pixels: queue, left, right, top, bottom });
  }
  return output;
}

function normalizedBox(component: Component, width: number, height: number): DocumentMark["box"] {
  return { x: component.left / width, y: component.top / height,
    width: (component.right - component.left + 1) / width,
    height: (component.bottom - component.top + 1) / height };
}

function arrow(component: Component, width: number, height: number): { start: Point; end: Point } | undefined {
  const spanX = component.right - component.left + 1, spanY = component.bottom - component.top + 1;
  if (Math.max(spanX, spanY) < 35 || Math.max(spanX, spanY) / Math.min(spanX, spanY) < 2.5) return;
  let cx = 0, cy = 0;
  for (const index of component.pixels) { cx += index % width; cy += Math.floor(index / width); }
  cx /= component.pixels.length; cy /= component.pixels.length;
  let xx = 0, yy = 0, xy = 0;
  for (const index of component.pixels) {
    const x = index % width - cx, y = Math.floor(index / width) - cy;
    xx += x * x; yy += y * y; xy += x * y;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const ux = Math.cos(angle), uy = Math.sin(angle), vx = -uy, vy = ux;
  let min = Infinity, max = -Infinity;
  for (const index of component.pixels) {
    const projection = (index % width - cx) * ux + (Math.floor(index / width) - cy) * uy;
    min = Math.min(min, projection); max = Math.max(max, projection);
  }
  const length = max - min;
  if (length < 35) return;
  let core = 0, coreNear = 0;
  const flare = [{ positive: false, negative: false }, { positive: false, negative: false }];
  const offset = Math.max(4, Math.min(10, length * .08));
  let minTip: Point | undefined, maxTip: Point | undefined;
  let minTipDistance = Infinity, maxTipDistance = Infinity;
  for (const index of component.pixels) {
    const x = index % width, y = Math.floor(index / width);
    const along = (x - cx) * ux + (y - cy) * uy;
    const across = (x - cx) * vx + (y - cy) * vy;
    if (along > min + length * .3 && along < min + length * .65) {
      core++;
      if (Math.abs(across) <= 3.5) coreNear++;
    }
    for (const [side, nearEnd] of [[0, along < min + length * .25 && along > min + length * .03],
      [1, along > max - length * .25 && along < max - length * .03]] satisfies [number, boolean][]) {
      if (!nearEnd) continue;
      if (across > offset) flare[side].positive = true;
      if (across < -offset) flare[side].negative = true;
    }
    const fromMin = along - min + Math.abs(across) * .15;
    if (fromMin < minTipDistance) { minTipDistance = fromMin; minTip = { x, y }; }
    const fromMax = max - along + Math.abs(across) * .15;
    if (fromMax < maxTipDistance) { maxTipDistance = fromMax; maxTip = { x, y }; }
  }
  if (core < 20 || coreNear / core < .75 || !minTip || !maxTip) return;
  const atMin = flare[0].positive && flare[0].negative;
  const atMax = flare[1].positive && flare[1].negative;
  if (atMin === atMax) return;
  const tail = atMax ? minTip : maxTip, tip = atMax ? maxTip : minTip;
  return { start: { x: tail.x / width, y: tail.y / height }, end: { x: tip.x / width, y: tip.y / height } };
}

type OcrLine = { text: string; box: DocumentBox };
const textKinds = new Set<DocumentRegion["kind"]>(["text", "list", "heading", "note", "footnote"]);
function textRegion(region: DocumentRegion): boolean {
  return textKinds.has(region.kind) && Boolean(region.text.trim()) && region.writing !== "handwritten";
}
function overlapArea(inner: DocumentBox, outer: DocumentBox): number {
  return Math.max(0, Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x))
    * Math.max(0, Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y));
}
function strikeout(component: Component, regions: DocumentRegion[], ocrLines: readonly OcrLine[] | undefined, width: number, height: number): boolean {
  const spanX = component.right - component.left + 1, spanY = component.bottom - component.top + 1;
  if (spanX < 35 || spanX / spanY < 4 || spanY > 24) return false;
  const centerY = (component.top + component.bottom) / 2;
  const lines = ocrLines?.length ? ocrLines : regions.filter(textRegion).map(region => ({ text: region.text, box: region.box }));
  const matches = lines.filter(line => {
    if (!line.text.trim() || !Number.isFinite(line.box.x) || !Number.isFinite(line.box.y)
      || !Number.isFinite(line.box.width) || !Number.isFinite(line.box.height)
      || line.box.width <= 0 || line.box.height <= 0) return false;
    const left = line.box.x * width, top = line.box.y * height;
    const right = (line.box.x + line.box.width) * width, bottom = (line.box.y + line.box.height) * height;
    const overlap = Math.max(0, Math.min(component.right, right) - Math.max(component.left, left));
    return overlap >= Math.max(30, (right - left) * .55) && centerY >= top + (bottom - top) * .32
      && centerY <= top + (bottom - top) * .68 && spanY <= (bottom - top) * .55;
  });
  if (matches.length !== 1) return false;
  const line = matches[0];
  return regions.filter(region => textRegion(region) && overlapArea(line.box, region.box) >= line.box.width * line.box.height * .6).length === 1;
}

/** Finds only conspicuous colored page marks; returned scores describe geometric clarity, not legal meaning. */
export async function detectDocumentMarks(page: OcrPage, regions: DocumentRegion[], signal: AbortSignal, ocrLines?: readonly OcrLine[]): Promise<DocumentMark[]> {
  signal.throwIfAborted();
  if (page.width <= 0 || page.height <= 0 || page.width * page.height > 40_000_000 || page.data.byteLength > 20 * 1024 * 1024) return [];
  const scale = Math.min(1, MAX_SIDE / Math.max(page.width, page.height), Math.sqrt(MAX_PIXELS / (page.width * page.height)));
  const width = Math.max(1, Math.round(page.width * scale)), height = Math.max(1, Math.round(page.height * scale));
  const deadline = Date.now() + TIME_BUDGET_MS;
  let image: Awaited<ReturnType<typeof loadImage>>;
  try { image = await loadImage(Buffer.from(page.data)); }
  catch { signal.throwIfAborted(); return []; }
  signal.throwIfAborted();
  if (Date.now() > deadline || image.width !== page.width || image.height !== page.height) return [];
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const found: DocumentMark[] = [];
  const boundedRegions = regions.slice(0, 2000);
  const boundedLines = ocrLines?.slice(0, 2000);
  for (const component of components(data, width, height, signal, deadline)) {
    signal.throwIfAborted();
    if (Date.now() > deadline || found.length >= MAX_MARKS) break;
    const box = normalizedBox(component, width, height);
    const direction = arrow(component, width, height);
    if (direction) found.push({ id: `colored-arrow-${found.length + 1}`, kind: "arrow", box, ...direction, confidence: .7 });
    else if (strikeout(component, boundedRegions, boundedLines, width, height)) found.push({ id: `colored-strikeout-${found.length + 1}`, kind: "strikeout", box, confidence: .7 });
  }
  return found;
}
