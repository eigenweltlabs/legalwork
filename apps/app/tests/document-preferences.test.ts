import { beforeEach, describe, expect, test } from "bun:test";
import { createJSONStorage, type StateStorage } from "zustand/middleware";

const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => { storage.set(key, value); },
  removeItem: (key) => { storage.delete(key); },
} satisfies StateStorage;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage });
const { useDocumentPreferences } = await import("../src/react-app/domains/session/artifacts/document-preferences");
if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
else Reflect.deleteProperty(globalThis, "localStorage");
useDocumentPreferences.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) });

describe("document split preferences", () => {
  beforeEach(() => {
    useDocumentPreferences.setState({ autosave: {}, splitSize: 50, stackedSplitSize: 50, splitOrientation: "horizontal" });
    storage.clear();
  });

  test("old saved preferences keep their width and autosave choices with horizontal layout", async () => {
    storage.set("legalwork:document-preferences:v1", JSON.stringify({ state: { splitSize: 55, autosave: { contract: true } }, version: 0 }));
    await useDocumentPreferences.persist.rehydrate();
    expect(useDocumentPreferences.getState()).toMatchObject({ splitSize: 55, stackedSplitSize: 50, splitOrientation: "horizontal", autosave: { contract: true } });
  });

  test("orientation and each divider size survive reload independently", async () => {
    const store = useDocumentPreferences.getState();
    store.setSplitSize(60);
    store.setSplitOrientation("vertical");
    store.setSplitSize(40, "vertical");
    const persisted = new Map(storage);
    useDocumentPreferences.setState({ splitSize: 50, stackedSplitSize: 50, splitOrientation: "horizontal" });
    for (const [key, value] of persisted) storage.set(key, value);
    await useDocumentPreferences.persist.rehydrate();
    expect(useDocumentPreferences.getState()).toMatchObject({ splitSize: 60, stackedSplitSize: 40, splitOrientation: "vertical" });
  });
});
