import { beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage } from "zustand/middleware";
import type { StorageEntry, StorageRoot } from "@legalwork/types/file-storage";
import { registerUnsavedDocument } from "../src/react-app/domains/session/artifacts/docx-document-state";
import { storageFileTab } from "../src/react-app/domains/session/panel/storage-file-tab";

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

const root: StorageRoot = { id: "firm-files", name: "Firm files", kind: "webdav", writable: true };
const file: StorageEntry = {
  path: "Matters/Contract.docx",
  name: "Contract.docx",
  kind: "file",
  size: 1024,
  modifiedAt: null,
};

describe("connected storage document tabs", () => {
  beforeEach(() => {
    usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} });
    storage.clear();
  });

  test("opens in the document tab system and retains its original storage source", () => {
    const tab = storageFileTab("workspace-a", root, file);
    usePanelTabStore.getState().openTab("session", tab);
    expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(tab.id);
    expect(tab.type).toBe("artifact");
    expect(tab.preview).toBe("word");
    expect(tab.storage).toEqual({ workspaceId: "workspace-a", root, file });
    // A storage path must never be mistaken for a workspace-relative file.
    expect(tab.value).toBeUndefined();
  });

  test("deduplicates reopening while distinguishing workspaces, roots, and case-sensitive paths", () => {
    const tabs = [
      storageFileTab("workspace-a", root, file),
      storageFileTab("workspace-b", root, file),
      storageFileTab("workspace-a", { ...root, id: "archive" }, file),
      storageFileTab("workspace-a", root, { ...file, path: "Matters/contract.docx" }),
    ];
    for (const tab of tabs) usePanelTabStore.getState().openTab("session", tab);
    usePanelTabStore.getState().openTab("session", storageFileTab("workspace-a", root, file));
    expect(usePanelTabStore.getState().sessions.session.tabs).toHaveLength(4);
    expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(tabs[0].id);
  });

  test("transcript and browser synchronization do not remove a storage tab", () => {
    const tab = storageFileTab("workspace", root, file);
    const store = usePanelTabStore.getState();
    store.openTab("session", tab);
    store.syncTranscriptArtifacts("session", []);
    store.syncArtifactTargets("session", []);
    store.syncBrowserTabs("session", [], null);
    expect(usePanelTabStore.getState().sessions.session.tabs).toEqual([tab]);
    expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(tab.id);
  });

  test("the existing unsaved-document guard protects switching and closing storage tabs", () => {
    const tab = storageFileTab("workspace", root, file);
    const other = storageFileTab("workspace", root, { ...file, path: "Other.docx" });
    const store = usePanelTabStore.getState();
    store.openTab("session", other);
    store.openTab("session", tab);
    let allow = false;
    let discarded = false;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => allow } });
    const unregister = registerUnsavedDocument(
      tab.id,
      file.name,
      () => !discarded,
      () => {
        discarded = true;
      },
    );
    try {
      store.selectTab("session", other.id);
      expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(tab.id);
      store.closeTab("session", tab.id);
      expect(usePanelTabStore.getState().sessions.session.tabs).toHaveLength(2);
      expect(discarded).toBe(false);
      allow = true;
      store.closeTab("session", tab.id);
      expect(usePanelTabStore.getState().sessions.session.activeTabId).toBe(other.id);
      expect(discarded).toBe(true);
    } finally {
      unregister();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
