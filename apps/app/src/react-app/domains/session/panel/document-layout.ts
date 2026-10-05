/** A split owns only its two children. Removing a leaf promotes its sibling,
 * preserving the surrounding geometry and every surviving pane's identity. */
export type DocumentLayoutNode =
  | { type: "pane"; id: string }
  | { type: "split"; id: string; direction: "horizontal" | "vertical"; first: DocumentLayoutNode; second: DocumentLayoutNode };
export type DocumentDropEdge = "left" | "right" | "top" | "bottom";
export const MAX_DOCUMENT_PANES = 6;

export function layoutLeaves(node: DocumentLayoutNode): string[] {
  return node.type === "pane" ? [node.id] : [...layoutLeaves(node.first), ...layoutLeaves(node.second)];
}

export function topLayoutLeaves(node: DocumentLayoutNode): string[] {
  return node.type === "pane" ? [node.id] : node.direction === "vertical"
    ? topLayoutLeaves(node.first) : [...topLayoutLeaves(node.first), ...topLayoutLeaves(node.second)];
}

export function pruneLayout(node: DocumentLayoutNode, keep: ReadonlySet<string>): DocumentLayoutNode | null {
  if (node.type === "pane") return keep.has(node.id) ? node : null;
  const first = pruneLayout(node.first, keep);
  const second = pruneLayout(node.second, keep);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function splitLayout(node: DocumentLayoutNode, target: string, pane: string, edge: DocumentDropEdge, splitId: string): DocumentLayoutNode {
  if (node.type === "pane") {
    if (node.id !== target) return node;
    const added: DocumentLayoutNode = { type: "pane", id: pane };
    const before = edge === "left" || edge === "top";
    return { type: "split", id: splitId, direction: edge === "left" || edge === "right" ? "horizontal" : "vertical", first: before ? added : node, second: before ? node : added };
  }
  return { ...node, first: splitLayout(node.first, target, pane, edge, splitId), second: splitLayout(node.second, target, pane, edge, splitId) };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound recursion and reject duplicate node ids in stale or malformed storage. */
export function restoreLayout(value: unknown, paneIds: ReadonlySet<string>): DocumentLayoutNode | null {
  const seen = new Set<string>();
  function read(value: unknown, depth: number): DocumentLayoutNode | null {
    if (depth >= MAX_DOCUMENT_PANES || !record(value) || typeof value.id !== "string" || seen.has(value.id)) return null;
    seen.add(value.id);
    if (value.type === "pane") return paneIds.has(value.id) ? { type: "pane", id: value.id } : null;
    if (value.type !== "split" || paneIds.has(value.id) || (value.direction !== "horizontal" && value.direction !== "vertical")) return null;
    const first = read(value.first, depth + 1);
    const second = read(value.second, depth + 1);
    if (!first) return second;
    if (!second) return first;
    return { type: "split", id: value.id, direction: value.direction, first, second };
  }
  return read(value, 0);
}

/** Read the old presets once; new layouts never depend on named positions. */
export function legacyLayout(paneIds: string[], preset: unknown): DocumentLayoutNode {
  const [first = "main", ...rest] = paneIds;
  const leaf: DocumentLayoutNode = { type: "pane", id: first };
  if (!rest.length) return leaf;
  return { type: "split", id: `legacy:${first}`, direction: preset === "rows" ? "vertical" : "horizontal", first: leaf,
    second: legacyLayout(rest, preset === "main-and-stack" ? "rows" : "columns") };
}

export function layoutSplitIds(node: DocumentLayoutNode): string[] {
  return node.type === "pane" ? [] : [node.id, ...layoutSplitIds(node.first), ...layoutSplitIds(node.second)];
}

export function reconcileLayoutSizes(before: DocumentLayoutNode, after: DocumentLayoutNode, sizes: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const previous = new Map<string, DocumentLayoutNode>();
  function remember(node: DocumentLayoutNode) {
    previous.set(node.id, node);
    if (node.type === "split") { remember(node.first); remember(node.second); }
  }
  remember(before);
  const result: Record<string, Record<string, number>> = {};
  function restore(node: DocumentLayoutNode) {
    if (node.type === "pane") return;
    const old = previous.get(node.id);
    const first = old?.type === "split" ? sizes[node.id]?.[old.first.id] : undefined;
    const second = old?.type === "split" ? sizes[node.id]?.[old.second.id] : undefined;
    if (first !== undefined && second !== undefined && Number.isFinite(first) && Number.isFinite(second) && first > 0 && second > 0) {
      const ratio = Math.max(15, Math.min(85, 100 * first / (first + second)));
      result[node.id] = { [node.first.id]: ratio, [node.second.id]: 100 - ratio };
    }
    restore(node.first); restore(node.second);
  }
  restore(after);
  return result;
}

export function legacyLayoutSizes(tree: DocumentLayoutNode, preset: unknown, paneIds: string[], saved: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  const root = saved[`${preset}:${paneIds.join(":")}`];
  function convert(node: DocumentLayoutNode, weights: Record<string, number>) {
    if (node.type === "pane") return;
    const first = layoutLeaves(node.first).reduce((total, id) => total + (weights[id] ?? 1), 0);
    const second = layoutLeaves(node.second).reduce((total, id) => total + (weights[id] ?? 1), 0);
    result[node.id] = { [node.first.id]: first / (first + second) * 100, [node.second.id]: second / (first + second) * 100 };
    convert(node.first, weights); convert(node.second, weights);
  }
  if (preset === "main-and-stack" && tree.type === "split") {
    result[tree.id] = { [tree.first.id]: root?.[paneIds[0]] ?? 50, [tree.second.id]: root?.stack ?? 50 };
    convert(tree.second, saved.stack ?? {});
  } else convert(tree, root ?? {});
  return result;
}

/** Focus follows the closest surviving sibling when a leaf closes. */
export function siblingPaneIds(node: DocumentLayoutNode, paneId: string): string[] {
  if (node.type === "pane") return [];
  if (node.first.type === "pane" && node.first.id === paneId) return layoutLeaves(node.second);
  if (node.second.type === "pane" && node.second.id === paneId) return layoutLeaves(node.first);
  return [...siblingPaneIds(node.first, paneId), ...siblingPaneIds(node.second, paneId)];
}

export function findLayoutNode(node: DocumentLayoutNode, id: string): DocumentLayoutNode | undefined {
  if (node.id === id) return node;
  return node.type === "split" ? findLayoutNode(node.first, id) ?? findLayoutNode(node.second, id) : undefined;
}
