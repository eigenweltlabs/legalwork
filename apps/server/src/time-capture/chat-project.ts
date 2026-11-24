import { join, dirname } from "node:path";
import { runtimeDbPath } from "../eigenwelt-connection-store.js";
import { projectHome } from "../project-storage.js";
import { digest } from "./private-workday.js";
import { mkdir, stat } from "node:fs/promises";
import { ApiError } from "../errors.js";
import type { MainAssistant } from "../main-assistant.js";
import { registerLocalProject } from "../routes/workspaces.js";
import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { activeCaptureProfile, timekeepingEnabled, timekeepingPreset } from "./profile.js";
import { z } from "zod";

const opening = new WeakMap<ServerConfig, Map<string, Promise<WorkspaceInfo>>>();

export const timekeepingProjectId = (profileId: string) => "ws_" + digest(["timekeeping", profileId]).slice(0, 32);

export function openTimekeepingProject(config: ServerConfig, profileId: string, changed: () => void) {
  let projects = opening.get(config);
  if (!projects) { projects = new Map(); opening.set(config, projects); }
  const active = projects.get(profileId);
  if (active) return active;
  const next = ensureTimekeepingProject(config, profileId, changed).finally(() => projects.delete(profileId));
  projects.set(profileId, next);
  return next;
}

async function ensureTimekeepingProject(config: ServerConfig, profileId: string, changed: () => void) {
  const preset = timekeepingPreset(profileId);
  const existing = config.workspaces.find(item => item.preset === preset);
  if (existing) {
    if (!(await stat(existing.path).catch(() => null))?.isDirectory())
      throw new ApiError(404, "time_chat_folder", "Restore the Timekeeping project folder to open its chats.");
    return existing;
  }
  const id = timekeepingProjectId(profileId);
  const folderPath = config.projectsDirectory ? join(projectHome(config, id), "files") : join(dirname(runtimeDbPath(config)), "projects", id);
  await mkdir(folderPath, { recursive: true, mode: 0o700 });
  const { workspace } = await registerLocalProject(config, { id, folderPath, name: "Timekeeping", preset, position: "last" });
  changed();
  return workspace;
}

export function registerTimeChatRoutes(config: ServerConfig, routes: Route[], daily: MainAssistant, changed: () => void) {
  async function owner(expected: string | null) {
    const current = await activeCaptureProfile(config);
    if (expected !== current.profileId) throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
    if (!await timekeepingEnabled(current.path)) throw new ApiError(403, "timekeeping_disabled", "Turn on time tracking in Settings.");
    return current;
  }
  for (const method of ["GET", "POST"]) addRoute(routes, method, "/private-timesheet/conversation", "host-token", async ctx => {
    if (ctx.agentAccess || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host))
      throw new ApiError(403, "private_workday", "Open this chat in your local LegalWork app.");
    const { profileId } = await owner(ctx.url.searchParams.get("profileId"));
    if (method === "GET") {
      const workspace = config.workspaces.find(item => item.preset === timekeepingPreset(profileId));
      const params = z.object({ before: z.iso.date().optional(), after: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(31).default(1) }).parse(Object.fromEntries(ctx.url.searchParams));
      return Response.json(workspace ? daily.history(workspace.id, params.before, params.limit, params.after) : { days: [], nextBefore: null }, { headers: { "Cache-Control": "no-store" } });
    }
    if (config.readOnly) throw new ApiError(403, "read_only", "Open this chat on a writable local server.");
    const workspace = await openTimekeepingProject(config, profileId, changed);
    const { day } = await daily.projectDay(workspace);
    await owner(profileId);
    return Response.json({ workspace: { id: workspace.id, name: workspace.name, preset: workspace.preset, workspaceType: "local", path: workspace.path, contentPath: workspace.contentPath }, day }, { headers: { "Cache-Control": "no-store" } });
  });
}
