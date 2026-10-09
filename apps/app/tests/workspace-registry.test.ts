import { expect, test } from "bun:test";
import { mergeRouteWorkspaces, resolveRouteWorkspaceId, type RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const project = (id: string, path = `C:\\Projects\\${id}`): RouteWorkspace => ({
  id, path, name: id, displayNameResolved: id, workspaceType: "local", preset: "starter",
});

test("a server refresh cannot resurrect a local project removed on sign-out", () => {
  const live = project("live");
  const removed = project("removed");
  const remote: RouteWorkspace = { ...project("remote"), workspaceType: "remote", baseUrl: "https://worker.example.test" };
  const merged = mergeRouteWorkspaces([live], [removed, live, remote]);
  expect(merged.map((workspace) => workspace.id)).toEqual(["live", "remote"]);
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

test("desktop remote routing wins over a stale local registration with the same ID", () => {
  const remote: RouteWorkspace = { ...project("remote"), workspaceType: "remote", remoteType: "legalwork", baseUrl: "https://worker.example.test" };
  const merged = mergeRouteWorkspaces([project("remote")], [remote]);
  expect(merged).toEqual([remote]);
  expect(resolveRouteWorkspaceId(merged, [remote.id])).toBe(remote.id);
});
