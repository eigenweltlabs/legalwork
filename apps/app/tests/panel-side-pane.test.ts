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

beforeEach(() => { usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {}, opening: {} }); storage.clear(); });

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
  test("native browser tabs keep their chosen pane through synchronization", () => {
    add("A"); open(browser); add("B", "A", "left");
    store().moveTab("session", browser.id, paneOf("B").id, "bottom");
    const browserPane = session().panes.find(pane => pane.tabIds.includes(browser.id));
    expect(browserPane?.id).not.toBe(paneOf("A").id);
    store().syncBrowserTabs("session", [browser], browser.id);
    store().syncTranscriptArtifacts("session", []);
    expect(shape()).toEqual(["horizontal", ["vertical", "file:B.docx", browser.id], "file:A.docx"]);
    expect(session().panes.find(pane => pane.tabIds.includes(browser.id))?.id).toBe(browserPane?.id);
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

describe("unified workspace tabs", () => {
  const scope = "workspace:project";
  beforeEach(() => store().setWorkspaceWidth(scope, 1200));
  const state = () => store().sessions[scope];
  const chat = (id: string) => ({ id: `chat:${id}`, type: "chat", sessionId: id, label: id } as const);
  const review = { id: "review:terms", type: "review", reviewId: "terms", label: "Terms" } as const;
  const task = { id: "task:todo", type: "task", taskId: "todo", label: "Task" } as const;
  const pane = (id: string) => state().panes.find(pane => pane.tabIds.includes(id))!;

  test("chats, reviews, tasks, workflows, files and browsers share the six-pane limit", () => {
    const entries = [chat("one"), review, task, { id: "workflow:one", type: "workflow", label: "Workflow" } as const, document("terms.docx"), browser];
    store().openTab(scope, entries[0]);
    for (const entry of entries.slice(1)) store().openTab(scope, entry, pane(entries[0].id).id, "bottom");
    expect(state().panes).toHaveLength(6);
    store().openTab(scope, chat("two"), pane(review.id).id, "right");
    expect(state().tabs).toHaveLength(6);
    // Moving a lone pane frees its original slot, including at capacity.
    store().moveTab(scope, browser.id, pane(task.id).id, "left");
    expect(state().panes).toHaveLength(6);
    const geometry = state().tree;
    store().syncBrowserTabs(scope, [{ ...browser, label: "New title" }], browser.id);
    expect(state().tree).toEqual(geometry);
    expect(new Set(state().panes.flatMap(pane => pane.tabIds)).size).toBe(6);
    for (const entry of entries) store().closeTab(scope, entry.id);
    expect(state().panes).toEqual([{ id: "main", tabIds: [], activeTabId: null }]);
  });

  test("default source opening reuses the content group and retains the review tab", () => {
    store().adoptChat(scope, "one", "Discussion");
    store().openTab(scope, review);
    const reviewPane = pane(review.id).id;
    store().openTab(scope, document("source.docx"));
    expect(state().panes).toHaveLength(2);
    expect(pane(review.id).activeTabId).toBe("file:source.docx");
    expect(state().tabs.some(tab => tab.id === review.id)).toBe(true);
    store().selectTab(scope, review.id);
    store().openTab(scope, document("second.docx"));
    expect(pane("file:second.docx").id).toBe(pane("file:source.docx").id);
    expect(pane(review.id).id).toBe(reviewPane);
    expect(state().panes).toHaveLength(2);
  });

  test("adopting an old chat keeps its layout and resolves transcript files", () => {
    store().openTab("one", { id: "output", type: "artifact", label: "memo.md", preview: "markdown" });
    store().syncTranscriptArtifacts("one", [{ id: "output", kind: "file", value: "memo.md", name: "memo.md", preview: "markdown", confidence: 100, reason: "test", exists: true }]);
    store().adoptChat(scope, "one", "Discussion");
    const file = state().tabs.find(tab => tab.id === "output");
    expect(file).toMatchObject({ value: "memo.md", sourceSessionId: "one" });
    expect(store().sessions.one).toBeUndefined();
    expect(state().panes).toHaveLength(2);
    const geometry = state().tree;
    store().adoptChat(scope, "two", "Second chat");
    expect(state().panes).toHaveLength(2);
    expect(state().tree).toEqual(geometry);
    expect(pane("chat:one").id).toBe(pane("chat:two").id);
    // Updating an inactive title does not steal focus.
    store().updateTabLabel(scope, "chat:one", "Renamed");
    expect(pane("chat:one").activeTabId).toBe("chat:two");
  });

  test("migrates the project layout once and keeps projects independent", () => {
    store().openTab("project:project", document("source.docx"));
    store().openTab("project:project", document("memo.docx"), "main", "top");
    const oldTree = store().sessions["project:project"].tree;
    store().migrateWorkspace("project");
    expect(state().tree).toEqual(oldTree);
    expect(store().sessions["project:project"]).toBeUndefined();
    store().migrateWorkspace("project");
    expect(state().tabs).toHaveLength(2);
    store().adoptChat("workspace:other", "other", "Other project");
    expect(state().tabs).toHaveLength(2);
    expect(store().sessions["workspace:other"].tabs).toHaveLength(1);
  });

  test("deleting a chat closes only its views and keeps files and other chats", () => {
    store().adoptChat(scope, "one", "First chat");
    store().adoptChat(scope, "two", "Second chat");
    store().openTab(scope, document("retained.docx"));
    store().moveTab(scope, "chat:one", pane("file:retained.docx").id, "bottom");
    store().clearSession("one");
    expect(state().tabs.map(tab => tab.id)).toEqual(["chat:two", "file:retained.docx"]);
    expect(state().panes).toHaveLength(2);
    expect(layoutLeaves(state().tree).sort()).toEqual(state().panes.map(pane => pane.id).sort());
  });

  test("native browser updates do not import another project's tabs", () => {
    store().adoptChat(scope, "one", "First project");
    store().syncBrowserTabs(scope, [browser], browser.id);
    const other = "workspace:other";
    store().adoptChat(other, "two", "Second project");
    store().syncBrowserTabs(other, [browser], browser.id);
    expect(store().sessions[other].tabs.map(tab => tab.type)).toEqual(["chat"]);
    const second = { ...browser, id: "browser:second" };
    store().syncBrowserTabs(other, [browser, second], second.id);
    store().syncBrowserTabs(scope, [browser, second], second.id);
    expect(state().tabs.filter(tab => tab.type === "browser").map(tab => tab.id)).toEqual([browser.id]);
    expect(store().sessions[other].tabs.filter(tab => tab.type === "browser").map(tab => tab.id)).toEqual([second.id]);
    store().syncBrowserTabs(scope, [second], second.id);
    expect(state().tabs.map(tab => tab.type)).toEqual(["chat"]);
  });

  test("hidden dirty files stay open on a tab switch but cannot close without consent", () => {
    store().openTab(scope, document("source.docx"));
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    let asked = 0;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => { asked++; return false; } } });
    const unregister = registerUnsavedDocument(artifactDocumentKey("project", scope, "file:source.docx"), "source", () => true);
    try {
      store().openTab(scope, review, "main");
      expect(pane(review.id).activeTabId).toBe(review.id);
      expect(asked).toBe(0);
      store().closeTab(scope, "file:source.docx");
      expect(asked).toBe(1);
      expect(state().tabs).toHaveLength(2);
    } finally {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("restores mixed layout and focus, omitting transient workflow editors", async () => {
    store().adoptChat(scope, "one", "Discussion");
    store().openTab(scope, review);
    store().openTab(scope, task);
    store().openTab(scope, { id: "workflow:one", type: "workflow", label: "Workflow" });
    store().moveTab(scope, review.id, "main", "right");
    store().moveTab(scope, task.id, "main", "bottom");
    store().selectTab(scope, review.id);
    const focused = state().focusedPaneId;
    const persisted = new Map(storage);
    usePanelTabStore.setState({ sessions: {} });
    for (const [key, value] of persisted) storage.set(key, value);
    await usePanelTabStore.persist.rehydrate();
    expect(state().focusedPaneId).toBe(focused);
    expect(state().tabs.map(tab => tab.type)).toEqual(["chat", "review", "task"]);
    expect(state().panes).toHaveLength(3);
    expect(layoutLeaves(state().tree).sort()).toEqual(state().panes.map(pane => pane.id).sort());
  });
});

describe("project overview tabs and workspace window seeds", () => {
  test("overview clicks focus a singleton without creating panes; deliberate splits preserve it", () => {
    const store = usePanelTabStore.getState;
    const scope = "workspace:project-views";
    const overview = { id: "project-view:home", type: "project-view" as const, view: "home" as const, label: "Overview" };
    const tasks = { id: "project-view:tasks", type: "project-view" as const, view: "tasks" as const, label: "Tasks" };
    store().openTab(scope, overview);
    store().openTab(scope, tasks);
    store().openTab(scope, overview);
    expect(store().sessions[scope].tabs).toHaveLength(2);
    expect(store().sessions[scope].panes).toHaveLength(1);
    store().moveTab(scope, tasks.id, "main", "right");
    const pane = store().sessions[scope].panes.find(pane => pane.tabIds.includes(tasks.id))!.id;
    store().openTab(scope, tasks);
    expect(store().sessions[scope].focusedPaneId).toBe(pane);
    expect(store().sessions[scope].panes).toHaveLength(2);
    const restored = store().readLayout(store().sessions[scope]);
    expect(restored?.tabs).toEqual([overview, tasks]);
    expect(restored?.panes).toHaveLength(2);
  });
  test("cloned storage documents retain their source and discard another window's working cache", () => {
    const storage = { workspaceId: "p", root: { id: "connection", name: "Files", kind: "s3", writable: false }, file: { path: "source.docx", name: "source.docx", kind: "file", size: 100, modifiedAt: null } };
    const layout = usePanelTabStore.getState().readLayout({ tabs: [{ id: 'storage:["p","connection","source.docx"]', type: "artifact", label: "source.docx", value: "cache/from-other-window.docx", storage }] });
    expect(layout?.tabs[0]).toMatchObject({ type: "artifact", storage });
    expect(layout?.tabs[0]).not.toHaveProperty("value");
    expect(usePanelTabStore.getState().readLayout({ tabs: [{ id: "bad", type: "artifact", value: "cache.docx", label: "bad", storage: { broken: true } }] })?.tabs).toEqual([]);
  });
});

describe("workspace opening profiles and previews", () => {
  const scope = "workspace:opening";
  beforeEach(() => store().clearSession(scope));
  const state = () => store().sessions[scope];
  const pane = (id: string) => state().panes.find(item => item.tabIds.includes(id))!;
  const preview = (name: string) => store().openTab(scope, document(name), undefined, undefined, { preview: true });

  for (const side of ["left", "right"] as const) {
    test(`chat/content routing with chats on the ${side}`, () => {
      store().setWorkspaceWidth(scope, 1000);
      store().setOpening(scope, { chatSide: side });
      store().openTab(scope, document("a.docx"));
      store().adoptChat(scope, "one", "Chat");
      expect(state().panes).toHaveLength(2);
      const order = layoutLeaves(state().tree);
      expect(order[side === "left" ? 0 : 1]).toBe(pane("chat:one").id);
      store().selectTab(scope, "chat:one");
      store().openTab(scope, document("b.docx"));
      expect(pane("file:b.docx").id).toBe(pane("file:a.docx").id);
      store().adoptChat(scope, "two", "Next chat");
      expect(pane("chat:two").id).toBe(pane("chat:one").id);
      expect(state().panes).toHaveLength(2);
    });
  }
  test("narrow or unmeasured workspaces do not split automatically", () => {
    store().adoptChat(scope, "one", "Chat");
    preview("a.docx");
    expect(state().panes).toHaveLength(1);
    store().setWorkspaceWidth(scope, 799);
    preview("b.docx");
    expect(state().panes).toHaveLength(1);
  });
  test("free beside reuses a right group and never creates a third automatic column", () => {
    store().setOpening(scope, { mode: "free", newContent: "beside" });
    store().setWorkspaceWidth(scope, 2000);
    store().openTab(scope, document("a.docx"));
    store().openTab(scope, document("b.docx"));
    store().selectTab(scope, "file:a.docx");
    store().openTab(scope, document("c.docx"));
    expect(pane("file:c.docx").id).toBe(pane("file:b.docx").id);
    store().openTab(scope, document("d.docx"));
    expect(state().panes).toHaveLength(2);
    expect(pane("file:d.docx").id).toBe(pane("file:b.docx").id);
  });
  test("profile changes leave layouts intact; active mode, existing tabs and explicit drops win", () => {
    store().setWorkspaceWidth(scope, 1600);
    store().adoptChat(scope, "one", "Chat");
    store().openTab(scope, document("a.docx"));
    const tree = state().tree;
    store().setOpening(scope, { mode: "free", newContent: "active" });
    expect(state().tree).toBe(tree);
    store().selectTab(scope, "chat:one");
    store().openTab(scope, document("b.docx"));
    expect(pane("file:b.docx").id).toBe(pane("chat:one").id);
    store().openTab(scope, document("a.docx"));
    expect(pane("file:a.docx").id).not.toBe(pane("chat:one").id);
    store().openTab(scope, document("a.docx"), pane("chat:one").id, "bottom");
    expect(state().panes).toHaveLength(2);
    expect(state().tree.type === "split" && state().tree.direction).toBe("vertical");
  });
  test("preview reuse protects dirty drafts even when no edit event reached the tab", () => {
    preview("a.docx"); preview("b.docx");
    expect(state().tabs.map(tab => tab.id)).toEqual(["file:b.docx"]);
    const unregister = registerUnsavedDocument(artifactDocumentKey("opening", scope, "file:b.docx"), "Draft", () => true);
    try {
      preview("c.docx");
      expect(state().tabs.map(tab => tab.id)).toEqual(["file:b.docx", "file:c.docx"]);
      expect(pane("file:c.docx").previewTabId).toBe("file:c.docx");
      store().keepTab(scope, "file:c.docx");
      preview("d.docx");
      expect(state().tabs).toHaveLength(3);
    } finally { unregister(); }
  });
  test("moving, explicitly reopening and duplicate file identities pin previews", () => {
    preview("a.docx");
    store().openTab(scope, { ...document("a.docx"), id: "same-path" });
    expect(pane("file:a.docx").previewTabId).toBeUndefined();
    preview("b.docx");
    store().moveTab(scope, "file:b.docx", pane("file:a.docx").id, "right");
    expect(pane("file:b.docx").previewTabId).toBeUndefined();
    preview("c.docx");
    expect(state().tabs).toHaveLength(3);
  });
  test("at the pane limit an automatic opening falls back to a tab instead of disappearing", () => {
    store().setOpening(scope, { mode: "free", newContent: "beside" });
    store().setWorkspaceWidth(scope, 1600);
    store().openTab(scope, document("a.docx"));
    for (let i = 0; i < 5; i++) store().openTab(scope, document(`${i}.docx`), "main", "bottom");
    expect(state().panes).toHaveLength(6);
    store().openTab(scope, document("last.docx"));
    expect(state().panes).toHaveLength(6);
    expect(state().tabs).toHaveLength(7);
    expect(pane("file:last.docx").activeTabId).toBe("file:last.docx");
  });
  test("new browser tabs obey the same profile", () => {
    store().setWorkspaceWidth(scope, 1200);
    store().setOpening(scope, { mode: "free", newContent: "active" });
    store().adoptChat(scope, "one", "Chat");
    store().syncBrowserTabs(scope, [browser], browser.id);
    expect(state().panes).toHaveLength(1);
    expect(pane(browser.id).id).toBe(pane("chat:one").id);
  });
  test("opening preferences and preview slots survive restoration", async () => {
    store().setOpening(scope, { mode: "free", newContent: "beside", chatSide: "right" });
    preview("a.docx");
    const saved = new Map(storage);
    usePanelTabStore.setState({ sessions: {}, opening: {} });
    for (const [key, value] of saved) storage.set(key, value);
    await usePanelTabStore.persist.rehydrate();
    expect(store().opening[scope]).toEqual({ mode: "free", newContent: "beside", chatSide: "right" });
    expect(pane("file:a.docx").previewTabId).toBe("file:a.docx");
    preview("b.docx");
    expect(state().tabs.map(tab => tab.id)).toEqual(["file:b.docx"]);
  });
});
