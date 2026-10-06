import { expect, test } from "bun:test";
import { insertTabBefore, tabStripInsertion } from "../src/react-app/domains/session/panel/tab-strip-drop";

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
