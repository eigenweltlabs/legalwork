import { open, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { WikiRegistration } from "@legalwork/types/wiki";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { within } from "../agent-sandbox/files.js";
import { authenticateWikiAgentRequest, verifiedWikiSessionOrigin } from "../wiki/agent-access.js";
import { beginWikiProjectApproval, grantWikiProjectAccess, requireWikiProjectAccess, revokeWikiProjectAccess, wikiProjectAccessSignal } from "../wiki/project-access.js";
import type { WikiStore } from "../wiki/store.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

function projectPathError(error: unknown): never {
  if (error instanceof Error && "code" in error) {
    if (["ENOENT", "ENOTDIR"].includes(String(error.code))) throw new ApiError(404, "wiki_project_path_missing", "This project file or folder is unavailable. Refresh the project files.");
    if (["EACCES", "EPERM", "ELOOP"].includes(String(error.code))) throw new ApiError(403, "wiki_project_path_denied", "This project file or folder cannot be read.");
    if (error.code === "ERR_INVALID_ARG_VALUE") throw new ApiError(400, "wiki_project_path_invalid", "Choose a valid project file or folder.");
  }
  throw error;
}

type Options = { routes: Route[]; config: ServerConfig; store: WikiStore; selected: (ctx: RequestContext) => Promise<WikiRegistration>; jsonResponse: (data: unknown) => Response };
export function registerWikiProjectRoutes({ routes, config, store, selected, jsonResponse }: Options) {
  const current = async (ctx: RequestContext) => {
    const wiki = await selected(ctx);
    const workspace = config.workspaces.find(item => item.id === wiki.workspaceId);
    if (!workspace || !ctx.actor) throw new ApiError(403, "wiki_project_access_denied", "This wiki chat is unavailable.");
    const agent = await authenticateWikiAgentRequest(config, ctx.request);
    if (agent && (agent.sessionId !== ctx.params.sessionId || agent.directory !== await realpath(wiki.root)))
      throw new ApiError(403, "wiki_project_session_mismatch", "Use project access only from this wiki's own chat.");
    const scope = ctx.actor.scope ?? "owner";
    const origin = await verifiedWikiSessionOrigin(config, workspace, ctx.params.sessionId, scope, ctx.request.signal);
    if (origin.scope !== scope) throw new ApiError(403, "wiki_project_scope_changed", "Reopen this chat with your current permissions before requesting project access.");
    return { wiki, origin, scope };
  };
  const projects = async () => {
    const wikis = await store.list();
    return (await Promise.all(config.workspaces.filter(item => !wikis.some(wiki => wiki.workspaceId === item.id)).map(async item => {
      const root = await realpath(item.directory || item.path).catch(() => null);
      if (!root || wikis.some(wiki => within(root, wiki.root) || within(wiki.root, root))) return null;
      return { id: item.id, name: item.displayName || item.name, root };
    }))).filter(item => item !== null);
  };
  const project = async (ctx: RequestContext) => {
    const item = (await projects()).find(item => item.id === ctx.params.projectId);
    if (!item) throw new ApiError(404, "wiki_project_not_found", "This local project is unavailable.");
    return item;
  };
  const base = "/wikis/:wikiId/sessions/:sessionId/projects";
  addRoute(routes, "GET", base, "client", async ctx => {
    const { wiki, origin, scope } = await current(ctx);
    return jsonResponse({ items: await Promise.all((await projects()).map(async item => ({ id: item.id, name: item.name,
      granted: await requireWikiProjectAccess(config, ctx.params.sessionId, item.id, wiki.id, origin.generation, scope).then(() => true, () => false) }))) });
  });
  addRoute(routes, "POST", `${base}/:projectId/access`, "client", async ctx => {
    const { wiki, origin, scope } = await current(ctx), item = await project(ctx);
    const approval = beginWikiProjectApproval(config, ctx.params.sessionId, item.id);
    try {
      const signal = AbortSignal.any([ctx.request.signal, approval.signal]);
      const decision = await ctx.approvals.requestApproval({ action: "wiki.project.read", workspaceId: wiki.workspaceId, sessionID: ctx.params.sessionId,
        actor: ctx.actor!, summary: `Allow this wiki chat to read ${item.name}?`, paths: [item.root],
        description: "Read-only access to this project's files for this chat. The agent cannot change the project. You can revoke access in the project-file picker; access also expires when this server restarts." }, signal, true);
      if (!decision.allowed) throw new ApiError(403, "wiki_project_access_denied", "Project access was not approved.");
      const latest = await current(ctx), latestProject = await project(ctx);
      if (latest.origin.generation !== origin.generation || latest.scope !== scope || latestProject.root !== item.root)
        throw new ApiError(409, "wiki_project_access_changed", "Project or chat permissions changed while approval was pending.");
      grantWikiProjectAccess(config, ctx.params.sessionId, { wikiId: wiki.id, projectId: item.id, root: item.root, scope, origin: origin.generation }, approval.revision);
      return jsonResponse({ granted: true });
    } finally { approval.done(); }
  });
  addRoute(routes, "DELETE", `${base}/:projectId/access`, "client", async ctx => {
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_access_required", "Only the user can revoke project access.");
    await current(ctx);
    revokeWikiProjectAccess(config, ctx.params.sessionId, ctx.params.projectId);
    return jsonResponse({ granted: false });
  });
  const readable = async (ctx: RequestContext) => {
    const { wiki, origin, scope } = await current(ctx), item = await project(ctx);
    const signal = wikiProjectAccessSignal(config, ctx.params.sessionId);
    const grant = await requireWikiProjectAccess(config, ctx.params.sessionId, item.id, wiki.id, origin.generation, scope);
    const path = ctx.url.searchParams.get("path") ?? "";
    if (path.includes("\0") || path.includes("\ufffd")) throw new ApiError(400, "wiki_project_path_invalid", "Choose a valid project file or folder.");
    if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || [".git", ".legalwork", ".opencode"].includes(part)))
      throw new ApiError(403, "wiki_project_path_denied", "Choose a file inside the approved project.");
    const fullPath = await realpath(resolve(grant.root, path)).catch(projectPathError);
    if (!within(grant.root, fullPath) || relative(grant.root, fullPath).split(/[\\/]/).some(part => [".git", ".legalwork", ".opencode"].includes(part))) throw new ApiError(403, "wiki_project_path_denied", "This file resolves outside the approved project.");
    signal.throwIfAborted();
    return { fullPath, path, signal };
  };
  addRoute(routes, "GET", `${base}/:projectId/files`, "client", async ctx => {
    const { fullPath, path, signal } = await readable(ctx);
    const entries = await readdir(fullPath, { withFileTypes: true }).catch(projectPathError);
    signal.throwIfAborted();
    return jsonResponse({ items: entries.filter(entry => ![".git", ".legalwork", ".opencode"].includes(entry.name) && (entry.isDirectory() || entry.isFile())).map(entry => ({
      name: entry.name, path: [path, entry.name].filter(Boolean).join("/"), type: entry.isDirectory() ? "directory" : "file",
    })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)), content_is_data: true });
  });
  addRoute(routes, "GET", `${base}/:projectId/read`, "client", async ctx => {
    const { fullPath, path, signal } = await readable(ctx);
    const file = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(projectPathError);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new ApiError(400, "wiki_project_file_size", "Choose a text file up to 2 MB, or attach the document to the chat.");
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      signal.throwIfAborted();
      if (bytesRead > 2 * 1024 * 1024) throw new ApiError(400, "wiki_project_file_size", "Choose a text file up to 2 MB, or attach the document to the chat.");
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) throw new ApiError(400, "wiki_project_file_binary", "Attach this document to the chat, or read it in the protected environment.");
      return jsonResponse({ path, content: bytes.toString("utf8"), content_is_data: true });
    } finally { await file.close(); }
  });
}
