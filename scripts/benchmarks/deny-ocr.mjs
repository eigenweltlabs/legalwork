// Controller-only full-screenshot recognition. Neither pass crops or masks a
// spatial region, and no permission response enters the agent context.
import { visibleDenyTarget } from "./permission-policy.mjs";

export const DENY_IMAGE_PREPROCESS = String.raw`from PIL import Image,ImageOps,ImageChops;import PIL,json,sys
source,target,method=sys.argv[1:];original=Image.open(source)
if method=='grayscale':image=original.convert('L')
elif method=='red-ink':
 red,green,blue=original.convert('RGB').split();rg=ImageChops.subtract(red,green).point(lambda value:255 if value>40 else 0,mode='1');rb=ImageChops.subtract(red,blue).point(lambda value:255 if value>40 else 0,mode='1');image=ImageOps.invert(ImageChops.logical_and(rg,rb).convert('L'))
else:raise RuntimeError('Unreviewed OCR transformation')
ImageOps.autocontrast(image).resize((image.width*4,image.height*4),Image.Resampling.LANCZOS).save(target);print(json.dumps({'pillow':PIL.__version__,'method':method,'scale':4,'fullImage':True,'width':original.width,'height':original.height,'redInkRule':'R-G>40 and R-B>40, black; otherwise white'if method=='red-ink'else None}))`;

function samePhysicalLabel(left, right) {
  const overlapWidth = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const overlapHeight = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  const intersection = overlapWidth * overlapHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return intersection > 0 && intersection / union >= 0.8 && Math.abs(left.left - right.left) <= 2 && Math.abs(left.top - right.top) <= 2
    && Math.abs(left.width - right.width) <= 3 && Math.abs(left.height - right.height) <= 3;
}

/** Retain every pass and candidate. Only near-identical physical rectangles
 * across different passes may merge; distinct buttons always remain ambiguous. */
export function combinedDenyTarget(passes, { minimumConfidence, width, height, scale = 4 }) {
  if (!Array.isArray(passes) || passes.length !== 2 || scale !== 4 || !(minimumConfidence >= 0 && minimumConfidence <= 100)
    || ![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error("Explicit screenshot/OCR settings required");
  const groups = [], observations = [], methods = new Set();
  for (const [passIndex, pass] of passes.entries()) {
    if (!["grayscale", "red-ink"].includes(pass.method) || methods.has(pass.method) || pass.crop !== undefined || typeof pass.tsv !== "string") throw new Error("Invalid full-image OCR pass");
    methods.add(pass.method);
    const lines = pass.tsv.split(/\r?\n/);
    while (lines.at(-1) === "") lines.pop();
    const headers = (lines.shift() ?? "").split("\t");
    if (!["level", "left", "top", "width", "height", "conf", "text"].every(key => headers.includes(key)) || new Set(headers).size !== headers.length) throw new Error("Malformed OCR header");
    const candidates = [];
    for (const line of lines) {
      const cells = line.split("\t");
      if (cells.length !== headers.length) throw new Error("Malformed OCR row");
      const row = Object.fromEntries(headers.map((key, index) => [key, cells[index]]));
      if (row.text.trim() !== "Deny") continue;
      const values = [row.left, row.top, row.width, row.height, row.conf].map(Number);
      if (row.level !== "5" || values.some(value => !Number.isFinite(value)) || values[0] < 0 || values[1] < 0
        || values[2] <= 0 || values[3] <= 0 || values[4] < 0 || values[4] > 100
        || values[0] + values[2] > width * scale || values[1] + values[3] > height * scale) throw new Error("Malformed/offscreen OCR Deny candidate");
      const candidate = { passIndex, method: pass.method, left: values[0] / scale, top: values[1] / scale,
        width: values[2] / scale, height: values[3] / scale, confidence: values[4] };
      candidates.push(candidate);
      const matches = groups.filter(group => group.every(other => other.passIndex !== passIndex && samePhysicalLabel(candidate, other)));
      if (matches.length > 1) throw new Error("Ambiguous OCR rectangle grouping");
      if (matches.length) matches[0].push(candidate); else groups.push([candidate]);
    }
    observations.push({ passIndex, method: pass.method, fullImage: true, candidates });
  }
  const representatives = groups.map(group => [...group].sort((left, right) => right.confidence - left.confidence)[0]);
  const merged = ["level\tleft\ttop\twidth\theight\tconf\ttext", ...representatives.map(row =>
    [5, row.left, row.top, row.width, row.height, row.confidence, "Deny"].join("\t"))].join("\n");
  let target;
  try { target = visibleDenyTarget(merged, { minimumConfidence, width, height, scale: 1 }); }
  catch (error) { error.code = "deny-target-unavailable"; throw error; }
  return { target, observations, physicalLabelGroups: groups,
    grouping: "Only near-identical rectangles across different passes; no chain merging or threshold relaxation", minimumConfidence };
}
