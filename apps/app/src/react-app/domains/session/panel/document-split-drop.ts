import type { DocumentDropEdge } from "./document-layout";

/** Nearest relative edge wins, so wide and tall panes have identical targets.
 * The middle half remains a generous target for adding to the existing pane. */
export function documentSplitDropEdge(x: number, y: number, width: number, height: number): DocumentDropEdge | null {
  if (width <= 0 || height <= 0 || x < 0 || y < 0 || x > width || y > height) return null;
  const edges: Array<[DocumentDropEdge, number]> = [["left", x / width], ["right", 1 - x / width], ["top", y / height], ["bottom", 1 - y / height]];
  const nearest = edges.reduce((best, edge) => edge[1] < best[1] ? edge : best);
  return nearest[1] <= 0.25 ? nearest[0] : null;
}

/** File browsers keep their folder targets; only the outer gutter offers a split. */
export function fileExplorerSplitDropEdge(x: number, y: number, width: number, height: number): DocumentDropEdge | null {
  const edge = documentSplitDropEdge(x, y, width, height);
  if (!edge) return null;
  return Math.min(x, width - x, y, height - y) <= 40 ? edge : null;
}
