import { expect, test } from "bun:test";
import { mergeRouteWorkspaces, preferLoadedSession, resolveRouteWorkspaceId, type RouteSession, type RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const project = (id: string, path = `C:\\Projects\\${id}`): RouteWorkspace => ({
  id, path, name: id, displayNameResolved: id, workspaceType: "local", preset: "starter",
});

test("a server refresh cannot resurrect a local project removed on sign-out", () => {
  const live = project("live");
  const removed = project("removed");
  const merged = mergeRouteWorkspaces([live], [removed, live]);
  expect(merged.map((workspace) => workspace.id)).toEqual(["live"]);
  expect(resolveRouteWorkspaceId(merged, [removed.id, removed.id, live.id])).toBe(live.id);
});

test("an empty authoritative registry does not reuse saved local IDs", () => {
  const removed = project("removed");
  const merged = mergeRouteWorkspaces([], [removed]);
  expect(merged).toEqual([]);
  expect(resolveRouteWorkspaceId(merged, [removed.id])).toBe("");
});

test("a migrated ID follows the matching path before falling back to the first project", () => {
  const saved = project("old", "C:\\Projects\\My Project");
  const canonical = project("canonical", saved.path);
  const merged = mergeRouteWorkspaces([project("first"), canonical], [saved]);
  expect(resolveRouteWorkspaceId(merged, [saved.id], [saved])).toBe(canonical.id);
});

test("the server registry owns routing when desktop state has an old engine URL", () => {
  const server = project("same");
  const desktop = { ...server, baseUrl: "https://obsolete-engine.example" };
  const merged = mergeRouteWorkspaces([server], [desktop]);
  expect(merged).toEqual([server]);
  expect(resolveRouteWorkspaceId(merged, [server.id])).toBe(server.id);
});

const chat = (id: string, updated: number): RouteSession => ({ id, slug: id, projectID: "project", directory: "/project", title: id, version: "1", time: { created: 1, updated } });
test("runtime data cannot put a deleted conversation back in the authoritative list", () => {
  expect(preferLoadedSession([chat("remaining", 1)], chat("deleted", 3)).map(item => item.id)).toEqual(["remaining"]);
  expect(preferLoadedSession([], chat("deleted", 3))).toEqual([]);
});
test("runtime titles stay current without overriding newer fetched data", () => {
  const loaded = { ...chat("open", 3), title: "New title" };
  expect(preferLoadedSession([chat("open", 1)], loaded)[0]).toEqual(loaded);
  expect(preferLoadedSession([chat("open", 4)], loaded)[0].time.updated).toBe(4);
});
