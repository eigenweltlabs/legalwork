import { beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
import { artifactDocumentKey, registerUnsavedDocument } from "../src/react-app/domains/session/artifacts/docx-document-state";
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

describe("documents side by side", () => {
  beforeEach(() => {
    usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} });
    storage.clear();
  });

  test("opening a document to the side keeps it in exactly one pane", () => {
    const [nda, msa] = [document("NDA.docx"), document("MSA.docx")];
    open(nda, msa);
    usePanelTabStore.getState().moveTabToSide("session", msa.id);
    expect(session().tabs.map((tab) => tab.id)).toEqual([nda.id, msa.id]);
    expect(session().sideTabIds).toEqual([msa.id]);
    expect(session().sideActiveTabId).toBe(msa.id);
    expect(session().activeTabId).toBe(nda.id);
  });

  test("the main pane never empties into a side pane", () => {
    const nda = document("NDA.docx");
    open(nda);
    usePanelTabStore.getState().moveTabToSide("session", nda.id);
    expect(session().sideTabIds).toEqual([]);
    expect(session().activeTabId).toBe(nda.id);
  });

  test("only documents can sit beside the main pane", () => {
    open(document("NDA.docx"), browser);
    usePanelTabStore.getState().moveTabToSide("session", browser.id);
    expect(session().sideTabIds).toEqual([]);
  });

  test("closing the last side document closes the side pane", () => {
    const [nda, msa] = [document("NDA.docx"), document("MSA.docx")];
    open(nda, msa);
    usePanelTabStore.getState().moveTabToSide("session", msa.id);
    usePanelTabStore.getState().closeTab("session", msa.id);
    expect(session().tabs).toEqual([nda]);
    expect(session().sideTabIds).toEqual([]);
    expect(session().sideActiveTabId).toBeNull();
    expect(session().activeTabId).toBe(nda.id);
  });

  test("closing an active document activates its neighbour in the same pane", () => {
    const [nda, msa, dpa] = [document("NDA.docx"), document("MSA.docx"), document("DPA.docx")];
    open(nda, msa, dpa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", dpa.id);
    expect(session().activeTabId).toBe(msa.id);
    store.closeTab("session", msa.id);
    expect(session().activeTabId).toBe(nda.id);
    expect(session().sideActiveTabId).toBe(dpa.id);
  });

  test("reopening a document already beside the main pane shows it there", () => {
    const [nda, msa, dpa] = [document("NDA.docx"), document("MSA.docx"), document("DPA.docx")];
    open(nda, msa, dpa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", nda.id);
    store.moveTabToSide("session", msa.id);
    expect(session().sideActiveTabId).toBe(msa.id);
    store.openTab("session", nda);
    expect(session().sideActiveTabId).toBe(nda.id);
    expect(session().activeTabId).toBe(dpa.id);
    expect(session().sideTabIds).toEqual([nda.id, msa.id]);
  });

  test("selecting a side document leaves the main pane alone", () => {
    const [nda, msa, dpa] = [document("NDA.docx"), document("MSA.docx"), document("DPA.docx")];
    open(nda, msa, dpa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", msa.id);
    store.moveTabToSide("session", dpa.id);
    store.selectTab("session", msa.id);
    expect(session().sideActiveTabId).toBe(msa.id);
    expect(session().activeTabId).toBe(nda.id);
  });

  test("moving a document back makes it the main pane's active document", () => {
    const [nda, msa] = [document("NDA.docx"), document("MSA.docx")];
    open(nda, msa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", msa.id);
    store.moveTabToMain("session", msa.id);
    expect(session().sideTabIds).toEqual([]);
    expect(session().activeTabId).toBe(msa.id);
  });

  test("reordering one pane keeps the other pane's order", () => {
    const [a, b, c, d] = [document("A.docx"), document("B.docx"), document("C.docx"), document("D.docx")];
    open(a, b, c, d);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", c.id);
    store.moveTabToSide("session", d.id);
    store.reorderTabs("session", [b.id, a.id]);
    expect(session().tabs.map((tab) => tab.id)).toEqual([b.id, a.id, c.id, d.id]);
    store.reorderTabs("session", [d.id, c.id]);
    expect(session().tabs.map((tab) => tab.id)).toEqual([b.id, a.id, d.id, c.id]);
    store.reorderTabs("session", [a.id, "missing"]);
    expect(session().tabs.map((tab) => tab.id)).toEqual([b.id, a.id, d.id, c.id]);
  });

  test("transcript and browser synchronization keep the side pane", () => {
    const [nda, msa] = [document("NDA.docx"), document("MSA.docx")];
    open(nda, msa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", msa.id);
    store.syncTranscriptArtifacts("session", []);
    store.syncArtifactTargets("session", []);
    store.syncBrowserTabs("session", [browser], browser.id);
    expect(session().sideTabIds).toEqual([msa.id]);
    expect(session().sideActiveTabId).toBe(msa.id);
    expect(session().activeTabId).toBe(nda.id);
    expect(session().tabs.map((tab) => tab.id)).toEqual([nda.id, msa.id, browser.id]);
  });

  test("workflow editors, registered under their bare tab id, keep their own guard rules", () => {
    const nda = document("NDA.docx");
    const store = usePanelTabStore.getState();
    store.openTab("session", nda);
    store.openTab("session", { id: "workflow-resource:template.docx", type: "workflow-resource", label: "template.docx" });
    let asked = 0;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => { asked += 1; return false; } } });
    // A document resource does not survive a switch, so leaving it asks.
    let unregister = registerUnsavedDocument("workflow-resource:template.docx", "template.docx", () => true);
    try {
      store.selectTab("session", nda.id);
      expect(asked).toBe(1);
      expect(session().activeTabId).toBe("workflow-resource:template.docx");
      unregister();
      // A draft that is retained on switch lets the tab change without asking.
      unregister = registerUnsavedDocument("workflow-resource:template.docx", "template.docx", () => true, undefined, true);
      store.selectTab("session", nda.id);
      expect(asked).toBe(1);
      expect(session().activeTabId).toBe(nda.id);
      // Closing it still asks, retained or not.
      store.closeTab("session", "workflow-resource:template.docx");
      expect(asked).toBe(2);
      expect(session().tabs).toHaveLength(2);
    } finally {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("the unsaved guard asks only about the document that would unmount", () => {
    const [nda, msa, dpa] = [document("NDA.docx"), document("MSA.docx"), document("DPA.docx")];
    open(nda, msa, dpa);
    const store = usePanelTabStore.getState();
    store.moveTabToSide("session", msa.id);
    let asked = 0;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => { asked += 1; return false; } } });
    const unregister = registerUnsavedDocument(artifactDocumentKey("workspace", "session", msa.id), msa.label, () => true);
    try {
      // The dirty document sits beside the main pane, so switching the main pane
      // must not ask about it.
      store.selectTab("session", nda.id);
      expect(session().activeTabId).toBe(nda.id);
      expect(asked).toBe(0);
      // Moving it would remount it, so that asks, and a refusal changes nothing.
      store.moveTabToMain("session", msa.id);
      expect(asked).toBe(1);
      expect(session().sideTabIds).toEqual([msa.id]);
      // Replacing it as the side pane's active document asks as well.
      store.moveTabToSide("session", dpa.id);
      expect(asked).toBe(2);
      expect(session().sideTabIds).toEqual([msa.id]);
    } finally {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
