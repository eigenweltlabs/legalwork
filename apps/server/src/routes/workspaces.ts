import type { registerProjectFolderRoutes } from "./project-folders.js";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { withFileWriteLock } from "../file-write-lock.js";
import { recordAudit } from "../audit.js";
import { readProjectTemplates, saveProjectTemplates, localizeProjectTemplates, projectFieldsFromTemplate } from "../project-templates.js";
import { ApiError } from "../errors.js";
import { inheritWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ProjectField } from "@legalwork/types/workspace";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { ensureDir, exists, shortId } from "../utils.js";
import { ensureWorkspaceFiles } from "../workspace-init.js";
import { workspaceIdForPath } from "../workspaces.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { initializeProjectFields, parseProjectFields, createDefaultProjectFolder, defaultProjectRoot, readProjectDetails, updateProjectDetails, updateProjectFieldValues } from "../project-store.js";
import { WikiStore } from "../wiki/store.js";
import { revokeWikiProjectEverywhere } from "../wiki/project-access.js";
import { assertProjectFolderIndependent } from "../wiki/workspace-safety.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;

interface RegisterWorkspaceRoutesOptions {
  projectFolders?: ReturnType<typeof registerProjectFolderRoutes>;
  routes: Route[];
  config: ServerConfig;
  onWorkspacesChanged: () => void;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  readOptionalJsonBody: ReadJsonBody;
  parseOptionalBoolean: ParseOptionalBoolean;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  serializeWorkspace: (workspace: ServerConfig["workspaces"][number]) => unknown;
  /** Project sync (project-sync.ts) hears about local edits it has to carry to the firm. */
  onProjectDetailsSaved: (workspaceId: string, before: ProjectField[], after: ProjectField[]) => Promise<void>;
  onProjectRenamed: (workspaceId: string, name: string) => Promise<void>;
  onProjectRemoved: (workspaceId: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

async function readServerConfigFile(configPath: string): Promise<Record<string, unknown>> {
  if (!(await exists(configPath))) {
    return {};
  }

  try {
    const raw = await readFile(configPath, "utf8");
    return ensurePlainObject(JSON.parse(raw));
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }
}

function serializeWorkspaceConfigEntry(workspace: WorkspaceInfo): Record<string, unknown> {
  return {
    id: workspace.id, path: workspace.path, name: workspace.name,
    preset: workspace.preset, workspaceType: "local",
    ...(workspace.displayName ? { displayName: workspace.displayName } : {}),
    ...(workspace.sandboxBackend ? { sandboxBackend: workspace.sandboxBackend } : {}),
    ...(workspace.sandboxRunId ? { sandboxRunId: workspace.sandboxRunId } : {}),
    ...(workspace.sandboxContainerName ? { sandboxContainerName: workspace.sandboxContainerName } : {}),
  };
}

export async function persistServerWorkspaceState(config: ServerConfig): Promise<boolean> {
  const configPath = config.configPath?.trim() ?? "";
  if (!configPath) return false;

  return withFileWriteLock(configPath, async () => {
    const parsed = await readServerConfigFile(configPath);
    const next = {
      ...parsed,
      workspaces: [
        ...config.workspaces.map(serializeWorkspaceConfigEntry),
        ...(Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(entry => isRecord(entry) && entry.workspaceType === "remote") : []),
      ],
      authorizedRoots: Array.from(new Set(config.authorizedRoots.map((root) => resolve(root)))),
    };

    await ensureDir(dirname(configPath));
    const tmpPath = `${configPath}.tmp.${shortId()}`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tmpPath, configPath);
      return true;
    } finally {
      try {
        await rm(tmpPath);
      } catch {
        // ignore
      }
    }
  });
}

/**
 * Register a local project folder and persist the registry. New projects the
 * user creates come first; projects arriving through sync are added last, so
 * they never take over the active project.
 */
export async function registerLocalProject(
  config: ServerConfig,
  input: {
    folderPath: string;
    name: string;
    preset: string;
    projectFields?: ReturnType<typeof parseProjectFields> | null;
    position?: "first" | "last";
  },
): Promise<{ workspace: WorkspaceInfo; persisted: boolean }> {
  const workspacePath = resolve(input.folderPath);
  await assertProjectFolderIndependent(workspacePath, await new WikiStore(config).list());
  await ensureDir(workspacePath);
  await ensureWorkspaceFiles(workspacePath, input.preset, { bundledCore: config.engineConfigurationMode !== "managed" });
  if (input.projectFields) await initializeProjectFields(workspacePath, input.projectFields);

  const workspace: WorkspaceInfo = {
    id: workspaceIdForPath(workspacePath),
    name: input.name,
    path: workspacePath,
    preset: input.preset,
    workspaceType: "local",
    ...inheritWorkspaceOpencodeConnection(config),
  };
  const previous = config.workspaces.find(entry => entry.id === workspace.id);
  if (previous && (previous.workspaceType !== workspace.workspaceType || (previous.directory || previous.path) !== workspace.path)) revokeWikiProjectEverywhere(config, workspace.id);
  const others = config.workspaces.filter((entry) => entry.id !== workspace.id);
  config.workspaces = input.position === "last" ? [...others, workspace] : [workspace, ...others];
  if (!config.authorizedRoots.some((root) => resolve(root) === workspacePath)) {
    config.authorizedRoots = [...config.authorizedRoots, workspacePath];
  }
  return { workspace, persisted: await persistServerWorkspaceState(config) };
}

/** Change a workspace's display name and persist the registry; false when there is no such workspace. */
export async function renameRegisteredWorkspace(config: ServerConfig, id: string, displayName: string | undefined): Promise<boolean> {
  if (!config.workspaces.some((entry) => entry.id === id)) return false;
  config.workspaces = config.workspaces.map((entry) =>
    entry.id === id ? { ...entry, displayName, name: displayName ?? entry.name } : entry,
  );
  await persistServerWorkspaceState(config);
  return true;
}

/** Take a workspace out of the registry (its folder stays) and persist it. */
export async function unregisterWorkspace(config: ServerConfig, workspace: WorkspaceInfo): Promise<{ deleted: boolean; persisted: boolean }> {
  const before = config.workspaces.length;
  revokeWikiProjectEverywhere(config, workspace.id);
  config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
  const deleted = before !== config.workspaces.length;
  if (deleted && workspace.workspaceType === "local") {
    // Only remove exact matches; authorizedRoots can contain broader entries.
    config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
  }
  return { deleted, persisted: await persistServerWorkspaceState(config) };
}

export function registerWorkspaceRoutes(options: RegisterWorkspaceRoutesOptions): void {
  const {
    routes,
    config,
    onWorkspacesChanged,
    jsonResponse,
    readJsonBody,
    readJsonBodyLimited,
    requireClientScope,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    resolveWorkspace,
    serializeWorkspace,
    onProjectDetailsSaved,
    onProjectRenamed,
    onProjectRemoved,
  } = options;

  const registeredWorkspace = (id: string): WorkspaceInfo => {
    const workspaceId = id.trim();
    const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
    const workspace =
      config.workspaces.find((entry) => entry.id === workspaceId) ??
      (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
    if (!workspace) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found");
    }
    return workspace;
  };
  const resolveWorkspaceForRegistry = async (id: string): Promise<WorkspaceInfo> => {
    const workspace = registeredWorkspace(id);
    return resolveWorkspace(config, id);
  };

  addRoute(routes, "POST", "/workspaces/remote", "host", () => {
    throw new ApiError(410, "remote_workspaces_retired", "Remote agent workspaces are no longer supported. Saved connection settings remain preserved in their original configuration.");
  });

  // Native folder picker, provided by the desktop app hosting the server.
  // The Office task pane's webview cannot open OS dialogs itself, so it asks
  // the server (running inside the desktop app) to show one. Standalone
  // servers report supported: false and clients fall back to a typed path.
  addRoute(routes, "POST", "/workspaces/pick-folder", "host", async (ctx) => {
    const picker = config.pickDirectory;
    if (!picker) {
      return jsonResponse({ supported: false, path: null });
    }
    const body = await readOptionalJsonBody(ctx.request);
    const title = readStringField(body, "title") || undefined;
    const defaultPath = readStringField(body, "defaultPath") || undefined;
    const returnFocusTo = readStringField(body, "returnFocusTo") || undefined;
    const path = await picker({ title, defaultPath, returnFocusTo });
    return jsonResponse({ supported: true, path: path ?? null });
  });

  addRoute(routes, "GET", "/workspaces/project-defaults", "host", async () => {
    return jsonResponse({ folderPath: defaultProjectRoot(config.projectsDirectory) });
  });

  addRoute(routes, "GET", "/workspaces/project-templates", "client", async (ctx) => {
    const language = new URL(ctx.request.url).searchParams.get("language") === "de" ? "de" : "en";
    return jsonResponse(localizeProjectTemplates(await readProjectTemplates(config), language));
  });

  addRoute(routes, "PUT", "/workspaces/project-templates", "host", async (ctx) => {
    ensureWritable(config);
    return jsonResponse(await saveProjectTemplates(config, await readJsonBodyLimited(ctx.request, 2 * 1024 * 1024)));
  });

  addRoute(routes, "GET", "/workspace/:id/project", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await readProjectDetails(workspace.path));
  });

  addRoute(routes, "PATCH", "/workspace/:id/project", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireClientScope(ctx, "collaborator");
    const before = await readProjectDetails(workspace.path);
    const updated = await updateProjectDetails(workspace.path, await readJsonBodyLimited(ctx.request, 512 * 1024));
    await onProjectDetailsSaved(workspace.id, before.fields, updated.fields);
    return jsonResponse(updated);
  });

  addRoute(routes, "PATCH", "/workspace/:id/project/metadata", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const before = await readProjectDetails(workspace.path);
    const updated = await updateProjectFieldValues(workspace.path, await readJsonBodyLimited(ctx.request, 256 * 1024));
    await onProjectDetailsSaved(workspace.id, before.fields, updated.fields);
    return jsonResponse(updated);
  });

  const createLocalWorkspace = async (ctx: RequestContext, newProjectOnly = false) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    if (newProjectOnly) {
      requireClientScope(ctx, "collaborator");
      if (Object.keys(body).some((key) => !["name", "templateId", "templateLanguage", "projectFields"].includes(key)))
        throw new ApiError(400, "invalid_payload", "This endpoint creates a new project folder. Only name, templateId, templateLanguage and projectFields are supported.");
      body.folderMode = "default";
      body.preset = "starter";
    }
    const preparedFolders = await options.projectFolders?.prepare(body.remoteFolders, ctx);
    if (body.fromRemoteFolder && !preparedFolders?.length) throw new ApiError(400, "project_folder_required", "Select a remote folder first.");
    if (body.projectFields !== undefined && body.templateId !== undefined)
      throw new ApiError(400, "invalid_project_template", "Choose either a template or explicit fields.");
    const projectFields = body.projectFields === undefined
      ? await projectFieldsFromTemplate(config, body) : parseProjectFields(body.projectFields);
    let folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
    const initializeFromFolders = body.initializeFromFolders === true || body.fromRemoteFolder === true;
    if (initializeFromFolders && !folderPath && !preparedFolders?.length)
      throw new ApiError(400, "project_folder_required", "Choose a local or remote folder with existing project files first.");
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : basename(folderPath || "Workspace");
    const preset = typeof body.preset === "string" && body.preset.trim() ? body.preset.trim() : "starter";

    if (body.folderMode === "default") {
      if (folderPath || !readStringField(body, "name")) throw new ApiError(400, "invalid_payload", "A default-folder project needs a name and no selected path.");
      try {
        folderPath = await createDefaultProjectFolder(name, defaultProjectRoot(config.projectsDirectory));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(422, "project_folder_unavailable", "The project folder could not be created. Check folder access or choose your own folder.");
      }
    }
    if (!folderPath) {
      throw new ApiError(400, "invalid_payload", "folderPath is required");
    }

    const { workspace, persisted } = await registerLocalProject(config, { folderPath, name, preset, projectFields });
    if (preparedFolders?.length || initializeFromFolders)
      await options.projectFolders?.attach(workspace, preparedFolders ?? [], initializeFromFolders);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.create",
      target: workspace.path,
      summary: `Created workspace ${name}`,
      timestamp: Date.now(),
    });

    if (newProjectOnly) return jsonResponse({
      activeId: workspace.id,
      project: { id: workspace.id, name: workspace.name, localFolder: workspace.path, ...await readProjectDetails(workspace.path) },
      persisted,
    }, 201);
    return jsonResponse({
      activeId: workspace.id,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    }, 201);
  };
  addRoute(routes, "POST", "/workspaces/local", "host", (ctx) => createLocalWorkspace(ctx));
  // Agents can create a fresh project using collaborator permissions, without host folder-registration access.
  addRoute(routes, "POST", "/workspaces/projects", "client", (ctx) => createLocalWorkspace(ctx, true));

  addRoute(routes, "PATCH", "/workspaces/:id/display-name", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspaceForRegistry(ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const nextDisplayName = typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : undefined;

    const persisted = await renameRegisteredWorkspace(config, workspace.id, nextDisplayName);
    onWorkspacesChanged();
    if (nextDisplayName) await onProjectRenamed(workspace.id, nextDisplayName);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.rename",
      target: workspace.path || workspace.baseUrl || "workspace",
      summary: `Updated workspace display name${nextDisplayName ? ` to ${nextDisplayName}` : ""}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: config.workspaces[0]?.id ?? null,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspaceForRegistry(ctx.params.id);
    // Validate the original folder before bootstrap, so a disconnected project
    // is not replaced by an empty one.
    if (workspace.workspaceType === "local") await resolveWorkspace(config, workspace.id);
    const queryPersist = parseOptionalBoolean(ctx.url.searchParams.get("persist"), "persist");
    const body = queryPersist === undefined ? await readOptionalJsonBody(ctx.request) : {};
    const persist = queryPersist ?? (body.persist === true);
    if (persist) ensureWritable(config);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];
    const persisted = persist ? await persistServerWorkspaceState(config) : false;
    if (persist) onWorkspacesChanged();
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    // Activation is navigation. Disposing this instance would abort delegated
    // or scheduled work already running here. Configuration changes use the
    // separate reload coordinator and explicit engine reload endpoint.
    return jsonResponse({ activeId: workspace.id, workspace: serializeWorkspace(workspace), persisted });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    // Removing a registration does not read or change its folder. It must
    // remain possible when a drive is disconnected or the folder was moved.
    const workspace = registeredWorkspace(ctx.params.id);

    if (workspace.preset === "main-assistant") throw new ApiError(400, "assistant_required", "The main assistant cannot be removed from the project registry.");
    const { deleted, persisted } = await unregisterWorkspace(config, workspace);
    onWorkspacesChanged();
    if (deleted) await onProjectRemoved(workspace.id);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from LegalWork server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspace),
      workspaces: config.workspaces.map(serializeWorkspace),
    });
  });
}
