import type { DocumentSplitOrientation } from "../artifacts/document-preferences";

/** Choose the nearer edge in the bottom-right corner, independent of aspect ratio. */
export function documentSplitDropEdge(x: number, y: number, width: number, height: number): DocumentSplitOrientation | null {
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return null;
  const right = x / width;
  const bottom = y / height;
  if (bottom >= 0.7 && bottom > right) return "vertical";
  return right >= 0.7 ? "horizontal" : null;
}
