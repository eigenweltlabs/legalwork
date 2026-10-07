import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolveProjectFolder } from "./project-file-copy.mjs";

// Caller directories come from the agent's execution context, never from page content.
// Resolve them against registered projects before binding a tab's download destination.
export async function resolveBrowserProject(context, state, server) {
  if (context?.workspaceId) return realpath(await resolveProjectFolder(context.workspaceId, state.workspaces, server));
  const directory = context?.directory;
  if (!directory) {
    const selected = state.workspaces.find((entry) => entry.id === state.selectedId);
    if (!selected || selected.workspaceType === "remote" || !selected.path) return null;
    return realpath(selected.path);
  }
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("Browser project directory must be absolute.");
  const requested = await realpath(directory);
  async function match(workspaces) {
    for (const workspace of workspaces) {
      if (workspace.workspaceType === "remote" || typeof workspace.path !== "string") continue;
      const root = await realpath(workspace.path).catch(() => null);
      if (root === requested) return root;
    }
    return null;
  }
  const desktop = await match(state.workspaces);
  if (desktop) return desktop;
  const token = server.ownerToken || server.clientToken;
  if (server.running && server.baseUrl && token) {
    const response = await fetch(`${server.baseUrl.replace(/\/+$/, "")}/workspaces`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Could not resolve the browser's project.");
    const list = await response.json();
    if (Array.isArray(list.items)) {
      const project = await match(list.items.filter((entry) => entry?.workspaceType === "local"));
      if (project) return project;
    }
  }
  throw new Error("The browser's project is not registered locally. Open a local project before browsing from this session.");
}
