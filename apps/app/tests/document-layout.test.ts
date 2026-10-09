import { expect, test } from "bun:test";
import { layoutLeaves, layoutSplitIds, pruneLayout, restoreLayout, topLayoutLeaves, type DocumentLayoutNode } from "../src/react-app/domains/session/panel/document-layout";

function trees(ids: string[]): DocumentLayoutNode[] {
  if (ids.length === 1) return [{ type: "pane", id: ids[0] }];
  const result: DocumentLayoutNode[] = [];
  for (let index = 1; index < ids.length; index++) {
    for (const first of trees(ids.slice(0, index))) for (const second of trees(ids.slice(index))) {
      result.push({ type: "split", id: `split:${ids.join("")}`, direction: "horizontal", first, second });
      result.push({ type: "split", id: `split:${ids.join("")}`, direction: "vertical", first, second });
    }
  }
  return result;
}

test("every binary layout up to six panes collapses each leaf locally", () => {
  let count = 0;
  for (let size = 1; size <= 6; size++) {
    const ids = Array.from({ length: size }, (_, index) => String(index));
    for (const tree of trees(ids)) {
      expect(restoreLayout(tree, new Set(ids))).toEqual(tree);
      for (const removed of ids) {
        const keep = ids.filter(id => id !== removed);
        const pruned = pruneLayout(tree, new Set(keep));
        expect(pruned ? layoutLeaves(pruned) : []).toEqual(keep);
        if (pruned) {
          expect(layoutSplitIds(pruned)).toHaveLength(keep.length - 1);
          // Every split outside the removed leaf's ancestor chain retains identity.
          function unchanged(node: DocumentLayoutNode) {
            if (!layoutLeaves(node).includes(removed)) expect(pruneLayout(node, new Set(keep))).toBe(node);
            if (node.type === "split") { unchanged(node.first); unchanged(node.second); }
          }
          unchanged(tree);
          expect(topLayoutLeaves(pruned).every(id => keep.includes(id))).toBe(true);
        }
        count++;
      }
    }
  }
  expect(count).toBe(9373);
});

test("restoration rejects malformed, duplicate and excessively deep nodes", () => {
  expect(restoreLayout({ type: "split", id: "s", direction: "diagonal" }, new Set(["a"]))).toBeNull();
  const duplicate = { type: "split", id: "s", direction: "horizontal", first: { type: "pane", id: "a" }, second: { type: "pane", id: "a" } };
  expect(restoreLayout(duplicate, new Set(["a"]))).toEqual({ type: "pane", id: "a" });
  const cycle: Record<string, unknown> = { type: "split", id: "s", direction: "horizontal", first: { type: "pane", id: "a" } };
  cycle.second = cycle;
  expect(restoreLayout(cycle, new Set(["a"]))).toEqual({ type: "pane", id: "a" });
});
