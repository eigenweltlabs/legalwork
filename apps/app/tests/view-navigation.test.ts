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

test("Open selects the saved file in its project, preserving the current workspace and migrating legacy tabs first", async () => {
  const store = createPanelTabStore();
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
  const store = createPanelTabStore();
  const saved = { ...view, owner: { kind: "wiki", id: wiki.id } } satisfies Parameters<typeof openSavedView>[0]["view"];
  expect(await openSavedView({ client, view: saved, workspaces: [], localServer, panels: store.getState() })).toBe("/wikis/wiki-workspace");
  expect(store.getState().sessions[workspacePanelKey(wiki.workspaceId)].tabs).toEqual([viewPanelTab(baseUrl, { owner: saved.owner, viewId: saved.id }, saved.title)]);
  expect(store.getState().sessions[workspacePanelKey(wiki.id)]).toBeUndefined();
});

test("remote projects use their UI route ID and cannot open a same-ID project on another server", async () => {
  const store = createPanelTabStore();
  const remote: RouteWorkspace = { ...project, id: "rem_target", workspaceType: "remote", legalworkWorkspaceId: project.id, baseUrl: "https://remote.example", legalworkToken: "remote" };
  const remoteClient = { ...client, baseUrl: remote.baseUrl! };
  expect(await openSavedView({ client: remoteClient, view, workspaces: [project], localServer, panels: store.getState() })).toBeNull();
  expect(store.getState().sessions).toEqual({});
  expect(await openSavedView({ client: remoteClient, view, workspaces: [project, remote], localServer, panels: store.getState() })).toBe("/workspace/rem_target/session?view=workspace");
  expect(store.getState().sessions[workspacePanelKey(remote.id)].tabs[0]).toMatchObject({ serverUrl: remoteClient.baseUrl, owner: view.owner });
});

test("unavailable destinations or failed wiki lookup leave the current tabs untouched", async () => {
  const store = createPanelTabStore();
  const saved = { ...view, owner: { kind: "wiki", id: "missing" } } satisfies Parameters<typeof openSavedView>[0]["view"];
  expect(await openSavedView({ client, view, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  expect(await openSavedView({ client, view: saved, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  expect(await openSavedView({ client: { ...client, baseUrl: "https://remote.example" }, view: { ...saved, owner: { kind: "wiki", id: wiki.id } }, workspaces: [], localServer, panels: store.getState() })).toBeNull();
  await expect(openSavedView({ client: { ...client, listWikis: async () => { throw new Error("Disconnected"); } }, view: saved, workspaces: [], localServer, panels: store.getState() })).rejects.toThrow("Disconnected");
  expect(store.getState().sessions).toEqual({});
});
