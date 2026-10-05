import { beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
import { artifactDocumentKey, registerUnsavedDocument } from "../src/react-app/domains/session/artifacts/docx-document-state";
import { layoutLeaves, MAX_DOCUMENT_PANES, type DocumentDropEdge, type DocumentLayoutNode } from "../src/react-app/domains/session/panel/document-layout";
import type { ArtifactPanelTab, BrowserPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";

const storage = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
});
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store");
if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
else Reflect.deleteProperty(globalThis, "localStorage");
usePanelTabStore.persist.setOptions({
  storage: createJSONStorage(() => ({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
    removeItem: (key) => {
      storage.delete(key);
    },
  })),
});

const document = (name: string): ArtifactPanelTab => ({
  id: `file:${name}`,
  type: "artifact",
  label: name,
  preview: "word",
  value: name,
});

const browser: BrowserPanelTab = {
  id: "browser-1",
  type: "browser",
  label: "Search",
  url: "https://example.com",
  favicon: null,
  status: "ready",
  canGoBack: false,
  canGoForward: false,
};

const session = () => usePanelTabStore.getState().sessions.session;
const open = (...tabs: Array<ArtifactPanelTab | BrowserPanelTab>) => {
  for (const tab of tabs) usePanelTabStore.getState().openTab("session", tab);
};

const store = () => usePanelTabStore.getState();
const paneOf = (name: string) => {
  const pane = session().panes.find(pane => pane.tabIds.includes(`file:${name}.docx`));
  if (!pane) throw new Error(`Missing pane for ${name}`);
  return pane;
};
const add = (name: string, beside?: string, edge?: DocumentDropEdge) => store().openTab("session", document(`${name}.docx`), beside ? paneOf(beside).id : undefined, edge);
const move = (name: string, to: string, edge?: DocumentDropEdge) => store().moveTab("session", `file:${name}.docx`, paneOf(to).id, edge);
const close = (name: string) => store().closeTab("session", `file:${name}.docx`);
function shape(node: DocumentLayoutNode = session().tree): unknown {
  if (node.type === "pane") return session().panes.find(pane => pane.id === node.id)?.activeTabId;
  return [node.direction, shape(node.first), shape(node.second)];
}
function invariants() {
  const state = session();
  const leaves = layoutLeaves(state.tree);
  const assigned = state.panes.flatMap(pane => pane.tabIds);
  expect(new Set(leaves).size).toBe(leaves.length);
  expect([...leaves].sort()).toEqual(state.panes.map(pane => pane.id).sort());
  expect(state.panes.length).toBeLessThanOrEqual(MAX_DOCUMENT_PANES);
  expect([...assigned].sort()).toEqual(state.tabs.map(tab => tab.id).sort());
  expect(new Set(assigned).size).toBe(assigned.length);
  for (const pane of state.panes) {
    if (state.tabs.length) expect(pane.tabIds.length).toBeGreaterThan(0);
    expect(pane.activeTabId).toEqual(pane.tabIds.length ? expect.stringMatching(/^.+$/) : null);
    if (pane.activeTabId) expect(pane.tabIds).toContain(pane.activeTabId);
  }
}
function refuseDirty(name: string) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let asked = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => { asked++; return false; } } });
  const unregister = registerUnsavedDocument(artifactDocumentKey("workspace", "session", `file:${name}.docx`), name, () => true);
  return {
    asked: () => asked,
    restore: () => {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

beforeEach(() => { usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} }); storage.clear(); });

describe("free document splits", () => {
  for (const edge of ["left", "right", "top", "bottom"] satisfies DocumentDropEdge[]) {
    test(`a ${edge} drop splits exactly the target pane`, () => {
      add("A"); add("B", "A", "right"); add("C", "A", edge);
      const pair = edge === "left" || edge === "top" ? ["file:C.docx", "file:A.docx"] : ["file:A.docx", "file:C.docx"];
      expect(shape()).toEqual(["horizontal", [edge === "left" || edge === "right" ? "horizontal" : "vertical", ...pair], "file:B.docx"]);
      invariants();
    });
  }
  test("a single document cannot split into a duplicate of itself", () => {
    add("A"); const before = session();
    for (const edge of ["left", "right", "top", "bottom"] satisfies DocumentDropEdge[]) move("A", "A", edge);
    expect(session()).toBe(before);
  });
  test("moving a tab out of its own group reveals its neighbour", () => {
    add("A"); add("B"); add("C");
    move("B", "B", "left");
    expect(shape()).toEqual(["horizontal", "file:B.docx", "file:C.docx"]);
    move("C", "C", "bottom");
    expect(shape()).toEqual(["horizontal", "file:B.docx", ["vertical", "file:A.docx", "file:C.docx"]]);
    invariants();
  });
  test("moving the last primary tab is allowed and collapses its source", () => {
    add("A"); add("B", "A", "right");
    const destinationId = paneOf("B").id;
    move("A", "B");
    expect(session().panes).toHaveLength(1);
    expect(session().panes[0].id).toBe(destinationId);
    expect(paneOf("A").tabIds).toEqual(["file:A.docx", "file:B.docx"]);
    expect(shape()).toBe("file:A.docx");
    invariants();
  });
  test("moving an existing original from Project Files reuses its legacy tab id", () => {
    add("A"); store().openTab("session", { ...document("B.docx"), id: "legacy-b" });
    store().openTab("session", document("B.docx"), paneOf("A").id, "left");
    expect(session().tabs.map(tab => tab.id)).toEqual(["file:A.docx", "legacy-b"]);
    expect(shape()).toEqual(["horizontal", "legacy-b", "file:A.docx"]);
  });
  test("opening an existing split document focuses it in place", () => {
    add("A"); add("B", "A", "right"); add("C", "B");
    add("B");
    expect(paneOf("B").activeTabId).toBe("file:B.docx");
    expect(paneOf("A").activeTabId).toBe("file:A.docx");
    invariants();
  });
  test("a late import cannot recreate a closed target", () => {
    add("A"); add("B", "A", "right"); const target = paneOf("B").id;
    close("B"); const before = session();
    store().openTab("session", document("C.docx"), target, "bottom");
    expect(session()).toBe(before);
  });
  test("six panes permit extra tabs and relocation, but not a seventh pane", () => {
    add("A"); for (const name of ["B", "C", "D", "E", "F"]) add(name, "A", "right");
    const before = session();
    add("G", "A", "bottom"); expect(session()).toBe(before);
    move("F", "B", "top"); expect(session().panes).toHaveLength(6);
    add("G", "A"); expect(session().tabs).toHaveLength(7);
    const atLimit = session(); move("G", "B", "left"); expect(session()).toBe(atLimit);
    close("F"); move("G", "B", "left"); expect(session().panes).toHaveLength(6);
    invariants();
  });
  test("native browser tabs stay in their integration pane, regardless of geometry", () => {
    add("A"); open(browser); add("B", "A", "left");
    store().moveTab("session", browser.id, paneOf("B").id, "bottom");
    expect(session().panes[0].tabIds).toContain(browser.id);
    store().syncBrowserTabs("session", [browser], browser.id);
    store().syncTranscriptArtifacts("session", []);
    expect(shape()).toEqual(["horizontal", "file:B.docx", browser.id]);
    invariants();
  });
});

describe("closing and collapsing", () => {
  for (const outer of ["right", "bottom"] satisfies DocumentDropEdge[]) {
    for (const inner of ["right", "bottom"] satisfies DocumentDropEdge[]) {
      for (const closing of ["A", "B", "C"]) {
        test(`${outer}/${inner}: closing ${closing} only promotes its sibling`, () => {
          add("A"); add("B", "A", outer); add("C", "B", inner);
          const ids = new Map(session().panes.map(pane => [pane.activeTabId, pane.id]));
          close(closing);
          const dir = (edge: string) => edge === "right" ? "horizontal" : "vertical";
          expect(shape()).toEqual(closing === "A" ? [dir(inner), "file:B.docx", "file:C.docx"]
            : [dir(outer), "file:A.docx", closing === "B" ? "file:C.docx" : "file:B.docx"]);
          for (const pane of session().panes) expect(pane.id).toBe(ids.get(pane.activeTabId));
          invariants();
        });
      }
    }
  }
  test("closing the bottom-right pane leaves the left stack unchanged", () => {
    add("A"); add("B", "A", "right"); add("C", "A", "bottom"); add("D", "B", "bottom");
    close("D");
    expect(shape()).toEqual(["horizontal", ["vertical", "file:A.docx", "file:C.docx"], "file:B.docx"]);
    invariants();
  });
  test("closing an active tab selects its right neighbour, then its left neighbour", () => {
    add("A"); add("B"); add("C");
    store().selectTab("session", "file:B.docx"); close("B"); expect(shape()).toBe("file:C.docx");
    close("C"); expect(shape()).toBe("file:A.docx"); close("A");
    expect(session().panes).toEqual([{ id: "main", tabIds: [], activeTabId: null }]);
    add("D"); invariants();
  });
  test("a background tab can close without collapsing its nonempty pane", () => {
    add("A"); add("B"); add("C", "B", "bottom");
    close("A"); expect(session().panes).toHaveLength(2); expect(paneOf("B").activeTabId).toBe("file:B.docx");
    invariants();
  });
  test("a late resize callback cannot restore obsolete child sizes", () => {
    add("A"); add("B", "A", "right"); const tree = session().tree;
    if (tree.type !== "split") throw new Error("Expected split");
    const oldSizes = { [tree.first.id]: 60, [tree.second.id]: 40 };
    store().setPaneSizes("session", tree.id, oldSizes);
    add("C", "A", "bottom"); const before = session();
    store().setPaneSizes("session", tree.id, oldSizes);
    expect(session()).toBe(before);
  });
  test("outer proportions survive splits and collapses on both sides", () => {
    add("A"); add("B", "A", "right"); const tree = session().tree;
    if (tree.type !== "split") throw new Error("Expected split");
    store().setPaneSizes("session", tree.id, { [tree.first.id]: 62, [tree.second.id]: 38 });
    add("C", "A", "bottom"); add("D", "B", "bottom");
    const split = session().tree;
    if (split.type !== "split") throw new Error("Expected split");
    expect(session().sizes[split.id]).toEqual({ [split.first.id]: 62, [split.second.id]: 38 });
    close("A"); close("D"); const collapsed = session().tree;
    if (collapsed.type !== "split") throw new Error("Expected split");
    expect(session().sizes[collapsed.id]).toEqual({ [collapsed.first.id]: 62, [collapsed.second.id]: 38 });
    expect(Object.keys(session().sizes)).toEqual([collapsed.id]);
    invariants();
  });
});

describe("draft safety", () => {
  test("splitting, relocation and sibling promotion do not discard the moved draft", () => {
    add("A"); add("B"); const dirty = refuseDirty("B");
    try {
      move("B", "B", "left"); move("B", "A", "bottom"); close("A");
      expect(dirty.asked()).toBe(0); expect(shape()).toBe("file:B.docx");
    } finally { dirty.restore(); }
  });
  test("cancelling a centre drop onto a dirty editor changes nothing", () => {
    add("A"); add("B", "A", "right"); const dirty = refuseDirty("B"); const before = session();
    try {
      move("A", "B"); expect(session()).toBe(before);
      add("C", "B"); expect(session()).toBe(before);
      expect(dirty.asked()).toBe(2);
    } finally { dirty.restore(); }
  });
  test("cancelling close or tab switch leaves the draft and tree untouched", () => {
    add("A"); add("B"); const dirty = refuseDirty("B"); const before = session();
    try {
      close("B"); expect(session()).toBe(before);
      store().selectTab("session", "file:A.docx"); expect(session()).toBe(before);
      expect(dirty.asked()).toBe(2);
    } finally { dirty.restore(); }
  });
  test("workflow drafts retain their close and switch guards", () => {
    add("A"); const id = "workflow-resource:template.docx";
    store().openTab("session", { id, type: "workflow-resource", label: "template.docx" });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    let asked = 0;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => { asked++; return false; } } });
    const unregister = registerUnsavedDocument(id, "template.docx", () => true, undefined, true);
    try {
      store().selectTab("session", "file:A.docx"); expect(asked).toBe(0);
      store().closeTab("session", id); expect(asked).toBe(1); expect(session().tabs).toHaveLength(2);
    } finally {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("restoration and repeated moves", () => {
  test("reload preserves arbitrary geometry and removes transient leaves locally", async () => {
    add("A"); add("B", "A", "left"); add("C", "B", "bottom");
    const originalTree = session().tree;
    store().openTab("session", { ...document("source.docx"), searchSources: [] }, paneOf("A").id, "top");
    const persisted = new Map(storage); usePanelTabStore.setState({ sessions: {} });
    for (const [key, value] of persisted) storage.set(key, value);
    await usePanelTabStore.persist.rehydrate();
    expect(session().tree).toEqual(originalTree);
    expect(session().tabs).toHaveLength(3); invariants();
  });
  test("old preset and two-pane storage migrate without losing tabs", async () => {
    for (const preset of ["columns", "rows", "three-columns", "main-and-stack"]) {
      const ids = preset === "columns" || preset === "rows" ? ["A", "B"] : ["A", "B", "C"];
      storage.set("legalwork:panel-tabs:v1", JSON.stringify({ state: { sessions: { session: {
        tabs: ids.map(name => document(`${name}.docx`)), layout: preset,
        panes: ids.map((name, index) => ({ id: ["main", "side", "third"][index], tabIds: [`file:${name}.docx`], activeTabId: `file:${name}.docx` })),
      } } }, version: 0 }));
      await usePanelTabStore.persist.rehydrate(); expect(session().tabs).toHaveLength(ids.length); invariants();
    }
    storage.set("legalwork:panel-tabs:v1", JSON.stringify({ state: { sessions: { session: { tabs: [document("A.docx"), document("B.docx")], activeTabId: "file:A.docx", sideTabIds: ["file:B.docx"], sideActiveTabId: "file:B.docx" } } }, version: 0 }));
    await usePanelTabStore.persist.rehydrate(); expect(shape()).toEqual(["horizontal", "file:A.docx", "file:B.docx"]); invariants();
  });
  test("malformed duplicate panes are repaired without losing documents", async () => {
    storage.set("legalwork:panel-tabs:v1", JSON.stringify({ state: { sessions: { session: {
      tabs: [document("A.docx"), document("B.docx")], panes: [
        { id: "main", tabIds: ["file:A.docx"], activeTabId: "missing" },
        { id: "main", tabIds: ["file:B.docx"], activeTabId: "file:B.docx" }],
      tree: { type: "split", id: "s", direction: "vertical", first: { type: "pane", id: "main" }, second: { type: "pane", id: "main" } },
    } } }, version: 0 }));
    await usePanelTabStore.persist.rehydrate(); expect(session().tabs).toHaveLength(2); invariants();
  });
  test("reordering one pane preserves the other groups", () => {
    add("A"); add("B"); add("C", "A", "right"); add("D", "C");
    store().reorderTabs("session", ["file:B.docx", "file:A.docx"]);
    store().reorderTabs("session", ["file:D.docx", "file:C.docx"]);
    expect(session().tabs.map(tab => tab.id)).toEqual(["file:B.docx", "file:A.docx", "file:D.docx", "file:C.docx"]);
    close("D"); expect(paneOf("C").activeTabId).toBe("file:C.docx"); invariants();
  });
  test("hundreds of splits, moves and closes preserve membership invariants", () => {
    const edges: DocumentDropEdge[] = ["left", "right", "top", "bottom"];
    let random = 37;
    const next = (limit: number) => { random = (random * 1664525 + 1013904223) >>> 0; return random % limit; };
    for (let index = 0; index < 500; index++) {
      const current = usePanelTabStore.getState().sessions.session;
      if (!current?.tabs.length || next(4) === 0) store().openTab("session", document(`${index}.docx`), current?.panes[next(current.panes.length)].id, edges[next(4)]);
      else {
        const tab = current.tabs[next(current.tabs.length)];
        if (next(5) === 0) store().closeTab("session", tab.id);
        else store().moveTab("session", tab.id, current.panes[next(current.panes.length)].id, next(3) ? edges[next(4)] : undefined);
      }
      invariants();
    }
  });
});
