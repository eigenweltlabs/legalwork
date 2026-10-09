import { expect, test } from "bun:test";
import type { ArtifactPanelTab } from "../src/react-app/domains/session/panel/panel-tab-store";
import { projectFileTab } from "../src/react-app/domains/workspace/project-file-tab";
import { storageFileTab } from "../src/react-app/domains/session/panel/storage-file-tab";
import { viewerFileTabs } from "../src/react-app/domains/session/panel/viewer-file-drop";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

const values = new Map<string, string>();
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
} });
const { samePanelTab, usePanelTabStore, workspacePanelKey } = await import("../src/react-app/domains/session/panel/panel-tab-store");
if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
else Reflect.deleteProperty(globalThis, "localStorage");

const scope = workspacePanelKey("identity-test");
const source = { projectId: "identity-test", workspaceId: "runtime-test", name: "A.md", path: "A.md" };
const local: ArtifactPanelTab = { id: "file:A.md", type: "artifact", label: "A.md", value: "A.md", preview: "markdown" };

test("a multi-file drop continues after an alias of an already-open local file", async () => {
  const store = () => usePanelTabStore.getState(); store().clearSession(scope);
  store().openTab(scope, local);
  const sources = [source, { ...source, path: "B.md", name: "B.md" }];
  const client = createLegalworkServerClient({ baseUrl: "http://unused.invalid" });
  let destination: string | undefined;
  for await (const tab of viewerFileTabs(client, source.workspaceId, { projects: sources, workspace: null, storage: null, memory: null, files: [] })) {
    store().openTab(scope, tab, destination);
    const next = store().sessions[scope];
    const opened = next.tabs.find(entry => samePanelTab(scope, tab, entry));
    const pane = next.panes.find(pane => pane.activeTabId === opened?.id);
    expect(opened).toBeDefined(); expect(pane).toBeDefined(); destination = pane?.id;
  }
  const tabs = store().sessions[scope].tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toEqual(local); // No switch to a new editor wrapper; preserve mounted draft.
  expect(tabs[1]).toMatchObject({ sourceProject: { path: "B.md" } });
  store().clearSession(scope);
});

test("connected click, drag, and batch-open identities reuse one mounted editor in either direction", () => {
  const connected = storageFileTab(source.workspaceId, { id: "drive", name: "Drive", kind: "s3", writable: true }, { name: source.name, path: source.path, kind: "file", size: 1, modifiedAt: null });
  const linked = projectFileTab({ ...source, connectionId: "drive" });
  const store = () => usePanelTabStore.getState();
  for (const [first, second] of [[connected, linked], [linked, connected]]) {
    store().clearSession(scope); store().openTab(scope, first); store().openTab(scope, second);
    expect(store().sessions[scope].tabs).toEqual([first]);
    expect(samePanelTab(scope, first, second)).toBe(true);
  }
  for (const other of [
    projectFileTab({ ...source, connectionId: "other-drive" }),
    projectFileTab({ ...source, projectId: "foreign", connectionId: "drive" }),
    projectFileTab({ ...source, workspaceId: "other-runtime", connectionId: "drive" }),
    local,
  ]) expect(samePanelTab(scope, connected, other)).toBe(false);
  store().clearSession(scope);
});

test("persisted lowercase IDs cannot replace a different case-sensitive original", () => {
  const store = () => usePanelTabStore.getState(); store().clearSession(scope);
  const legacy = { ...local, id: "file:a.md" };
  store().openTab(scope, legacy);
  store().openTab(scope, local);
  const lower = { ...local, id: "file:a.md", value: "a.md", label: "a.md" };
  store().openTab(scope, lower);
  const tabs = store().sessions[scope].tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs[0]).toMatchObject(legacy);
  expect(tabs[1]).toMatchObject({ value: "a.md" });
  expect(tabs[1].id).not.toBe(tabs[0].id);
  store().openTab(scope, lower);
  expect(store().sessions[scope].tabs).toHaveLength(2);
  expect(samePanelTab(scope, lower, tabs[0])).toBe(false);
  expect(samePanelTab(scope, lower, tabs[1])).toBe(true);
  store().clearSession(scope);
});

test("alias navigation updates the requested page while retaining the mounted file representation", () => {
  const store = () => usePanelTabStore.getState(); store().clearSession(scope);
  store().openTab(scope, local);
  store().openTab(scope, { ...projectFileTab(source), sourcePage: 3 });
  expect(store().sessions[scope].tabs).toEqual([{ ...local, sourcePage: 3, storage: undefined, sourceProject: undefined }]);
  store().clearSession(scope);
});
