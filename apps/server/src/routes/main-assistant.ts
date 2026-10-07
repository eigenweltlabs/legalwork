import { resolve } from "node:path";
import { z } from "zod";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "../errors.js";
import { isMainAssistant, type MainAssistant } from "../main-assistant.js";
import { createDefaultProjectFolder, defaultProjectRoot } from "../project-store.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { registerLocalProject } from "./workspaces.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { AssistantProfileSchema } from "../assistant-schema.js";
import { matchesSearch } from "../search-schema.js";
import { registerAssistantSearchRoutes } from "./assistant-search.js";

const delegationSchema = z.object({
  workspaceId: z.string().min(1), sourceWorkspaceId: z.string().min(1), sourceSessionId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(30000), scope: z.string().trim().min(1).max(8000),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).optional(),
});

export function registerMainAssistantRoutes(options: {
  routes: Route[]; config: ServerConfig; assistant: MainAssistant;
  jsonResponse: (value: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  client: (workspace: WorkspaceInfo) => ReturnType<typeof createOpencodeClient>;
  changed: () => void;
}) {
  const { config, assistant, routes, jsonResponse } = options;
  registerAssistantSearchRoutes(options);
  const accessible = (id: string) => options.resolveWorkspace(config, id);
  const write = (ctx: RequestContext) => { options.ensureWritable(config); options.requireClientScope(ctx, "collaborator"); };
  const summary = (workspace: WorkspaceInfo) => ({ id: workspace.id, name: (isMainAssistant(workspace) ? assistant.profile().name : null) ?? (workspace.displayName || workspace.name), path: workspace.path, preset: workspace.preset, workspaceType: workspace.workspaceType });
  addRoute(routes, "GET", "/assistant", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = config.workspaces.find(isMainAssistant);
    return jsonResponse({ workspace: workspace ? summary(workspace) : null, profile: assistant.profile() });
  });
  addRoute(routes, "POST", "/assistant/current", "client", async ctx => {
    write(ctx);
    const { workspace, day } = await assistant.current();
    return jsonResponse({ workspace: summary(workspace), day, profile: assistant.profile() });
  });
  addRoute(routes, "PATCH", "/assistant/profile", "client", async ctx => {
    write(ctx);
    const parsed = AssistantProfileSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!parsed.success) throw new ApiError(400, "assistant_profile", "Choose an icon and a name of up to 60 characters.");
    return jsonResponse({ profile: await assistant.updateProfile(parsed.data) });
  });
  addRoute(routes, "GET", "/assistant/history", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = config.workspaces.find(isMainAssistant);
    const query = z.object({ before: z.iso.date().optional(), limit: z.coerce.number().int().min(1).max(31).default(14) }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new ApiError(400, "assistant_history_query", "Use a date and a page size from 1 to 31.");
    if (!workspace) return jsonResponse({ days: [], nextBefore: null });
    await accessible(workspace.id);
    return jsonResponse({ workspaceId: workspace.id, ...assistant.history(workspace.id, query.data.before, query.data.limit) });
  });
  addRoute(routes, "GET", "/assistant/projects", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const query = z.object({ query: z.string().trim().max(300).default(""), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(200).optional() }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new ApiError(400, "project_query", "Use a search term and a page size from 1 to 50.");
    const projects = [];
    const candidates = config.workspaces.filter(entry => entry.workspaceType !== "remote" && matchesSearch(`${summary(entry).name} ${entry.path}`, query.data.query) && (!query.data.cursor || entry.id.localeCompare(query.data.cursor, "en") > 0)).sort((a, b) => a.id.localeCompare(b.id, "en"));
    for (const entry of candidates) {
      try { projects.push(summary(await accessible(entry.id))); } catch { /* Unavailable projects cannot be used. */ }
      if (projects.length > query.data.limit) break;
    }
    const items = projects.slice(0, query.data.limit);
    return jsonResponse({ projects: items, nextCursor: projects.length > query.data.limit ? items.at(-1)?.id : null });
  });
  addRoute(routes, "GET", "/assistant/projects/:id/sessions/:sessionId", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = await accessible(ctx.params.id);
    const client = options.client(workspace);
    const session = await client.session.get({ sessionID: ctx.params.sessionId }, { signal: AbortSignal.timeout(10000) });
    if (!session.data || resolve(session.data.directory) !== resolve(workspace.path)) throw new ApiError(404, "session_not_found", "Chat not found in this project.");
    const [statuses, todos] = await Promise.all([client.session.status({}, { signal: AbortSignal.timeout(10000) }), client.session.todo({ sessionID: ctx.params.sessionId }, { signal: AbortSignal.timeout(10000) })]);
    if (!statuses.data || !todos.data) throw new ApiError(502, "session_status_unavailable", "Chat status could not be read.");
    return jsonResponse({ session: session.data, status: statuses.data[ctx.params.sessionId] ?? { type: "idle" }, todos: todos.data });
  });
  addRoute(routes, "POST", "/assistant/projects", "client", async ctx => {
    write(ctx);
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!parsed.success) throw new ApiError(400, "project_name", "A project name is required.");
    const folderPath = await createDefaultProjectFolder(parsed.data.name, defaultProjectRoot(config.projectsDirectory));
    const { workspace } = await registerLocalProject(config, { folderPath, name: parsed.data.name, preset: "starter", position: "last" });
    options.changed();
    return jsonResponse({ project: summary(workspace) }, 201);
  });
  addRoute(routes, "POST", "/assistant/delegate", "client", async ctx => {
    write(ctx);
    const parsed = delegationSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 50000));
    if (!parsed.success) throw new ApiError(400, "delegation_input", "Choose a project and provide a title, task and scope.");
    const input = parsed.data;
    const source = await accessible(input.sourceWorkspaceId);
    const workspace = await accessible(input.workspaceId);
    if (workspace.workspaceType === "remote" || source.workspaceType === "remote") throw new ApiError(400, "delegation_local", "Choose an available local project.");
    if (isMainAssistant(workspace)) throw new ApiError(400, "delegation_project", "Delegate project work to a project, not back to the assistant.");
    const sourceResult = await options.client(source).session.get({ sessionID: input.sourceSessionId }, { signal: AbortSignal.timeout(10000) });
    if (!sourceResult.data || resolve(sourceResult.data.directory) !== resolve(source.path)) throw new ApiError(400, "delegation_source", "The source chat is not in this project.");
    const previous = await options.client(source).session.messages({ sessionID: input.sourceSessionId, limit: 1 }, { signal: AbortSignal.timeout(10000) });
    const last = previous.data?.at(-1)?.info;
    const model = input.model ?? (last?.role === "assistant" ? { providerID: last.providerID, modelID: last.modelID } : last?.model);
    const client = options.client(workspace);
    const created = await client.session.create({ title: input.title }, { signal: AbortSignal.timeout(10000) });
    if (!created.data) throw new ApiError(502, "delegation_create", "Could not create the project chat.");
    const session = created.data;
    if (resolve(session.directory) !== resolve(workspace.path)) throw new ApiError(502, "delegation_scope", "The engine created the chat outside the requested project.");
    const delegation = { workspaceId: workspace.id, projectName: workspace.displayName || workspace.name, sessionId: session.id, title: input.title, scope: input.scope, sourceSessionId: input.sourceSessionId };
    try {
      const sent = await client.session.promptAsync({ sessionID: session.id, agent: "legalwork", model,
        parts: [{ type: "text", text: `Task delegated from the main assistant.\n\nScope and requested deliverable:\n${input.scope}\n\nTask:\n${input.prompt}\n\nWork in this project's context and follow its instructions. Report progress and results in this chat. Stay within the user's authorized scope.` }] }, { signal: AbortSignal.timeout(30000) });
      if (!sent.response.ok) throw new Error("Delivery was not confirmed.");
      options.changed();
      return jsonResponse({ ok: true, delegation: { ...delegation, status: "started" } });
    } catch {
      // Return the created chat even on an ambiguous delivery, so it can be inspected without duplicating work.
      return jsonResponse({ ok: false, delegation: { ...delegation, status: "delivery-unconfirmed" }, error: "Inspect this chat before retrying. Delivery could not be confirmed." });
    }
  });
}
