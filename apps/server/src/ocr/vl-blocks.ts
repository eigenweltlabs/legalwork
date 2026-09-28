// PaddleOCR-VL block pipeline, ported from PaddleX (Apache-2.0): paddlex/inference/pipelines/paddleocr_vl/
// pipeline.py and uilts.py. Defaults, except use_ocr_for_image_block=True. The model itself runs elsewhere:
// every crop is read in one call to `read`. Boxes are [x0, y0, x1, y1] pixels.
import { createCanvas, GlobalFonts, ImageData, loadImage } from "@napi-rs/canvas";
import { imageSize } from "image-size";
import polygonClipping from "polygon-clipping";
import { pdfAsset } from "../document-preparation/pdf-assets.js";
import type { OcrContent, OcrPage } from "./types.js";
import { area, boxArea, boxOverlap, fillPolygon, layoutPolygons, polygonArea, polygonOverlap, rectangle, roundHalfEven, type Box, type Point } from "./vl-outlines.js";

/** One model call: a PNG crop at the model's input size, Paddle's task prompt and the output token limit. */
export type VlRequest = { image: Uint8Array; prompt: "OCR:" | "Table Recognition:" | "Formula Recognition:"; limit: number };
/** The model's raw answer; cut when it ran into the token limit. */
export type VlAnswer = { text: string; cut: boolean };
type NormalizedBox = { x: number; y: number; width: number; height: number };

const IMAGE_LABELS = ["chart", "seal"]; // Not recognized: chart and seal recognition are off.
const FIGURE_LABELS = ["image", "seal"]; // Pictures replaced by tokens inside tables.
const OTSL_TAGS = ["<nl>", "<fcel>", "<ecel>", "<lcel>", "<ucel>", "<xcel>"];

/** RGBA pixels, always opaque. */
export type Picture = { width: number; height: number; data: Uint8ClampedArray };
type Block = { index: number; label: string; confidence: number; px: Box; polygon: Point[]; picture?: Picture };

export async function readBlocks(page: OcrPage & { blocks: NonNullable<OcrPage["blocks"]> }, lines: NormalizedBox[],
  read: (requests: VlRequest[]) => Promise<VlAnswer[]>): Promise<OcrContent> {
  const image = await decode(page), { width, height } = image;
  const pixels = (box: NormalizedBox): Box => [roundHalfEven(box.x * width), roundHalfEven(box.y * height),
    roundHalfEven((box.x + box.width) * width), roundHalfEven((box.y + box.height) * height)];
  const normalized = ([x0, y0, x1, y1]: Box) => ({ x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height });
  const boxes = page.blocks.map(block => pixels(block.box));
  const outlines = layoutPolygons(page.blocks.map(({ mask }, index) => ({ px: boxes[index]!, mask })), width, height);
  const blocks = page.blocks.map(({ label, confidence }, index): Block => ({ index, label, confidence: confidence ?? 1, px: boxes[index]!, polygon: outlines[index]! }));
  const figures = blocks.filter(block => FIGURE_LABELS.includes(block.label))
    .map(({ index, px: [x0, y0, x1, y1] }): [number, Box] => [index, [clamp(x0, width), clamp(y0, height), clamp(x1, width), clamp(y1, height)]]);
  const lineBoxes = lines.map(pixels).filter(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0);

  // A quarter suffices: detected lines can span a column gap, so only part of them lies in the block.
  const hasText = (outline: Point[]) => lineBoxes.some(line =>
    area(polygonClipping.intersection([outline], [rectangle(line)])) >= 0.25 * Math.min(boxArea(line), polygonArea(outline)));
  // Not in PaddleOCR-VL: the model cannot answer "nothing here" and invents text for scan noise.
  // A block the layout model is unsure about is only read when the line detector found text in it.
  const kept = filterOverlapBoxes(blocks).filter(block => block.confidence >= 0.5 || hasText(block.polygon))
    .map(block => ({ ...block, picture: cropBlock(image, block) }));
  const tasks: { block: Block; inside: Map<number, string | undefined> }[] = [], requests: Promise<VlRequest>[] = [];
  for (const block of mergeBlocks(kept)) {
    if (IMAGE_LABELS.includes(block.label)) continue;
    let picture = block.picture!, prompt: VlRequest["prompt"] = "OCR:", inside = new Map<number, string | undefined>();
    if (block.label === "table") {
      prompt = "Table Recognition:";
      ({ picture, inside } = tokenizeFigureOfTable(picture, block.px, figures));
    } else if (block.label.includes("formula") && block.label !== "formula_number") {
      prompt = "Formula Recognition:";
      const trimmed = cropMargin(picture);
      if (trimmed.width > 2 && trimmed.height > 2) picture = trimmed;
    }
    tasks.push({ block, inside });
    requests.push(encode(modelInput(picture)).then(data => ({ image: data, prompt, limit: 4096 })));
  }
  // Not in PaddleOCR-VL: detected text lines outside every layout block are read one by one,
  // so text the layout model missed is kept instead of silently dropped.
  // A line counts as read when most of it lies inside blocks; detected lines can span a column gap.
  const covered = polygonClipping.union([], ...outlines.map(outline => [outline]));
  const missed = [...lineBoxes].sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .filter(line => area(polygonClipping.intersection(covered, [rectangle(line)])) < 0.5 * boxArea(line));
  // One line never needs a long answer. A line read that runs into the limit is scan noise the
  // detector mistook for text: it is dropped without flagging the page, as the layout never saw it.
  for (const line of missed) requests.push(encode(modelInput(crop(image, line))).then(data => ({ image: data, prompt: "OCR:", limit: 512 })));

  // A page without layout blocks or detected lines needs no model call.
  const answers = requests.length ? await read(await Promise.all(requests)) : [];
  // Not in PaddleOCR-VL: output that runs into the limit is a loop or invented text. Paddle trims it
  // and keeps the start; we drop it and report truncation, so the page is flagged for review.
  const truncated = answers.slice(0, tasks.length).some(answer => answer.cut);
  const results = tasks.map(({ block, inside }, i) => {
    const answer = answers[i]!;
    let text = truncateRepetitiveContent(answer.cut ? "" : answer.text.trim(), block.label === "table" ? 5000 : 50);
    if ((text.includes("\\(") && text.includes("\\)")) || (text.includes("\\[") && text.includes("\\]"))) {
      // Functions keep "$$" literal; in a replacement string it means "$".
      text = text.replaceAll("$", "").replaceAll("\\(", " $ ").replaceAll("\\)", " $").replaceAll("\\[\\[", "\\[")
        .replaceAll("\\]\\]", "\\]").replaceAll("\\[", () => " $$ ").replaceAll("\\]", () => " $$ ");
      if (block.label === "formula_number") text = text.replaceAll("$", "");
    }
    return { block, text, inside };
  });
  // Pictures inside a table become part of it (untokenize_figure_of_table): "[image]" plus their text.
  const texts = new Map(results.map(({ block, text }) => [block.index, text]));
  const insideTables = new Set(results.flatMap(({ inside }) => [...inside.keys()]));
  const regions: OcrContent["regions"] = [];
  for (const { block, text, inside } of results) {
    if (insideTables.has(block.index)) continue;
    const region: OcrContent["regions"][number] = { text, box: normalized(block.px) };
    if (block.label === "table") {
      const pictures = new Map([...inside].flatMap(([index, token]) => token ? [[token, ["[image]", texts.get(index)].filter(Boolean).join(" ")]] : []));
      const fill = (value: string) => value.replace(/\[F\d+\]/g, match => pictures.get(match) ?? match);
      const { rows, columns, cells } = parseOtsl(text);
      const filled = cells.map(cell => ({ ...cell, text: fill(cell.text) }));
      region.text = filled.length ? tableText(rows, filled) : fill(text);
      if (filled.length) region.table = { rows, columns, cells: filled };
    }
    if (region.text) regions.push(region);
  }
  missed.forEach((line, i) => {
    const answer = answers[tasks.length + i]!, text = truncateRepetitiveContent(answer.cut ? "" : answer.text.trim(), 50);
    if (text) regions.push({ text, box: normalized(line) });
  });
  return { text: regions.map(region => region.text).join("\n"), regions, truncated };
}

const clamp = (value: number, limit: number) => Math.max(0, Math.min(value, limit));

/** The whole page as one model input, for pages without layout blocks. */
export async function pageInput(page: OcrPage) {
  return encode(modelInput(await decode(page)));
}

/** PaddleOCR-VL's image processor: smart_resize to multiples of 28 pixels within 112,896 to 1,003,520 pixels, then
 * PIL's bicubic resampling. Crops leave at that size, so the model runtime does not resample them its own way. */
export function modelInput(source: Picture): Picture {
  // Not in PaddleOCR-VL: its processor rejects aspect ratios above 200, so thin crops are padded with white.
  const paddedWidth = Math.max(source.width, Math.floor(source.height / 100) + 1), paddedHeight = Math.max(source.height, Math.floor(source.width / 100) + 1);
  let picture = source;
  if (paddedWidth !== source.width || paddedHeight !== source.height) {
    const data = new Uint8ClampedArray(paddedWidth * paddedHeight * 4).fill(255), left = Math.floor((paddedWidth - source.width) / 2), top = Math.floor((paddedHeight - source.height) / 2);
    for (let y = 0; y < source.height; y++) data.set(source.data.subarray(y * source.width * 4, (y + 1) * source.width * 4), ((top + y) * paddedWidth + left) * 4);
    picture = { width: paddedWidth, height: paddedHeight, data };
  }
  const factor = 28, minPixels = 112896, maxPixels = 1003520;
  let { width, height } = picture;
  if (height < factor) { width = roundHalfEven(width * factor / height); height = factor; }
  if (width < factor) { height = roundHalfEven(height * factor / width); width = factor; }
  let h = roundHalfEven(height / factor) * factor, w = roundHalfEven(width / factor) * factor;
  if (h * w > maxPixels) {
    const beta = Math.sqrt(height * width / maxPixels);
    [h, w] = [Math.floor(height / beta / factor) * factor, Math.floor(width / beta / factor) * factor];
  } else if (h * w < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    [h, w] = [Math.ceil(height * beta / factor) * factor, Math.ceil(width * beta / factor) * factor];
  }
  return resizeBicubic(picture, w, h);
}

/** PIL's Image.resize(BICUBIC) for RGB: a horizontal, then a vertical pass with 22-bit fixed-point weights. */
function resizeBicubic(picture: Picture, width: number, height: number): Picture {
  const cubic = (value: number) => {
    const x = Math.abs(value);
    return x < 1 ? (1.5 * x - 2.5) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * -0.5 : 0;
  };
  const coefficients = (input: number, output: number) => {
    const scale = input / output, filterScale = Math.max(scale, 1), support = 2 * filterScale, reciprocal = 1 / filterScale;
    return Array.from({ length: output }, (_, index) => {
      const center = (index + 0.5) * scale, first = Math.max(Math.trunc(center - support + 0.5), 0);
      const count = Math.min(Math.trunc(center + support + 0.5), input) - first;
      const weights = Array.from({ length: count }, (_, x) => cubic((x + first - center + 0.5) * reciprocal));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      return { first, weights: weights.map(weight => {
        const fixed = (total !== 0 ? weight / total : weight) * (1 << 22);
        return Math.trunc(fixed < 0 ? fixed - 0.5 : fixed + 0.5);
      }) };
    });
  };
  const clip = (value: number) => value >= 2 ** 30 ? 255 : value <= 0 ? 0 : Math.floor(value / 2 ** 22);
  // One pass resamples along rows (neighbours 4 bytes apart) or along columns (one row apart).
  const pass = (source: Picture, width: number, height: number, horizontal: boolean): Picture => {
    const taps = coefficients(horizontal ? source.width : source.height, horizontal ? width : height);
    const data = new Uint8ClampedArray(width * height * 4), step = horizontal ? 4 : source.width * 4;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const { first, weights } = taps[horizontal ? x : y]!, target = (y * width + x) * 4;
      const base = horizontal ? (y * source.width + first) * 4 : (first * source.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let sum = 2 ** 21;
        for (let k = 0, offset = base + channel; k < weights.length; k++, offset += step) sum += source.data[offset]! * weights[k]!;
        data[target + channel] = clip(sum);
      }
      data[target + 3] = 255;
    }
    return { width, height, data };
  };
  let current = picture;
  if (width !== current.width) current = pass(current, width, current.height, true);
  if (height !== current.height) current = pass(current, width, height, false);
  return current;
}

async function decode(page: OcrPage): Promise<Picture> {
  const bytes = Buffer.from(page.data), size = imageSize(bytes);
  if (size.width !== page.width || size.height !== page.height) throw new Error("Invalid image dimensions");
  const source = await loadImage(bytes);
  if (source.width !== page.width || source.height !== page.height) throw new Error("Invalid image dimensions");
  const canvas = createCanvas(source.width, source.height), context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, source.width, source.height);
  context.drawImage(source, 0, 0);
  return { width: source.width, height: source.height, data: context.getImageData(0, 0, source.width, source.height).data };
}

async function encode({ width, height, data }: Picture) {
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(data, width, height), 0, 0);
  return new Uint8Array(await canvas.encode("png"));
}

function crop(picture: Picture, [x0, y0, x1, y1]: Box): Picture {
  const width = x1 - x0, height = y1 - y0, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) data.set(picture.data.subarray(((y0 + y) * picture.width + x0) * 4, ((y0 + y) * picture.width + x1) * 4), y * width * 4);
  return { width, height, data };
}

/** CropByBoxes: crop the box and whiten everything outside the block's outline. */
function cropBlock(image: Picture, block: Block) {
  const [x0, y0] = block.px, picture = crop(image, block.px), mask = new Uint8Array(picture.width * picture.height);
  fillPolygon(mask, picture.width, picture.height, block.polygon.map(([x, y]): Point => [Math.trunc(x) - x0, Math.trunc(y) - y0]));
  mask.forEach((inside, i) => { if (!inside) picture.data.fill(255, i * 4, i * 4 + 3); });
  return picture;
}

function filterOverlapBoxes(all: Block[]) {
  const blocks = all.filter(block => block.label !== "reference"), dropped = new Set<number>();
  blocks.forEach((first, i) => {
    const a = first.px;
    if (a[2] - a[0] < 6 || a[3] - a[1] < 6) dropped.add(i);
    for (let j = i + 1; j < blocks.length; j++) {
      if (dropped.has(i) || dropped.has(j)) continue;
      const second = blocks[j]!, ratio = boxOverlap(a, second.px, "small");
      if (first.label === "inline_formula" || second.label === "inline_formula") {
        if (ratio > 0.5) {
          if (first.label === "inline_formula") dropped.add(i);
          if (second.label === "inline_formula") dropped.add(j);
          continue;
        }
      }
      if (ratio <= 0.7 || polygonOverlap(first.polygon, second.polygon, "small") < 0.7) continue;
      const labels = new Set([first.label, second.label]), visual = ["image", "table", "seal", "chart"];
      if (labels.size > 1 && [...labels].some(label => visual.includes(label))
        && (!labels.has("table") || [...labels].every(label => visual.includes(label)))) continue;
      dropped.add(boxArea(a) >= boxArea(second.px) ? j : i);
    }
  });
  return blocks.filter((_, index) => !dropped.has(index));
}

function mergePictures(pictures: Picture[], aligns: string[]): Picture {
  const offsets = pictures.map(() => 0);
  let width = pictures[0]!.width;
  for (let i = 1; i < pictures.length; i++) {
    const step = Math.max(width, pictures[i]!.width), own = pictures[i]!.width;
    const [shift, offset] = aligns[i - 1] === "center" ? [Math.floor((step - width) / 2), Math.floor((step - own) / 2)]
      : aligns[i - 1] === "right" ? [step - width, step - own] : [0, 0];
    for (let j = 0; j < i; j++) offsets[j]! += shift;
    offsets[i] = offset;
    width = step;
  }
  const height = pictures.reduce((sum, picture) => sum + picture.height, 0), data = new Uint8ClampedArray(width * height * 4).fill(255);
  let top = 0;
  pictures.forEach((picture, i) => {
    for (let y = 0; y < picture.height; y++) data.set(picture.data.subarray(y * picture.width * 4, (y + 1) * picture.width * 4), ((top + y) * width + offsets[i]!) * 4);
    top += picture.height;
  });
  return { width, height, data };
}

/** Stitch cross-column or wrapped text blocks into one image. Merged blocks keep their union box. */
function mergeBlocks(blocks: Block[]) {
  const fixed = new Map(blocks.flatMap((block, index) => [...IMAGE_LABELS, "table"].includes(block.label) ? [[index, block] as const] : []));
  const movable = blocks.flatMap((block, index) => fixed.has(index) ? [] : [[index, block] as const]);
  const aligned = (a: number, b: number) => Math.abs(a - b) <= 5;
  const touchesFixed = (index: number, previous: number) => {
    const a = blocks[previous]!.px, b = blocks[index]!.px, union: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
    return [...fixed].some(([key, other]) => key !== index && key !== previous && boxOverlap(union, other.px) > 0);
  };
  const groups: [number[], string[]][] = [];
  let group: number[] = [], aligns: string[] = [];
  movable.forEach(([index, block], position) => {
    if (!group.length) { group = [index]; aligns = []; return; }
    const [previous, before] = movable[position - 1]!, a = before.px, b = block.px;
    const shared = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const horizontal = shared > 0 ? shared / (Math.max(a[2], b[2]) - Math.min(a[0], b[0])) : 0;
    const texts = block.label === "text" && before.label === "text";
    const cross = horizontal === 0 && texts && b[0] > a[2] && b[1] < a[3] && b[0] - a[2] < Math.max(a[2] - a[0], b[2] - b[0]) * 0.3;
    const updown = horizontal > 0 && texts && b[3] >= a[1] && Math.abs(b[1] - a[3]) < Math.max(a[3] - a[1], b[3] - b[1]) * 0.5
      && aligned(b[0], a[0]) !== aligned(b[2], a[2]) && touchesFixed(index, previous);
    if (cross || updown) {
      group.push(index);
      aligns.push(cross ? "center" : aligned(b[0], a[0]) ? "left" : aligned(b[2], a[2]) ? "right" : "center");
    } else {
      groups.push([group, aligns]);
      [group, aligns] = [[index], []];
    }
  });
  if (group.length) groups.push([group, aligns]);

  const starts = new Map(groups.map(entry => [entry[0][0]!, entry])), merged: Block[] = [], used = new Set<number>();
  let index = 0;
  while (index < blocks.length) {
    const start = starts.get(index);
    if (start && !start[0].some(member => used.has(member))) {
      const [members, directions] = start, pictures = members.map(member => blocks[member]!.picture!);
      if (members.length === 1 || pictures.reduce((sum, picture) => sum + picture.height, 0) / Math.max(...pictures.map(picture => picture.width)) >= 3) {
        merged.push(...members.map(member => blocks[member]!));
      } else {
        const boxes = members.map(member => blocks[member]!.px);
        merged.push({ ...blocks[members[0]!]!, picture: mergePictures(pictures, directions),
          px: [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])), Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))] });
      }
      members.forEach(member => used.add(member));
      for (let i = members[0]! + 1; i < members.at(-1)!; i++) {
        if (!fixed.has(i)) continue;
        merged.push(fixed.get(i)!);
        used.add(i);
      }
      index = members.at(-1)! + 1;
      continue;
    }
    if (fixed.has(index) && !used.has(index)) {
      merged.push(fixed.get(index)!);
      used.add(index);
    }
    index++;
  }
  return merged;
}

/** Python string lengths count code points. */
export function truncateRepetitiveContent(content: string, minCount: number) {
  const stripped = content.trim(), chars = [...stripped];
  if ([...content].length < minCount || !stripped) return content;
  if (!stripped.includes("\n") && chars.length > 100) {
    for (let size = Math.floor(chars.length / 5); size > 7; size--) {
      const unit = chars.slice(-size).join("");
      if (!stripped.endsWith(unit.repeat(5))) continue;
      let rest = stripped, count = 0;
      while (rest.endsWith(unit)) { rest = rest.slice(0, -unit.length); count++; }
      if (size * count > chars.length * 0.5) return rest;
      break;
    }
  }
  if (!stripped.includes("\n") && chars.length > 10) {
    for (let size = 1; size <= Math.floor(chars.length / 2); size++) {
      if (chars.length % size !== 0 || chars.slice(0, size).join("").repeat(chars.length / size) !== stripped) continue;
      if (chars.length / size >= 10) return chars.slice(0, size).join("");
      break;
    }
  }
  const lines = content.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length >= 10) {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    const [line, count] = [...counts].reduce((best, entry) => entry[1] > best[1] ? entry : best);
    if (count >= 10 && count / lines.length >= 0.8) return line;
  }
  return content;
}

function cropMargin(picture: Picture) {
  // PIL's convert("L").
  const gray = new Int32Array(picture.width * picture.height).map((_, i) =>
    (picture.data[i * 4]! * 19595 + picture.data[i * 4 + 1]! * 38470 + picture.data[i * 4 + 2]! * 7471 + 0x8000) >> 16);
  const low = gray.reduce((a, b) => Math.min(a, b)), high = gray.reduce((a, b) => Math.max(a, b));
  if (low === high) return picture;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
  gray.forEach((value, i) => {
    if (Math.floor((value - low) * 255 / (high - low)) > 200) return;
    const x = i % picture.width, y = Math.floor(i / picture.width);
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  });
  return x1 < 0 ? picture : crop(picture, [x0, y0, x1 + 1, y1 + 1]);
}

let tokenFont: string | undefined;
/** PaddleX draws the token with OpenCV's Hershey font; we draw Liberation Sans Bold, which ships with PDF.js. */
function paintToken(picture: Picture, [x0, y0, x1, y1]: Box, token: string) {
  tokenFont ??= GlobalFonts.register(Buffer.from(pdfAsset("standard_fonts/LiberationSans-Bold.ttf")), "LegalWork Token") ? "LegalWork Token" : "sans-serif";
  const canvas = createCanvas(picture.width, picture.height), context = canvas.getContext("2d");
  context.putImageData(new ImageData(picture.data, picture.width, picture.height), 0, 0);
  context.fillStyle = "white";
  context.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const side = Math.min(x1 - x0, y1 - y0), measure = (size: number) => {
    context.font = `${size}px "${tokenFont}"`;
    const metrics = context.measureText(token);
    return { width: metrics.width, height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent, ascent: metrics.actualBoundingBoxAscent };
  };
  let low = 1, high = 400, size = 1;
  while (high - low > 0.1) {
    const middle = (low + high) / 2, { width, height } = measure(middle);
    if (width < side * 0.9 && height < side * 0.9) size = low = middle;
    else high = middle;
  }
  const { width, ascent } = measure(size);
  context.fillStyle = "black";
  context.fillText(token, x0 + (x1 - x0 - width) / 2, y0 + (y1 - y0 + ascent) / 2);
  return { ...picture, data: context.getImageData(0, 0, picture.width, picture.height).data };
}

/** Python's random.Random(seed).shuffle (Mersenne Twister), which PaddleX uses to number the tokens. */
function pythonShuffle<T>(items: T[], seed: number) {
  const mt = new Uint32Array(624), mix = (i: number) => mt[i - 1]! ^ (mt[i - 1]! >>> 30);
  mt[0] = 19650218;
  for (let i = 1; i < 624; i++) mt[i] = Math.imul(1812433253, mix(i)) + i;
  let i = 1;
  for (let k = 0; k < 624; k++) {
    mt[i] = (mt[i]! ^ Math.imul(mix(i), 1664525)) + seed;
    if (++i >= 624) { mt[0] = mt[623]!; i = 1; }
  }
  for (let k = 0; k < 623; k++) {
    mt[i] = (mt[i]! ^ Math.imul(mix(i), 1566083941)) - i;
    if (++i >= 624) { mt[0] = mt[623]!; i = 1; }
  }
  mt[0] = 0x80000000;
  let index = 624;
  const next = () => {
    if (index >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      index = 0;
    }
    let y = mt[index++]!;
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  };
  for (let k = items.length - 1; k > 0; k--) {
    const bits = (k + 1).toString(2).length;
    let j: number;
    do j = next() >>> (32 - bits); while (j > k);
    [items[k], items[j]] = [items[j]!, items[k]!];
  }
  return items;
}

/** Replace figures inside a table with [F..] tokens so table recognition does not read them.
 * Returns the figures inside the table by index; figures too small to tokenize have no token. */
function tokenizeFigureOfTable(table: Picture, tableBox: Box, figures: [number, Box][]) {
  const numbers: number[] = [];
  for (let candidate = 0; numbers.length < figures.length; candidate++) if (!/[019]/.test(String(candidate))) numbers.push(candidate);
  pythonShuffle(numbers, 1024);
  let picture = table;
  const inside = new Map<number, string | undefined>();
  figures.forEach(([index, figure], i) => {
    if (figure[0] < tableBox[0] || figure[1] < tableBox[1] || figure[2] > tableBox[2] || figure[3] > tableBox[3]) return;
    inside.set(index, undefined);
    if (Math.min(figure[2] - figure[0], figure[3] - figure[1]) < 25) return;
    const token = `[F${numbers[i]}]`;
    inside.set(index, token);
    picture = paintToken(picture, [figure[0] - tableBox[0], figure[1] - tableBox[1], figure[2] - tableBox[0], figure[3] - tableBox[1]], token);
  });
  return { picture, inside };
}

const tagPattern = "<fcel>|<ecel>|<nl>|<lcel>|<ucel>|<xcel>";

/** OTSL table tokens to cells with spans (otsl_pad_to_sqr_v2 and otsl_parse_texts). */
export function parseOtsl(input: string) {
  let content = input.trim();
  if (!content.includes("<nl>")) content += "<nl>";
  else {
    // Python's "$" also matches before a final newline.
    const found = content.split("<nl>").flatMap(line => {
      const cells = line.match(new RegExp(`(?:${tagPattern}).*?(?=(?:${tagPattern})|\\n?$)`, "gs")) ?? [];
      return cells.length ? [{ cells, minimum: Math.max(0, ...cells.flatMap((cell, i) => cell.startsWith("<fcel>") ? [i + 1] : [])) }] : [];
    });
    if (found.length) {
      const low = Math.max(...found.map(line => line.minimum)), high = Math.max(low, ...found.map(line => line.cells.length));
      let width = low, best = Infinity;
      for (let size = low; size <= high; size++) {
        const cost = found.reduce((sum, line) => sum + Math.abs(line.cells.length - size), 0);
        if (cost < best) { best = cost; width = size; }
      }
      content = found.map(line => [...line.cells, ...Array<string>(width).fill("<ecel>")].slice(0, width).join("")).join("<nl>") + "<nl>";
    } else content = "<nl>";
  }
  const tokens = content.match(new RegExp(tagPattern, "g")) ?? [];
  let texts = content.split(new RegExp(`(${tagPattern})`)).filter(part => part.trim());
  const rows: string[][] = [];
  let run: string[] = [];
  for (const token of tokens) {
    if (token !== "<nl>") { run.push(token); continue; }
    if (run.length) rows.push(run);
    run = [];
  }
  if (run.length) rows.push(run);
  if (rows.length) {
    const columns = Math.max(...rows.map(row => row.length)), rebuilt: string[] = [];
    let position = 0;
    for (const row of rows) {
      while (row.length < columns) row.push("<ecel>");
      for (const token of row) {
        rebuilt.push(token);
        if (texts[position] !== token) continue;
        position++;
        if (position < texts.length && !OTSL_TAGS.includes(texts[position]!)) rebuilt.push(texts[position++]!);
      }
      rebuilt.push("<nl>");
      if (texts[position] === "<nl>") position++;
    }
    texts = rebuilt;
  }
  const span = (r: number, c: number, dr: number, dc: number, allowed: string[]) => {
    let count = 0;
    while (allowed.includes(rows[r]![c]!)) {
      r += dr; c += dc; count++;
      if (r >= rows.length || c >= rows[r]!.length) break;
    }
    return count;
  };
  const cells: { row: number; column: number; rowSpan: number; columnSpan: number; text: string }[] = [];
  let r = 0, c = 0;
  texts.forEach((text, i) => {
    if (text === "<fcel>" || text === "<ecel>") {
      // A <fcel> directly followed by a tag has no text (PaddleX would store the tag).
      const filled = text === "<fcel>" && !OTSL_TAGS.includes(texts[i + 1]!);
      const right = texts[i + (filled ? 2 : 1)] ?? "", below = rows[r + 1]?.[c] ?? "";
      cells.push({
        row: r, column: c,
        rowSpan: 1 + (below === "<ucel>" || below === "<xcel>" ? span(r + 1, c, 1, 0, ["<ucel>", "<xcel>"]) : 0),
        columnSpan: 1 + (right === "<lcel>" || right === "<xcel>" ? span(r, c + 1, 0, 1, ["<lcel>", "<xcel>"]) : 0),
        text: filled ? texts[i + 1]!.trim() : "",
      });
    }
    if (OTSL_TAGS.slice(1).includes(text)) c++;
    if (text === "<nl>") { r++; c = 0; }
  });
  return { rows: rows.length, columns: Math.max(0, ...rows.map(row => row.length)), cells };
}

/** Plain rows for evidence text, so quotes match without HTML markup or escaping. */
function tableText(rows: number, cells: { row: number; column: number; text: string }[]) {
  const ordered = [...cells].sort((a, b) => a.row - b.row || a.column - b.column);
  return Array.from({ length: rows }, (_, row) => ordered.filter(cell => cell.row === row).map(cell => cell.text).join(" | "))
    .filter(line => line.replace(/^[ |]+|[ |]+$/g, "")).join("\n");
}
