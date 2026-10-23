import { afterEach, expect, test } from "bun:test";
import { chatPanelTab, createPanelTabStore, workspacePanelKey } from "../src/react-app/domains/session/panel/panel-tab-store";

const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("deleted projects cannot restore old tabs or opening preferences when their path is reused", async () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const store = createPanelTabStore(), current = () => store.getState();
  current().openTab(workspacePanelKey("deleted"), { id: "old-file", type: "artifact", label: "Old", value: "old.docx", preview: "docx" });
  current().openTab("project:deleted", chatPanelTab("old-chat", "Old chat"));
  current().openTab(workspacePanelKey("kept"), chatPanelTab("kept-chat", "Kept chat"));
  current().openTab(workspacePanelKey("kept"), chatPanelTab("old-chat", "Old chat"));
  current().setOpening(workspacePanelKey("deleted"), { mode: "free" });
  current().clearSession("old-chat");
  current().forgetWorkspace("deleted");
  expect(current().sessions[workspacePanelKey("deleted")]).toBeUndefined();
  expect(current().sessions["project:deleted"]).toBeUndefined();
  expect(current().opening[workspacePanelKey("deleted")]).toBeUndefined();
  expect(current().sessions[workspacePanelKey("kept")].tabs.map(tab => tab.id)).toEqual(["chat:kept-chat"]);
  const reopened = createPanelTabStore();
  await reopened.persist.rehydrate();
  expect(reopened.getState().sessions[workspacePanelKey("deleted")]).toBeUndefined();
  expect(reopened.getState().sessions["project:deleted"]).toBeUndefined();
  expect(reopened.getState().opening[workspacePanelKey("deleted")]).toBeUndefined();
  expect(reopened.getState().sessions[workspacePanelKey("kept")].tabs.map(tab => tab.id)).toEqual(["chat:kept-chat"]);
});
