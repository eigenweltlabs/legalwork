import { expect, test } from "bun:test";
import { insertTabBefore, tabStripInsertion, tabStripPreview } from "../src/react-app/domains/session/panel/tab-strip-drop";

test("tab drops insert before/after a tab midpoint, including a scrolled strip", () => {
  const tabs = [{ id: "a", left: -80, right: 80 }, { id: "b", left: 84, right: 244 }, { id: "c", left: 248, right: 408 }];
  expect(tabStripInsertion(10, tabs, "c")).toEqual({ beforeId: "b", x: 84 });
  expect(tabStripInsertion(90, tabs, "c")).toEqual({ beforeId: "b", x: 84 });
  expect(tabStripInsertion(200, tabs, "a")).toEqual({ beforeId: "c", x: 248 });
  expect(tabStripInsertion(600, tabs, "external")).toEqual({ beforeId: null, x: 408 });
});

test("every insertion preserves membership and places the dragged tab next to its target", () => {
  const ids = ["chat", "browser1", "file", "browser2", "review"];
  for (const id of ids) for (const before of [...ids, null]) {
    const ordered = insertTabBefore(ids, id, before);
    expect([...ordered].sort()).toEqual([...ids].sort());
    if (id === before) expect(ordered).toEqual(ids);
    else if (before === null) expect(ordered.at(-1)).toBe(id);
    else expect(ordered.indexOf(id) + 1).toBe(ordered.indexOf(before));
  }
  expect(insertTabBefore(ids, "missing", "chat")).toEqual(ids);
  expect(insertTabBefore(ids, "chat", "closed-target")).toEqual(ids);
  expect(tabStripInsertion(100, [{ id: "chat", left: 40, right: 200 }], "chat")).toEqual({ beforeId: null, x: 40 });
});


test("animated gaps exactly match the committed order, even with unequal widths and scrolled tabs", () => {
  const tabs = [{ id: "a", left: -80, right: 80 }, { id: "b", left: 84, right: 204 }, { id: "c", left: 208, right: 368 }];
  for (const dragged of tabs) for (const beforeId of [...tabs.filter(tab => tab.id !== dragged.id).map(tab => tab.id), null]) {
    const preview = tabStripPreview(tabs, dragged.id, beforeId, dragged.right - dragged.left, 4);
    const order = insertTabBefore(tabs.map(tab => tab.id), dragged.id, beforeId);
    let expected = tabs[0].left;
    for (const id of order) {
      const tab = tabs.find(tab => tab.id === id)!;
      expect(id === dragged.id ? preview.placeholder : tab.left + preview.offsets.get(id)!).toBe(expected);
      expected += tab.right - tab.left + 4;
    }
  }
});

test("external tab makes one full-width gap without displacing preceding tabs", () => {
  const tabs = [{ id: "a", left: 100, right: 260 }, { id: "b", left: 264, right: 424 }];
  const preview = tabStripPreview(tabs, "external", "b", 160, 4);
  expect(preview.placeholder).toBe(264);
  expect(preview.offsets.get("a")).toBe(0);
  expect(preview.offsets.get("b")).toBe(164);
  expect(tabStripPreview([], "external", null, 160, 4).placeholder).toBe(0);
});
