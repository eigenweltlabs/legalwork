import { expect, test } from "bun:test";
import type { WikiVault } from "@legalwork/types/wiki";
import { createPanelTabStore, workspacePanelKey } from "../src/react-app/domains/session/panel/panel-tab-store";
import { openSavedView } from "../src/react-app/domains/views/view-navigation";
import { viewPanelTab } from "../src/react-app/domains/views/view-reference";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const baseUrl = "https://local.example";
const localServer = { baseUrl, token: "test" };
const project: RouteWorkspace = { id: "target", name: "Target", path: "/target", workspaceType: "local", displayNameResolved: "Target" };
const view = { id: "00000000-0000-4000-8000-000000000001", title: "Saved dashboard", owner: { kind: "workspace", id: project.id } } satisfies Parameters<typeof openSavedView>[0]["view"];
const wiki: WikiVault = { id: "wiki-id", workspaceId: "wiki-workspace", name: "Wiki", root: "/wiki", allowInProjects: true, sync: null, writable: false, pageCount: 0, totalBytes: 0, syncStatus: { state: "local", lastSyncedAt: null, error: null, conflicts: [] } };
const client = { baseUrl, listWikis: async () => ({ items: [wiki] }) };

function createTestPanelTabStore() {
  // Exercise persistence without inheriting or overwriting another test's tabs.
  const data = new Map<string, string>();
  return createPanelTabStore(() => ({
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: key => { data.delete(key); },
  }));
}

test("restored project dashboards reconnect after a desktop port change without replacing remote or unknown owners", () => {
  const store = createTestPanelTabStore();
  const previousUrl = "http://127.0.0.1:4001", currentUrl = "http://127.0.0.1:4002";
  const saved = viewPanelTab(previousUrl, { owner: view.owner, viewId: view.id }, view.title);
  const remote = viewPanelTab("https://remote.example", saved, "Remote dashboard");
  const unknown = viewPanelTab(previousUrl, { ...saved, owner: { kind: "workspace", id: "unavailable" } }, "Unavailable");
  const wikiView = viewPanelTab(previousUrl, { ...saved, owner: { kind: "wiki", id: project.id } }, "Different owner");
  const scope = workspacePanelKey(project.id);
  for (const tab of [remote, unknown, wikiView]) store.getState().openTab(scope, tab, "main");
  store.getState().openTab(scope, saved, "main", "right");
  const restored = store.getState().readLayout(JSON.parse(JSON.stringify(store.getState().sessions[scope])));
  if (!restored) throw new Error("Expected restored dashboard tabs");
  store.setState({ sessions: { [scope]: restored } });
  store.getState().reconnectLocalTabs(currentUrl, [], [project.id]);
  const result = store.getState().sessions[scope];
  const reconnected = viewPanelTab(currentUrl, saved, saved.label);
  expect(result.tabs).toEqual([remote, unknown, wikiView, reconnected]);
  expect(result.tree).toEqual(restored.tree);
  expect(result.sizes).toEqual(restored.sizes);
  expect(result.focusedPaneId).toBe(restored.focusedPaneId);
  expect(result.activeTabId).toBe(restored.activeTabId);
  expect(result.sideActiveTabId).toBe(reconnected.id);
  expect(result.panes.find(pane => pane.id === result.focusedPaneId)?.activeTabId).toBe(reconnected.id);
  expect(result.panes.some(pane => pane.tabIds.includes(saved.id))).toBe(false);
  store.getState().reconnectLocalTabs(currentUrl, [], [project.id]);
  expect(store.getState().sessions[scope]).toBe(result);
  store.getState().reconnectLocalTabs("https://another.example", [project.id], [project.id]);
  expect(store.getState().sessions[scope]).toBe(result);
});

test("Open selects the saved file in its project, preserving the current workspace and migrating legacy tabs first", async () => {
  const store = createTestPanelTabStore();
  const source = { ...view, id: "source", owner: { kind: "workspace", id: "source" } } satisfies Parameters<typeof openSavedView>[0]["view"];
  store.getState().openTab(workspacePanelKey("source"), viewPanelTab(baseUrl, { owner: source.owner, viewId: source.id }));
  const before = store.getState().sessions[workspacePanelKey("source")];
  store.getState().openTab(`project:${project.id}`, { id: "old", type: "view", owner: view.owner, viewId: "old", serverUrl: baseUrl, label: "Old tab" });

  expect(await openSavedView({ client, view, workspaces: [project], localServer, panels: store.getState() })).toBe("/workspace/target/session?view=workspace");
  const target = store.getState().sessions[workspacePanelKey(project.id)];
  const tab = viewPanelTab(baseUrl, { owner: view.owner, viewId: view.id }, view.title);
  expect(target.tabs).toContainEqual(tab);
  expect(target.activeTabId).toBe(tab.id);
  expect(target.panes.some(pane => pane.activeTabId === tab.id)).toBe(true);
  expect(store.getState().sessions[`project:${project.id}`]).toBeUndefined();
  expect(store.getState().sessions[workspacePanelKey("source")]).toBe(before);
  await openSavedView({ client, view, workspaces: [project], localServer, panels: store.getState() });
  expect(store.getState().sessions[workspacePanelKey(project.id)].tabs.filter(item => item.id === tab.id)).toHaveLength(1);
});

test("Open resolves the wiki workspace ID and supports a wiki that is now read-only", async () => {
  const store = createTestPanelTabStore();
  const saved = { ...view, owner: { kind: "wiki", id: wiki.id } } satisfies Parameters<typeof openSavedView>[0]["view"];
  expect(await openSavedView({ client, view: saved, workspaces: [], localServer, panels: store.getState() })).toBe("/wikis/wiki-workspace");
  expect(store.getState().sessions[workspacePanelKey(wiki.workspaceId)].tabs).toEqual([viewPanelTab(baseUrl, { owner: saved.owner, viewId: saved.id }, saved.title)]);
  expect(store.getState().sessions[workspacePanelKey(wiki.id)]).toBeUndefined();
});

test("retired remote projects stay inactive and manual server selection retains dashboard ownership", async () => {
  const store = createTestPanelTabStore();
  const remote: RouteWorkspace = { ...project, id: "rem_target", workspaceType: "remote", legalworkWorkspaceId: project.id, baseUrl: "https://remote.example", legalworkToken: "remote" };
  const remoteClient = { ...client, baseUrl: remote.baseUrl! };
  expect(await openSavedView({ client: remoteClient, view, workspaces: [project], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState().sessions).toEqual({});
  expect(await openSavedView({ client: remoteClient, view, workspaces: [project, remote], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState().sessions).toEqual({});
  const selectedServer = { baseUrl: remoteClient.baseUrl, token: "selected-server" };
  expect(await openSavedView({ client: remoteClient, view, workspaces: [project, remote], localServer: selectedServer, panels: store.getState() })).toBe("/workspace/target/session?view=workspace");
  expect(store.getState().sessions[workspacePanelKey(project.id)].tabs[0]).toMatchObject({ serverUrl: remoteClient.baseUrl, owner: view.owner });
  expect(store.getState().sessions[workspacePanelKey(remote.id)]).toBeUndefined();
});

test("unavailable destinations or failed wiki lookup leave the current tabs untouched", async () => {
  const store = createTestPanelTabStore();
  store.getState().openTab(workspacePanelKey(project.id), viewPanelTab(baseUrl, { owner: view.owner, viewId: view.id }, view.title));
  const before = store.getState();
  const saved = { ...view, owner: { kind: "wiki", id: "missing" } } satisfies Parameters<typeof openSavedView>[0]["view"];
  expect(await openSavedView({ client, view, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState()).toBe(before);
  expect(await openSavedView({ client, view: saved, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState()).toBe(before);
  expect(await openSavedView({ client: { ...client, baseUrl: "https://remote.example" }, view: { ...saved, owner: { kind: "wiki", id: wiki.id } }, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState()).toBe(before);
  await expect(openSavedView({ client: { ...client, listWikis: async () => { throw new Error("Disconnected"); } }, view: saved, workspaces: [], localServer, panels: store.getState() })).rejects.toThrow("Disconnected");
  expect(store.getState()).toBe(before);
});
