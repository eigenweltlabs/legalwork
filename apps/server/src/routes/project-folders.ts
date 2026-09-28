import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProjectRemoteFolder, ProjectRemoteFolderStatus } from "@legalwork/types/workspace";
import { ApiError } from "../errors.js";
import { captureFolder, connectionFingerprint, ProjectFolderBindings, projectFolderScopes } from "../file-storage/project-folders.js";
import { withStorage } from "../file-storage/service.js";
import { providerError } from "../file-storage/common.js";
import type { StorageOAuth } from "../file-storage/oauth/session.js";
import type { StoredStorage } from "../file-storage/store.js";
import { readProjectDetails, updateProjectRemote } from "../project-store.js";
import { renameRegisteredWorkspace } from "./workspaces.js";
import type { ServerConfig, WorkspaceInfo, TokenScope } from "../types.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";

const selections = z.array(z.object({ sourceWorkspaceId: z.string().min(1), connectionId: z.string().min(1), path: z.string().max(4096) }).strict()).max(30);
export type PreparedProjectFolders = { location: ProjectRemoteFolder; sourceWorkspaceId: string }[];
export function registerProjectFolderRoutes(options: {
  routes: Route[]; config: ServerConfig; storagePath: string; oauth: StorageOAuth;
  lookup: (workspaceId: string, id: string) => Promise<StoredStorage>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  onChanged?: (workspaceId: string) => Promise<void>;
  onRenamed?: (workspaceId: string, name: string) => Promise<void>;
}) {
  const { config, routes, resolveWorkspace, lookup, oauth, jsonResponse } = options;
  const bindings = new ProjectFolderBindings(options.storagePath);
  const enabled = (item: StoredStorage) => {
    if (!item.enabled || item.team?.installed === false)
      throw new ApiError(409, "storage_disconnected", "Enable or install this connection in File storage settings.");
  };
  const prepare = async (input: unknown): Promise<PreparedProjectFolders> => {
    const parsed = selections.safeParse(input ?? []);
    if (!parsed.success) throw new ApiError(400, "invalid_project_folders", "Choose up to 30 remote folders.");
    const result: PreparedProjectFolders = [];
    for (const selection of parsed.data) {
      await resolveWorkspace(config, selection.sourceWorkspaceId);
      const item = await lookup(selection.sourceWorkspaceId, selection.connectionId);
      enabled(item);
      oauth.bind(selection.sourceWorkspaceId, item.id, item);
      const folder = await withStorage(item, (adapter) => captureFolder(adapter, selection.path, item.name));
      if (result.some(({ location }) => location.connectionId === item.id && location.folder.path === folder.path)) continue;
      result.push({ sourceWorkspaceId: selection.sourceWorkspaceId, location: {
        id: randomUUID(), connectionId: item.id, connectionName: item.name,
        ...(item.team ? { organizationId: item.team.orgId } : {}),
        connectionFingerprint: connectionFingerprint(item), folder,
      } });
    }
    return result;
  };
  const attach = async (workspace: WorkspaceInfo, prepared: PreparedProjectFolders, initialize = false, revision?: number) => {
    const details = await readProjectDetails(workspace.path);
    const remote = details.remote ?? { version: 1, folders: [], context: "", initialization: "none" };
    const folders = [...remote.folders];
    for (const value of prepared) {
      const existing = folders.find((folder) => folder.connectionId === value.location.connectionId && folder.connectionFingerprint === value.location.connectionFingerprint && (folder.folder.id ? folder.folder.id === value.location.folder.id : folder.folder.path === value.location.folder.path));
      const location = existing ?? value.location;
      await bindings.save(workspace.id, location, value.sourceWorkspaceId);
      if (!existing) folders.push(location);
    }
    const saved = await updateProjectRemote(workspace.path, { ...remote, folders, initialization: initialize ? "pending" : remote.initialization }, revision ?? details.revision);
    await options.onChanged?.(workspace.id);
    return saved;
  };
  const selected = async (workspaceId: string, id: string) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    const details = await readProjectDetails(workspace.path);
    const location = details.remote?.folders.find((folder) => `project:${folder.id}` === id);
    if (!location) throw new ApiError(404, "storage_not_found", "This folder is no longer linked to the project.");
    const boundSource = await bindings.source(workspaceId, location);
    // Personal references have no authority on another member's computer. Team references
    // resolve only through that member's current subscription and installation permissions.
    if (!boundSource && !location.organizationId)
      throw new ApiError(409, "storage_disconnected", "This personal connection is not linked on this computer. Link an accessible folder or use a team connection.");
    let source = boundSource ?? workspaceId;
    if (!boundSource && location.organizationId) {
      // A shared connection already installed and signed in on this member's machine
      // can be reused by stable team identity, without sharing a local OAuth grant.
      for (const candidate of new Set([workspaceId, ...config.workspaces.filter((workspace) => workspace.workspaceType === "local").map((workspace) => workspace.id)])) {
        const available = await lookup(candidate, location.connectionId).catch(() => null);
        if (!available || !available.enabled || available.team?.installed === false || available.team?.orgId !== location.organizationId || connectionFingerprint(available) !== location.connectionFingerprint) continue;
        if (available.config.kind === "oauth" && !(await oauth.status(oauth.key(candidate, available.id, available))).connected) continue;
        source = candidate;
        break;
      }
    }
    const item = await lookup(source, location.connectionId).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404)
        throw new ApiError(409, "storage_disconnected", "This connection is unavailable. Reconnect it in File storage settings.");
      throw error;
    });
    enabled(item);
    if (location.organizationId !== item.team?.orgId || location.connectionFingerprint !== connectionFingerprint(item))
      throw new ApiError(409, "storage_namespace_changed", "This connection's account or root changed. Relink the folder to confirm its location.");
    oauth.bind(source, item.id, item);
    projectFolderScopes.set(item, location.folder);
    return item;
  };
  const statuses = async (workspace: WorkspaceInfo): Promise<ProjectRemoteFolderStatus[]> => {
    const details = await readProjectDetails(workspace.path);
    return Promise.all((details.remote?.folders ?? []).map(async (location): Promise<ProjectRemoteFolderStatus> => {
      const connectionId = `project:${location.id}`;
      try {
        const item = await selected(workspace.id, connectionId);
        const capabilities = await withStorage(item, async (adapter) => {
          await adapter.list("");
          return adapter.searchCapabilities?.();
        });
        const limitations = ["Search uses the source's permissions and may omit unsupported or unsearchable content."];
        if (!capabilities?.modes.includes("content")) limitations.push("No provider content search. Browse or search filenames, then read relevant documents.");
        if (capabilities?.scope === "folder") limitations.push("Provider search covers one folder at a time; browse subfolders separately.");
        if (!location.folder.id) limitations.push("Path-based link: relink if this folder is moved or renamed.");
        return { location, connectionId, status: "available", limitations };
      } catch (error) {
        const failure = providerError(error);
        return { location, connectionId, status: failure.status === 404 ? "missing" : failure.status === 403 ? "denied" : "disconnected", error: failure.message, limitations: [] };
      }
    }));
  };
  const base = "/workspace/:id/project/remote-folders";
  addRoute(routes, "GET", base, "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const details = await readProjectDetails(workspace.path);
    return jsonResponse({ revision: details.revision, context: details.remote?.context ?? "", initialization: details.remote?.initialization ?? "none", folders: await statuses(workspace) });
  });
  addRoute(routes, "POST", base, "host", async (ctx) => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const body = await options.readJsonBodyLimited(ctx.request, 128 * 1024);
    const revision = z.number().int().nonnegative().parse(body.revision);
    const prepared = await prepare(body.folders);
    return jsonResponse(await attach(await resolveWorkspace(config, ctx.params.id), prepared, false, revision));
  });
  addRoute(routes, "DELETE", `${base}/:folderId`, "host", async (ctx) => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const body = await options.readJsonBodyLimited(ctx.request, 1024);
    const revision = z.number().int().nonnegative().parse(body.revision);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const details = await readProjectDetails(workspace.path);
    if (!details.remote) return jsonResponse(details);
    const saved = await updateProjectRemote(workspace.path, { ...details.remote, folders: details.remote.folders.filter((folder) => folder.id !== ctx.params.folderId) }, revision);
    await options.onChanged?.(workspace.id);
    return jsonResponse(saved);
  });
  addRoute(routes, "GET", "/workspace/:id/project/context", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const details = await readProjectDetails(workspace.path);
    return jsonResponse({
      projectId: workspace.id, name: workspace.displayName?.trim() || workspace.name,
      revision: details.revision, fields: details.fields,
      localFolder: workspace.path,
      context: details.remote?.context ?? "", initialization: details.remote?.initialization ?? "none",
      remote: details.remote ?? null,
    });
  });
  addRoute(routes, "PATCH", "/workspace/:id/project/context", "client", async (ctx) => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const body = z.object({ revision: z.number().int().nonnegative(), context: z.string().trim().min(1).max(24000), name: z.string().trim().min(1).max(120).optional() }).strict().parse(await options.readJsonBodyLimited(ctx.request, 128 * 1024));
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const details = await readProjectDetails(workspace.path);
    const remote = details.remote ?? { version: 1, folders: [], context: "", initialization: "none" };
    const saved = await updateProjectRemote(workspace.path, { ...remote, context: body.context, initialization: "ready" }, body.revision);
    if (body.name) {
      await renameRegisteredWorkspace(config, workspace.id, body.name);
      await options.onRenamed?.(workspace.id, body.name);
    }
    await options.onChanged?.(workspace.id);
    return jsonResponse(saved);
  });
  return { prepare, attach, selected };
}
