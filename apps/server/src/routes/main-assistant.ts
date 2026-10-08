import { registerAssistantChatRoutes } from "./assistant-chat.js";
import { registerAssistantSessionRoutes } from "./assistant-sessions.js";
import type { AssistantSessionQueue } from "../assistant-session-queue.js";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "../errors.js";
import { isMainAssistant, type MainAssistant } from "../main-assistant.js";
import { createDefaultProjectFolder, defaultProjectRoot, readProjectDetails } from "../project-store.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { registerLocalProject } from "./workspaces.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { AssistantAvatarIconSchema, AssistantProfileSchema } from "../assistant-schema.js";
import { projectMatch } from "../assistant-project-search.js";
import { searchFingerprint } from "../assistant-session-search.js";
import { assistantProjectOverview } from "../assistant-project-overview.js";
import { registerAssistantSearchRoutes } from "./assistant-search.js";
import { registerAssistantRecorderRoutes } from "./assistant-recorder.js";
import { copyAssistantFiles } from "../assistant-delegation-files.js";
import { recordAudit } from "../audit.js";
import { shortId } from "../utils.js";
import type { AssistantDelegations } from "../assistant-delegations.js";
import { ConversationLanguageSchema } from "../assistant-handoff.js";
import { assistantHandoffParts } from "../assistant-handoff-message.js";
import { registerAssistantAttentionRoutes } from "./assistant-attention.js";

const delegationSchema = z.object({
  workspaceId: z.string().min(1), sourceWorkspaceId: z.string().min(1), sourceSessionId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  conversationLanguage: ConversationLanguageSchema,
  prompt: z.string().trim().min(1).max(30000), scope: z.string().trim().min(1).max(8000),
  files: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
  initializeProject: z.boolean().optional(),
  model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).optional(),
});

export function registerMainAssistantRoutes(options: {
  routes: Route[]; config: ServerConfig; assistant: MainAssistant;
  delegations: AssistantDelegations;
  sessionQueue: AssistantSessionQueue;
  jsonResponse: (value: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  client: (workspace: WorkspaceInfo) => ReturnType<typeof createOpencodeClient>;
  changed: () => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
}) {
  const { config, assistant, routes, jsonResponse } = options;
  registerAssistantSearchRoutes(options);
  registerAssistantRecorderRoutes(options);
  registerAssistantAttentionRoutes(options);
  registerAssistantChatRoutes(options);
  registerAssistantSessionRoutes(options);
  const accessible = (id: string) => options.resolveWorkspace(config, id);
  const write = (ctx: RequestContext) => { options.ensureWritable(config); options.requireClientScope(ctx, "collaborator"); };
  const summary = (workspace: WorkspaceInfo) => ({ id: workspace.id, name: (isMainAssistant(workspace) ? assistant.profile().name : null) ?? (workspace.displayName || workspace.name), path: workspace.path, preset: workspace.preset, workspaceType: workspace.workspaceType });
  addRoute(routes, "GET", "/assistant", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = config.workspaces.find(isMainAssistant);
    return jsonResponse({ workspace: workspace ? summary(workspace) : null, profile: assistant.profile(), onboarding: await assistant.onboarding() });
  });
  addRoute(routes, "POST", "/assistant/current", "client", async ctx => {
    write(ctx);
    if (ctx.request.body) {
      const body = await options.readJsonBodyLimited(ctx.request, 256 * 1024);
      if (body.projectFields !== undefined) assistant.updateProjectDefaults(body.projectFields);
    }
    const { workspace, day } = await assistant.current();
    return jsonResponse({ workspace: summary(workspace), day, profile: assistant.profile() });
  });
  addRoute(routes, "GET", "/assistant/onboarding", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = config.workspaces.find(isMainAssistant);
    if (workspace) await accessible(workspace.id);
    return jsonResponse(await assistant.onboarding());
  });
  addRoute(routes, "POST", "/assistant/onboarding/view", "client", async ctx => {
    write(ctx);
    const workspace = config.workspaces.find(isMainAssistant);
    if (workspace) await accessible(workspace.id);
    return jsonResponse(await assistant.viewGreeting());
  });
  addRoute(routes, "POST", "/assistant/onboarding", "client", async ctx => {
    write(ctx);
    const workspace = config.workspaces.find(isMainAssistant);
    if (workspace) await accessible(workspace.id);
    const input = z.union([z.object({ name: z.string().trim().min(1).max(60) }).strict(), z.object({ icon: AssistantAvatarIconSchema }).strict()]).safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!input.success) throw new ApiError(400, "assistant_onboarding", "Enter a name of up to 60 characters or choose an avatar.");
    return jsonResponse(await assistant.answerOnboarding(input.data));
  });
  addRoute(routes, "PATCH", "/assistant/profile", "client", async ctx => {
    write(ctx);
    const parsed = AssistantProfileSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!parsed.success) throw new ApiError(400, "assistant_profile", "Choose an icon and a name of up to 60 characters.");
    return jsonResponse({ profile: await assistant.updateProfile(parsed.data) });
  });
  addRoute(routes, "POST", "/assistant/name", "client", async ctx => {
    write(ctx);
    const input = z.object({ name: z.string().trim().min(1).max(60) }).strict().safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!input.success) throw new ApiError(400, "assistant_name", "Choose a name of up to 60 characters.");
    const onboarding = await assistant.setName(input.data.name);
    return jsonResponse({ ok: true, onboarding, showAvatarPicker: onboarding.step === "avatar" });
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
    const query = z.object({ query: z.string().trim().max(300).default(""), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(2000).optional() }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!query.success) throw new ApiError(400, "project_query", "Use a search term and a page size from 1 to 50.");
    const fingerprint = searchFingerprint(query.data.query);
    let cursor: { fingerprint: string; score: number; id: string } | undefined;
    if (query.data.cursor) {
      try { cursor = z.object({ fingerprint: z.string(), score: z.number(), id: z.string() }).parse(JSON.parse(Buffer.from(query.data.cursor, "base64url").toString())); }
      catch { throw new ApiError(400, "project_cursor", "The project search cursor is invalid. Start a fresh search."); }
      if (cursor.fingerprint !== fingerprint) throw new ApiError(400, "project_cursor", "Keep the same query when following a cursor.");
    }
    const projects = [];
    const unavailable: string[] = [];
    const matches: { entry: WorkspaceInfo; score: number; match: string }[] = [];
    const local = config.workspaces.filter(entry => entry.workspaceType !== "remote");
    // Search matter/client metadata as well as names, with bounded filesystem concurrency.
    for (let offset = 0; offset < local.length; offset += 16) {
      const batch = await Promise.all(local.slice(offset, offset + 16).map(async entry => {
        let match = projectMatch(summary(entry), query.data.query);
        if (query.data.query && (!match || match.match === "approximate")) {
          try {
            const allowed = await accessible(entry.id);
            const details = await readProjectDetails(allowed.path);
            match = projectMatch(summary(entry), query.data.query, details.fields.map(field => field.value ?? "").join(" "));
          } catch { unavailable.push(entry.id); }
        }
        return match ? { entry, ...match } : null;
      }));
      for (const item of batch) if (item) matches.push(item);
    }
    const candidates = matches.filter(item => !cursor || item.score > cursor.score || item.score === cursor.score && item.entry.id.localeCompare(cursor.id, "en") > 0)
      .sort((a, b) => a.score - b.score || a.entry.id.localeCompare(b.entry.id, "en"));
    for (const { entry, score, match } of candidates) {
      try { projects.push({ ...summary(await accessible(entry.id)), match, score }); } catch { unavailable.push(entry.id); }
      if (projects.length > query.data.limit) break;
    }
    const items = projects.slice(0, query.data.limit);
    const last = items.at(-1);
    return jsonResponse({ projects: items, nextCursor: projects.length > query.data.limit && last ? Buffer.from(JSON.stringify({ fingerprint, score: last.score, id: last.id })).toString("base64url") : null,
      unavailable, note: "Approximate matches are spelling suggestions, not confirmed identities. For a read-only status question, inspect the likely project's overview and state which project you used. Clarify genuinely ambiguous matches before starting or changing work. An empty task search does not mean a project is absent." });
  });
  addRoute(routes, "GET", "/assistant/projects/:id/overview", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const input = z.object({ sessionLimit: z.coerce.number().int().min(1).max(10).default(5), taskLimit: z.coerce.number().int().min(1).max(50).default(15) }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!input.success) throw new ApiError(400, "overview_query", "Use up to 10 recent chats and 50 tasks.");
    const workspace = await accessible(ctx.params.id);
    if (workspace.workspaceType === "remote") throw new ApiError(400, "local_project", "Choose an accessible local or synced project.");
    return jsonResponse(await assistantProjectOverview(config, workspace, options.client(workspace), input.data, ctx.request.signal));
  });
  addRoute(routes, "GET", "/assistant/projects/:id/sessions/:sessionId", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspace = await accessible(ctx.params.id);
    const client = options.client(workspace);
    const session = await client.session.get({ sessionID: ctx.params.sessionId }, { signal: AbortSignal.timeout(10000) });
    if (!session.data || resolve(session.data.directory) !== resolve(workspace.path)) throw new ApiError(404, "session_not_found", "Chat not found in this project.");
    const [statuses, todos] = await Promise.all([client.session.status({}, { signal: AbortSignal.timeout(10000) }), client.session.todo({ sessionID: ctx.params.sessionId }, { signal: AbortSignal.timeout(10000) })]);
    if (!statuses.data || !todos.data) throw new ApiError(502, "session_status_unavailable", "Chat status could not be read.");
    return jsonResponse({ session: session.data, status: statuses.data[ctx.params.sessionId] ?? { type: "idle" }, todos: todos.data,
      queuedMessages: options.sessionQueue.list({ workspaceId: workspace.id, sessionId: ctx.params.sessionId }) });
  });
  addRoute(routes, "POST", "/assistant/projects", "client", async ctx => {
    write(ctx);
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!parsed.success) throw new ApiError(400, "project_name", "A project name is required.");
    const folderPath = await createDefaultProjectFolder(parsed.data.name, defaultProjectRoot(config.projectsDirectory));
    const { workspace } = await registerLocalProject(config, { folderPath, name: parsed.data.name, preset: "starter", position: "last", projectFields: assistant.projectDefaults() });
    options.changed();
    return jsonResponse({ project: summary(workspace), details: await readProjectDetails(workspace.path) }, 201);
  });
  addRoute(routes, "POST", "/assistant/delegate", "client", async ctx => {
    write(ctx);
    const parsed = delegationSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 50000));
    if (!parsed.success) throw new ApiError(400, "delegation_input", "Choose a project and provide a title, task, scope and conversationLanguage (e.g. en or de).");
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
    const files = await copyAssistantFiles(source.path, workspace.path, input.files ?? [], paths => options.requireApproval(ctx, {
      workspaceId: workspace.id, action: "workspace.file.write", summary: `Copy ${paths.length} attached files into ${workspace.displayName || workspace.name}`,
      paths: paths.map(path => join(workspace.path, path)),
    }));
    for (const file of files) await recordAudit(workspace.path, {
      id: shortId(), workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" }, action: "workspace.file.write",
      target: join(workspace.path, file.path), summary: `Copied from ${source.id}: ${file.sourcePath}`, timestamp: Date.now(),
    });
    const setupContext = input.initializeProject ? "\n\nThis is a newly created project. First use legalwork_project_get_details to discover its configured metadata fields. Read the provided source files and fill supported fields with legalwork_project_set_metadata using exact field IDs, types and options. Preserve existing values and leave uncertain fields empty. Cite the evidence in your result; do not invent a client relationship or legal deadline. Do not delay the requested work for optional unknown metadata. Then carry out the user's task below." : "";
    const client = options.client(workspace);
    const created = await client.session.create({ title: input.title }, { signal: AbortSignal.timeout(10000) });
    if (!created.data) throw new ApiError(502, "delegation_create", "Could not create the project chat.");
    const session = created.data;
    if (resolve(session.directory) !== resolve(workspace.path)) throw new ApiError(502, "delegation_scope", "The engine created the chat outside the requested project.");
    const delegation = { workspaceId: workspace.id, projectName: workspace.displayName || workspace.name, sessionId: session.id, title: input.title, scope: input.scope, sourceSessionId: input.sourceSessionId, conversationLanguage: input.conversationLanguage };
    options.delegations.track({ ...delegation, sourceWorkspaceId: source.id, model: model ?? null });
    try {
      const sent = await client.session.promptAsync({ sessionID: session.id, agent: "legalwork", model,
        parts: assistantHandoffParts({ ...input, files, setupContext, ...(isMainAssistant(source) ? { sender: assistant.profile() } : {}) }) }, { signal: AbortSignal.timeout(30000) });
      if (!sent.response.ok) throw new Error("Delivery was not confirmed.");
      options.changed();
      return jsonResponse({ ok: true, delegation: { ...delegation, status: "started" }, files });
    } catch {
      // Return the created chat even on an ambiguous delivery, so it can be inspected without duplicating work.
      return jsonResponse({ ok: false, delegation: { ...delegation, status: "delivery-unconfirmed" }, error: "Inspect this chat before retrying. Delivery could not be confirmed." });
    }
  });
}
