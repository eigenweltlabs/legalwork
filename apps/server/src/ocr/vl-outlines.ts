// Block outlines for the quality model, ported from PaddleX (Apache-2.0): extract_polygon_points_by_masks,
// extract_custom_vertices and _normalize_layout_polygon in paddlex/inference/models/layout_analysis/processors.py.
// The OpenCV calls they rely on (findContours, approxPolyDP, arcLength, contourArea, fillPoly) are ported from
// OpenCV (Apache-2.0) with its float32 rounding, so crops match Paddle's pixel for pixel. Points are [x, y] pixels.
import polygonClipping, { type MultiPolygon } from "polygon-clipping";

export type Point = [number, number];
export type Box = [x0: number, y0: number, x1: number, y1: number];

/** Python and numpy round halves to even. */
export const roundHalfEven = (value: number) => Math.abs(value % 1) === .5 ? 2 * Math.round(value / 2) : Math.round(value);
export const boxArea = ([x0, y0, x1, y1]: Box) => Math.abs((x1 - x0) * (y1 - y0));
export const rectangle = ([x0, y0, x1, y1]: Box): Point[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export function boxOverlap(a: Box, b: Box, mode: "union" | "small" = "union") {
  const shared = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const reference = mode === "small" ? Math.min(boxArea(a), boxArea(b)) : boxArea(a) + boxArea(b) - shared;
  return reference > 0 ? shared / reference : 0;
}

const shoelace = (ring: Point[]) => ring.reduce((sum, [x, y], i) => {
  const [px, py] = ring.at(i - 1)!;
  return sum + px * y - x * py;
}, 0) / 2;
/** Area of a polygon-clipping result: outer rings and holes have opposite orientation. */
export const area = (shape: MultiPolygon) => Math.abs(shape.flat().reduce((sum, ring) => sum + shoelace(ring), 0));
// Self-crossing outlines count by the non-zero rule, where shapely repairs them with buffer(0).
export const polygonArea = (polygon: Point[]) => area(polygonClipping.union([polygon]));

export function polygonOverlap(a: Point[], b: Point[], mode: "union" | "small" = "union") {
  const reference = mode === "union" ? area(polygonClipping.union([a], [b])) : Math.min(polygonArea(a), polygonArea(b));
  return reference > 0 ? area(polygonClipping.intersection([a], [b])) / reference : 0;
}

/** extract_polygon_points_by_masks in "auto" mode: each block's outline, or its rectangle. */
export function layoutPolygons(blocks: { px: Box; mask?: string }[], width: number, height: number) {
  const scaleX = 800 / width / 4, scaleY = 800 / height / 4;
  const maxWidth = Math.max(...blocks.map(({ px }) => px[2] - px[1])); // PaddleX computes x_max - y_min here.
  const clip = (value: number) => Math.min(200, Math.max(0, roundHalfEven(value)));
  const polygons: Point[][] = [];
  for (const { px, mask } of blocks) {
    const [x0, y0, x1, y1] = px, rect = rectangle(px), w = x1 - x0, h = y1 - y0;
    const [left, right, top, bottom] = [clip(x0 * scaleX), clip(x1 * scaleX), clip(y0 * scaleY), clip(y1 * scaleY)];
    // The layout worker packs the 200x200 mask one bit per cell, most significant bit first.
    const bits = mask ? Buffer.from(mask, "base64") : Buffer.alloc(0), columns = Math.max(0, right - left), rows = Math.max(0, bottom - top);
    const cells = new Uint8Array(columns * rows).map((_, i) => {
      const index = (top + Math.floor(i / columns)) * 200 + left + i % columns;
      return ((bits[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;
    });
    if (!cells.includes(1) || w <= 0 || h <= 0) { polygons.push(rect); continue; }
    // cv2.resize with INTER_NEAREST, from the mask crop to the block size, inside findContours' zero border.
    const image = new Uint8Array((w + 2) * (h + 2)), fx = 1 / (w / columns), fy = 1 / (h / rows);
    const sources = Int32Array.from({ length: w }, (_, x) => Math.min(Math.floor(x * fx), columns - 1));
    for (let y = 0; y < h; y++) {
      const row = Math.min(Math.floor(y * fy), rows - 1) * columns, offset = (y + 1) * (w + 2) + 1;
      for (let x = 0; x < w; x++) image[offset + x] = cells[row + sources[x]!]!;
    }
    const contour = largestContour(image, w + 2);
    const polygon = contour && customVertices(approxPolyDP(contour, 0.004 * arcLength(contour)), w > maxWidth * 0.6 ? w : maxWidth)
      .map(([x, y]): Point => [x + x0, y + y0]);
    polygons.push(normalizePolygon(rect, polygon, polygons.at(-1)));
  }
  return polygons;
}

/** _normalize_layout_polygon in "auto" mode: the rectangle or a rotated rectangle when they fit, else the outline. */
function normalizePolygon(rect: Point[], polygon: Point[] | undefined, previous: Point[] | undefined) {
  if (!polygon || polygon.length < 4) return rect;
  const outline = polygon.map(([x, y]): Point => [Math.fround(x), Math.fround(y)]); // numpy float32
  const quad = minAreaRectangle(outline);
  if (!quad) return outline;
  if (polygonOverlap(rect, quad) >= 0.95) return rect;
  const before = previous ? polygonOverlap(previous, rect, "small") : 0;
  return polygonOverlap(outline, quad) >= 0.8 && before < 0.01 ? quad : outline;
}

const f = Math.fround;
// a*b + c*d in float32 as OpenCV's arm64 build computes it: fused into fma(a, b, c*d) with one rounding.
// A float32 product is exact in double, so only the final sum rounds.
const sum2 = (a: number, b: number, c: number, d: number) => f(a * b + f(c * d));

/** cv2.convexHull(points) for float32 points (Sklansky), counter-clockwise like OpenCV's default. */
function convexHull(points: Point[]) {
  const total = points.length, order = points.map((_, i) => i).sort((a, b) => points[a]![0] - points[b]![0] || points[a]![1] - points[b]![1] || a - b);
  const at = (i: number) => points[order[i]!]!;
  let low = 0, high = 0;
  for (let i = 1; i < total; i++) {
    if (at(low)[1] > at(i)[1]) low = i;
    if (at(high)[1] < at(i)[1]) high = i;
  }
  if (at(0)[0] === at(total - 1)[0] && at(0)[1] === at(total - 1)[1]) return [points[order[0]!]!];
  const sign = (value: number) => Number(value > 0) - Number(value < 0);
  const normalize = ([x, y]: Point): Point => {
    const length = f(Math.sqrt(f(f(x * x) + f(y * y)))), scale = length ? 1 / length : 0;
    return [f(x * scale), f(y * scale)];
  };
  const sklansky = (start: number, end: number, nsign: number, sign2: number) => {
    const increment = end > start ? 1 : -1;
    if (start === end || (at(start)[0] === at(end)[0] && at(start)[1] === at(end)[1])) return [start];
    let previous = start, current = start + increment, next = current + increment;
    const stack = [previous, current, next];
    const after = end + increment;
    while (next !== after) {
      const by = f(at(next)[1] - at(current)[1]);
      if (sign(by) === nsign) { next += increment; stack[stack.length - 1] = next; continue; }
      const a = normalize([f(at(current)[0] - at(previous)[0]), f(at(current)[1] - at(previous)[1])]);
      const b = normalize([f(at(next)[0] - at(current)[0]), by]);
      if (sign(a[1] * b[0] - a[0] * b[1]) === sign2 && (a[0] !== 0 || a[1] !== 0)) {
        previous = current; current = next; next += increment; stack.push(next);
      } else if (previous === start) {
        current = next; stack[1] = current; next += increment; stack[2] = next;
      } else {
        stack[stack.length - 2] = next; current = previous; previous = stack[stack.length - 4]!; stack.pop();
      }
    }
    return stack.slice(0, -1);
  };
  const right = sklansky(total - 1, high, -1, -1), left = sklansky(0, high, -1, 1);
  const hull = [...right.slice(0, -1), ...left.slice(1).reverse()];
  const stop = left.length > 2 ? left[1] : right.length > 2 ? right.at(-2) : -1;
  let bottomLeft = sklansky(0, low, 1, -1), bottomRight = sklansky(total - 1, low, 1, 1);
  if (stop !== undefined && stop >= 0) {
    const check = bottomLeft.length > 2 ? bottomLeft[1]! : bottomLeft.length + bottomRight.length > 2 ? bottomRight[2 - bottomLeft.length]! : -1;
    // All points on one line: the lower part mirrors the upper part.
    if (check === stop || (check >= 0 && at(check)[0] === at(stop)[0] && at(check)[1] === at(stop)[1])) {
      bottomLeft = bottomLeft.slice(0, 2); bottomRight = bottomRight.slice(0, 2);
    }
  }
  const indices = [...hull, ...bottomLeft.slice(0, -1), ...bottomRight.slice(1).reverse()].map(i => order[i]!);
  // Rotate the output so its indices ascend or descend, as OpenCV does.
  if (indices.length >= 3) {
    let min = 0, max = 0, ascending = 0, i = 1;
    for (; i < indices.length; i++) {
      ascending += Number(indices[i - 1]! < indices[i]!);
      if (ascending > 1 && ascending <= i - 2) break;
      if (indices[i]! < indices[min]!) min = i;
      if (indices[i]! > indices[max]!) max = i;
    }
    const distance = Math.abs(max - min), n = indices.length;
    if ((distance === 1 || distance === n - 1) && (ascending <= 1 || ascending >= n - 2)) {
      const up = (max + 1) % n === min, first = up ? min : max, rotated = [...indices.slice(first), ...indices.slice(0, first)];
      if (first > 0 && rotated.every((index, j) => j === n - 1 || up === (index < rotated[j + 1]!))) return rotated.map(index => points[index]!);
    }
  }
  return indices.map(index => points[index]!);
}

/** cv2.boxPoints(cv2.minAreaRect(points)) in float32 (rotating calipers). Undefined when the points are collinear. */
function minAreaRectangle(points: Point[]) {
  const hull = convexHull(points), n = hull.length;
  if (n <= 2) return undefined;
  let left = 0, right = 0, top = 0, bottom = 0, [leftX, topY] = hull[0]!, [rightX, bottomY] = hull[0]!;
  const vectors: Point[] = [], inverse: number[] = [];
  hull.forEach(([x, y], i) => {
    if (x < leftX) { leftX = x; left = i; }
    if (x > rightX) { rightX = x; right = i; }
    if (y > topY) { topY = y; top = i; }
    if (y < bottomY) { bottomY = y; bottom = i; }
    const [nx, ny] = hull[(i + 1) % n]!, dx = f(nx - x), dy = f(ny - y);
    vectors.push([dx, dy]);
    inverse.push(f(1 / Math.sqrt(dx * dx + dy * dy)));
  });
  const seq = [bottom, right, top, left], rotations = [(v: Point): Point => v, ([x, y]: Point): Point => [y, -x], ([x, y]: Point): Point => [-x, -y], ([x, y]: Point): Point => [-y, x]];
  let baseA = 1, baseB = 0, smallest = Infinity, best = { left: 0, bottom: 0, baseA, baseB, width: 0, height: 0 };
  for (let k = 0; k < n; k++) {
    // The caliper side with the smallest angle to its polygon edge turns next.
    const turned = seq.map((index, side) => rotations[side]!(vectors[index]!));
    let main = 0;
    for (let side = 1; side < 4; side++) if (sum2(turned[side]![1], turned[main]![0], -turned[side]![0], turned[main]![1]) < 0) main = side;
    const index = seq[main]!, leadX = f(vectors[index]![0] * inverse[index]!), leadY = f(vectors[index]![1] * inverse[index]!);
    [baseA, baseB] = [[leadX, leadY], [leadY, -leadX], [-leadX, -leadY], [-leadY, leadX]][main]!;
    seq[main] = (index + 1) % n;
    const width = sum2(f(hull[seq[1]!]![0] - hull[seq[3]!]![0]), baseA, f(hull[seq[1]!]![1] - hull[seq[3]!]![1]), baseB);
    const height = sum2(-f(hull[seq[2]!]![0] - hull[seq[0]!]![0]), baseB, f(hull[seq[2]!]![1] - hull[seq[0]!]![1]), baseA);
    const area = f(width * height);
    if (area <= smallest) { smallest = area; best = { left: seq[3]!, bottom: seq[0]!, baseA, baseB, width, height }; }
  }
  const { baseA: a1, baseB: b1, width, height } = best, a2 = -b1, b2 = a1, [lx, ly] = hull[best.left]!, [bx, by] = hull[best.bottom]!;
  const c1 = sum2(a1, lx, ly, b1), c2 = sum2(a2, bx, by, b2), determinant = f(1 / sum2(a1, b2, -a2, b1));
  const corner: Point = [f(sum2(c1, b2, -c2, b1) * determinant), f(sum2(a1, c2, -a2, c1) * determinant)];
  const side1: Point = [f(a1 * width), f(b1 * width)], side2: Point = [f(a2 * height), f(b2 * height)];
  const cx = f(corner[0] + f(f(side1[0] + side2[0]) * 0.5)), cy = f(corner[1] + f(f(side1[1] + side2[1]) * 0.5));
  let w = f(Math.sqrt(side2[0] * side2[0] + side2[1] * side2[1])), h = f(Math.sqrt(side1[0] * side1[0] + side1[1] * side1[1])), angle = -Math.PI / 2;
  if (side1[0] === 0 && side1[1] > 0) [w, h] = [h, w];
  else angle = -Math.atan2(side1[0], side1[1]);
  // RotatedRect::points
  const radians = f(angle * 180 / Math.PI) * Math.PI / 180, cos = f(f(Math.cos(radians)) * 0.5), sin = f(f(Math.sin(radians)) * 0.5);
  const ah = f(sin * h), aw = f(sin * w), bh = f(cos * h), bw = f(cos * w);
  return [[f(f(cx - ah) - bw), f(f(cy + bh) - aw)], [f(f(cx + ah) - bw), f(f(cy - bh) - aw)], [f(f(cx + ah) + bw), f(f(cy - bh) + aw)], [f(f(cx - ah) + bw), f(f(cy + bh) + aw)]] as Point[];
}

/** extract_custom_vertices: keep convex corners, add points along long edges. */
function customVertices(polygon: Point[], maxDistance: number, sharpAngle = 45, maxDistanceRatio = 0.3): Point[] {
  const n = polygon.length, limit = maxDistance * maxDistanceRatio, norm = ([x, y]: Point) => Math.sqrt(x * x + y * y);
  const info = polygon.map(([x, y], i) => {
    const [px, py] = polygon[(i - 1 + n) % n]!, [nx, ny] = polygon[(i + 1) % n]!;
    const v1: Point = [px - x, py - y], v2: Point = [nx - x, ny - y], n1 = norm(v1), n2 = norm(v2);
    const cosine = Math.min(1, Math.max(-1, (v1[0] / n1) * (v2[0] / n2) + (v1[1] / n1) * (v2[1] / n2)));
    return { convex: -v1[0] * v2[1] + v1[1] * v2[0] < 0, angle: Math.acos(cosine) * (180 / Math.PI), v1, v2 };
  });
  const concave = info.flatMap(({ convex }, i) => convex ? [] : [i]), preserve = new Set<number>();
  if (concave.length) {
    const groups: number[] = [];
    let current = [concave[0]!];
    for (let i = 1; i < concave.length; i++) {
      if (concave[i]! - concave[i - 1]! === 1 || (concave[i - 1] === n - 1 && concave[i] === 0)) current.push(concave[i]!);
      else {
        if (current.length >= 2) groups.push(...current);
        current = [concave[i]!];
      }
    }
    if (current.length >= 2) groups.push(...current);
    const wraps = concave.length >= 2 && concave[0] === 0 && concave.at(-1) === n - 1;
    if (!wraps || (groups.includes(0) && groups.includes(n - 1))) groups.forEach(i => preserve.add(i));
  }
  const kept = info.flatMap(({ convex, angle }, i) => convex || (preserve.has(i) && angle >= 120) ? [i] : []);
  const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
  const final: number[] = [];
  kept.forEach((current, position) => {
    const following = kept[(position + 1) % kept.length]!;
    final.push(current);
    const distance = norm([polygon[current]![0] - polygon[following]![0], polygon[current]![1] - polygon[following]![1]]);
    if (distance <= limit) return;
    const between = following > current ? range(current + 1, following) : [...range(current + 1, n), ...range(0, following)];
    if (!between.length) return;
    const needed = Math.ceil(distance / limit) - 1;
    if (between.length <= needed) final.push(...between);
    else for (let i = 0; i < needed; i++) final.push(between[Math.floor(i * (between.length / needed))]!);
  });
  return [...new Set(final)].sort((a, b) => a - b).map(i => {
    const { convex, angle, v1, v2 } = info[i]!, [x, y] = polygon[i]!;
    if (!convex || !(Math.abs(angle - sharpAngle) < 1)) return [x, y];
    const n1 = norm(v1), n2 = norm(v2), sum: Point = [v1[0] / n1 + v2[0] / n2, v1[1] / n1 + v2[1] / n2], length = norm(sum);
    return [x + (sum[0] / length) * (n1 + n2) / 2, y + (sum[1] / length) * (n1 + n2) / 2];
  });
}

const chain: Point[] = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

/** cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_SIMPLE), keeping the contour with the largest area.
 * The binary image already has findContours' one-pixel zero border; it is overwritten. */
function largestContour(image: Uint8Array, w: number) {
  const deltas = chain.map(([x, y]) => x + y * w), stack = new Int32Array(image.length);
  let best: Point[] | undefined, largest = -1;
  for (let start = 0; start < image.length; start++) {
    if (image[start] !== 1) continue;
    // The first raster pixel of a component starts its outer border (icvFetchContourEx).
    let pt: Point = [start % w - 1, Math.floor(start / w) - 1], s = 4, i1 = start;
    do { s = (s - 1) & 7; i1 = start + deltas[s]!; } while (image[i1] === 0 && s !== 4);
    const contour: Point[] = [];
    if (s === 4) contour.push(pt);
    else {
      let i3 = start, previous = s ^ 4;
      for (;;) {
        let i4 = i3;
        while (s < 15) { s++; i4 = i3 + deltas[s & 7]!; if (image[i4] !== 0) break; }
        s &= 7;
        if (s !== previous) contour.push(pt);
        previous = s;
        pt = [pt[0] + chain[s]![0], pt[1] + chain[s]![1]];
        if (i4 === start && i3 === i1) break;
        i3 = i4;
        s = (s + 4) & 7;
      }
    }
    // Mark the component so its other pixels start no contour.
    let size = 0;
    stack[size++] = start;
    image[start] = 2;
    while (size) {
      const index = stack[--size]!;
      for (let k = 0; k < 8; k++) {
        const next = index + deltas[k]!;
        if (image[next] === 1) { image[next] = 2; stack[size++] = next; }
      }
    }
    // Ties go to the later contour, which OpenCV lists first.
    const enclosed = contourArea(contour);
    if (enclosed >= largest) { best = contour; largest = enclosed; }
  }
  return best;
}

function contourArea(contour: Point[]) {
  return Math.abs(contour.reduce((sum, [x, y], i) => {
    const [px, py] = contour.at(i - 1)!;
    return sum + px * y - py * x;
  }, 0) * 0.5);
}

function arcLength(contour: Point[]) {
  if (contour.length <= 1) return 0;
  return contour.reduce((sum, [x, y], i) => {
    const [px, py] = contour.at(i - 1)!;
    return sum + Math.fround(Math.sqrt((x - px) ** 2 + (y - py) ** 2));
  }, 0);
}

/** cv2.approxPolyDP for a closed integer contour (Douglas-Peucker with OpenCV's start and clean-up). */
function approxPolyDP(contour: Point[], epsilon: number) {
  const count = contour.length, eps = epsilon * epsilon, output: Point[] = [], stack: [number, number][] = [];
  let pos = 0, far = 0, start: Point = contour[0]!, small = false;
  // 1. Find approximately the two farthest points.
  for (let i = 0; i < 3; i++) {
    let max = 0;
    pos = (pos + far) % count;
    start = contour[pos]!;
    pos = (pos + 1) % count;
    for (let j = 1; j < count; j++) {
      const [x, y] = contour[pos]!, distance = (x - start[0]) ** 2 + (y - start[1]) ** 2;
      pos = (pos + 1) % count;
      if (distance > max) { max = distance; far = j; }
    }
    small = max <= eps;
  }
  if (small) output.push(start);
  else {
    const first = pos % count, second = (far + first) % count;
    stack.push([second, first], [first, second]);
  }
  // 2. Split slices until every point is within epsilon of its segment.
  while (stack.length) {
    const [from, to] = stack.pop()!, end = contour[to]!;
    start = contour[from]!;
    pos = (from + 1) % count;
    let within = true, split = 0;
    if (pos !== to) {
      const dx = end[0] - start[0], dy = end[1] - start[1], length = dx * dx + dy * dy;
      let max = 0;
      while (pos !== to) {
        const [x, y] = contour[pos]!;
        pos = (pos + 1) % count;
        const projection = (x - start[0]) * dx + (y - start[1]) * dy;
        const distance = projection < 0 ? ((x - start[0]) ** 2 + (y - start[1]) ** 2) * length
          : projection > length ? ((x - end[0]) ** 2 + (y - end[1]) ** 2) * length
          : ((y - start[1]) * dx - (x - start[0]) * dy) ** 2;
        if (distance > max) { max = distance; split = (pos + count - 1) % count; }
      }
      within = max <= eps * length;
    }
    if (within) output.push(start);
    else stack.push([split, to], [from, split]);
  }
  // 3. Remove extra points on almost straight lines.
  const total = output.length;
  let remaining = total, read = total - 1, write: number;
  const next = () => { const point = output[read]!; read = (read + 1) % total; return point; };
  let first = next();
  write = read;
  let middle = next();
  for (let i = 0; i < total && remaining > 2; i++) {
    const last = next(), dx = last[0] - first[0], dy = last[1] - first[1];
    const distance = Math.abs((middle[0] - first[0]) * dy - (middle[1] - first[1]) * dx);
    const inner = (middle[0] - first[0]) * (last[0] - middle[0]) + (middle[1] - first[1]) * (last[1] - middle[1]);
    if (distance * distance <= 0.5 * eps * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) {
      remaining--;
      output[write] = first = last;
      write = (write + 1) % total;
      middle = next();
      i++;
      continue;
    }
    output[write] = first = middle;
    write = (write + 1) % total;
    middle = last;
  }
  return output.slice(0, remaining);
}

/** Clip a line to the image like OpenCV's clipLine. Returns whether any part is inside. */
function clipLine(width: number, height: number, p1: Point, p2: Point) {
  const right = width - 1, bottom = height - 1;
  let [x1, y1] = p1, [x2, y2] = p2;
  const code = (x: number, y: number) => Number(x < 0) + Number(x > right) * 2 + Number(y < 0) * 4 + Number(y > bottom) * 8;
  let c1 = code(x1, y1), c2 = code(x2, y2);
  if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
    if (c1 & 12) {
      const a = c1 < 8 ? 0 : bottom;
      x1 += Math.trunc((a - y1) * (x2 - x1) / (y2 - y1)); y1 = a; c1 = Number(x1 < 0) + Number(x1 > right) * 2;
    }
    if (c2 & 12) {
      const a = c2 < 8 ? 0 : bottom;
      x2 += Math.trunc((a - y2) * (x2 - x1) / (y2 - y1)); y2 = a; c2 = Number(x2 < 0) + Number(x2 > right) * 2;
    }
    if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
      if (c1) { const a = c1 === 1 ? 0 : right; y1 += Math.trunc((a - x1) * (y2 - y1) / (x2 - x1)); x1 = a; c1 = 0; }
      if (c2) { const a = c2 === 1 ? 0 : right; y2 += Math.trunc((a - x2) * (y2 - y1) / (x2 - x1)); x2 = a; c2 = 0; }
    }
  }
  return { inside: (c1 | c2) === 0, p1: [x1, y1] as Point, p2: [x2, y2] as Point };
}

/** OpenCV's 8-connected Line, drawn left to right. */
function drawLine(mask: Uint8Array, width: number, height: number, a: Point, b: Point) {
  let [x, y] = a, [x2, y2] = b;
  if ([x, x2].some(value => value < 0 || value >= width) || [y, y2].some(value => value < 0 || value >= height)) {
    const clipped = clipLine(width, height, a, b);
    if (!clipped.inside) return;
    [[x, y], [x2, y2]] = [clipped.p1, clipped.p2];
  }
  let dx = x2 - x, dy = y2 - y, stepX = 1, stepY = 1;
  if (dx < 0) { dx = -dx; dy = -dy; [x, y] = [x2, y2]; }
  if (dy < 0) { dy = -dy; stepY = -1; }
  const vertical = dy > dx;
  if (vertical) [dx, dy, stepX, stepY] = [dy, dx, stepY, stepX];
  // Every step moves along the main axis; a negative error also moves one pixel across it.
  const [mainX, mainY, crossX, crossY] = vertical ? [0, stepX, stepY, 0] : [stepX, 0, 0, stepY];
  let error = dx - 2 * dy;
  for (let i = 0; i <= dx; i++) {
    mask[y * width + x] = 1;
    const cross = error < 0;
    error += -2 * dy + (cross ? 2 * dx : 0);
    x += mainX + (cross ? crossX : 0);
    y += mainY + (cross ? crossY : 0);
  }
}

/** cv2.fillPoly(mask, [points], 1) for one integer polygon: the outline plus the scanline fill. */
export function fillPolygon(mask: Uint8Array, width: number, height: number, points: Point[]) {
  const ONE = 65536, edges: { y0: number; y1: number; x: number; dx: number }[] = [];
  points.forEach((pt1, i) => {
    const pt0 = points.at(i - 1)!;
    let t0 = pt0, t1 = pt1, y0c = pt0[1], y1c = pt1[1];
    drawLine(mask, width, height, t0, t1);
    if ([t0[0], t1[0]].some(value => value < 0 || value >= width) || [t0[1], t1[1]].some(value => value < 0 || value >= height)) {
      ({ p1: t0, p2: t1 } = clipLine(width, height, t0, t1));
      if (t0[1] !== t1[1]) [y0c, y1c] = [t0[1], t1[1]];
    }
    if (pt0[1] === pt1[1]) return;
    const x0c = t0[0] * ONE, x1c = t1[0] * ONE, dx = Math.trunc((x1c - x0c) / (y1c - y0c));
    edges.push(pt0[1] < pt1[1] ? { y0: pt0[1], y1: pt1[1], x: x0c + (pt0[1] - y0c) * dx, dx } : { y0: pt1[1], y1: pt0[1], x: x1c + (pt1[1] - y1c) * dx, dx });
  });
  if (edges.length < 2) return;
  // FillEdgeCollection: at each row, fill between pairs of crossing edges sorted by x.
  const last = (edge: (typeof edges)[number]) => edge.x + (edge.y1 - edge.y0) * edge.dx;
  const [xMin, xMax] = [Math.min(...edges.flatMap(edge => [edge.x, last(edge)])), Math.max(...edges.flatMap(edge => [edge.x, last(edge)]))];
  const yMin = Math.min(...edges.map(edge => edge.y0)), yMax = Math.max(...edges.map(edge => edge.y1));
  if (yMax < 0 || yMin >= height || xMax < 0 || xMin >= width * ONE) return;
  for (let y = Math.max(0, yMin); y < Math.min(yMax, height); y++) {
    const xs = edges.filter(edge => edge.y0 <= y && y < edge.y1).map(edge => edge.x + (y - edge.y0) * edge.dx).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.floor((xs[i]! + ONE - 1) / ONE)), to = Math.min(width - 1, Math.floor(xs[i + 1]! / ONE));
      if (from < width && to >= 0) mask.fill(1, y * width + from, y * width + to + 1);
    }
  }
}
