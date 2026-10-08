import { matchesSearch } from "../search-schema.js";
import { searchFingerprint } from "../assistant-session-search.js";
import { isMainAssistant } from "../main-assistant.js";
import { readSessionInbox } from "../session-inbox.js";
import { resolve } from "node:path";
import { z } from "zod";
import { ScheduledTaskInputSchema } from "../scheduled-tasks/schema.js";
import { nextOccurrence } from "../scheduled-tasks/schedule.js";
import type { ScheduledTaskStore } from "../scheduled-tasks/store.js";
import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";

export function registerScheduledTaskRoutes(options: {
  routes: Route[]; config: ServerConfig; store: ScheduledTaskStore;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  listSessions: (workspace: WorkspaceInfo, search?: string) => Promise<{ id: string; title: string; directory: string; time: { archived?: number } }[]>;
  getSession: (workspace: WorkspaceInfo, id: string) => Promise<{ directory: string; time: { archived?: number } } | null>;
}) {
  const { config, store } = options;
  const body = (ctx: RequestContext) => options.readJsonBodyLimited(ctx.request, 50000);
  const route = (method: string, suffix: string, action: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>) => {
    addRoute(options.routes, method, `/workspace/:id/scheduled-tasks${suffix}`, "client", async ctx => {
      options.requireClientScope(ctx, method === "GET" ? "viewer" : "collaborator");
      if (method !== "GET") options.ensureWritable(config);
      // Task records stay manageable when the project's drive is disconnected.
      const workspace = config.workspaces.find(item => item.id === ctx.params.id);
      if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
      if (workspace.workspaceType === "remote") throw new ApiError(400, "local_schedule_only", "Scheduled tasks run in a local project on this computer.");
      try { return options.jsonResponse(await action(ctx, workspace)); }
      catch (error) { if (error instanceof z.ZodError) throw new ApiError(400, "scheduled_task_input", "Check the task title, instructions and schedule.", { issues: error.issues }); throw error; }
    });
  };
  const assistantTarget = (workspace: WorkspaceInfo): Partial<z.infer<typeof ScheduledTaskInputSchema>> => isMainAssistant(workspace)
    ? { sessionId: null, reuseChat: false, pinSession: false, projectAccess: "all" } : {};
  const checkSession = async (workspace: WorkspaceInfo, id: string | null | undefined) => {
    const available = await options.resolveWorkspace(config, workspace.id);
    if (!id) return;
    const session = await options.getSession(available, id);
    if (!session || resolve(session.directory) !== resolve(workspace.path) || session.time.archived) throw new ApiError(400, "schedule_session", "Choose an available chat in this project.");
  };
  addRoute(options.routes, "GET", "/scheduled-tasks", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const local = new Set(config.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(workspace => workspace.id));
    const tasks = store.list().filter(task => local.has(task.workspaceId));
    if (!ctx.url.searchParams.has("limit")) return options.jsonResponse({ tasks });
    const input = z.object({ limit: z.coerce.number().int().min(1).max(50), query: z.string().max(300).default(""), cursor: z.string().optional(), status: z.enum(["active", "paused", "completed"]).optional() }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!input.success) throw new ApiError(400, "schedule_query", "Check schedule search and pagination.");
    const fingerprint = searchFingerprint([input.data.query, input.data.status]);
    let after = "";
    if (input.data.cursor) {
      try {
        const cursor = z.object({ fingerprint: z.string(), after: z.string() }).parse(JSON.parse(Buffer.from(input.data.cursor, "base64url").toString()));
        if (cursor.fingerprint !== fingerprint) throw new Error("filters changed");
        after = cursor.after;
      } catch { throw new ApiError(400, "schedule_cursor", "Keep the same filters with a valid cursor."); }
    }
    const matches = tasks.filter(task => (!input.data.status || task.status === input.data.status) && matchesSearch(`${task.title} ${task.prompt}`, input.data.query) && task.id.localeCompare(after) > 0).sort((a, b) => a.id.localeCompare(b.id));
    const page = matches.slice(0, input.data.limit);
    return options.jsonResponse({ tasks: page.map(({ id, workspaceId, title, status, revision, nextRunAt, schedule }) => ({ id, workspaceId, title, status, revision, nextRunAt, schedule })),
      nextCursor: matches.length > page.length ? Buffer.from(JSON.stringify({ fingerprint, after: page.at(-1)?.id })).toString("base64url") : null });
  });
  addRoute(options.routes, "GET", "/scheduled-tasks/projects", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const projects = [];
    for (const item of config.workspaces.filter(workspace => workspace.workspaceType !== "remote")) {
      try { const workspace = await options.resolveWorkspace(config, item.id); projects.push({ id: workspace.id, name: workspace.name, path: workspace.path }); }
      catch { /* Unavailable or unauthorized projects are not accessible to scheduled work. */ }
    }
    return options.jsonResponse({ projects });
  });
  addRoute(options.routes, "GET", "/session-inbox", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const workspaces = [];
    for (const item of config.workspaces.filter(workspace => workspace.workspaceType !== "remote")) {
      try { workspaces.push(await options.resolveWorkspace(config, item.id)); } catch { /* Not accessible. */ }
    }
    return options.jsonResponse({ sessions: await readSessionInbox(config, workspaces, store.sessionActivity()) });
  });
  route("GET", "", async (_ctx, workspace) => ({ tasks: store.list(workspace.id) }));
  route("GET", "/chats", async (ctx, workspace) => ({ sessions: (await options.listSessions(await options.resolveWorkspace(config, workspace.id), ctx.url.searchParams.get("search")?.slice(0, 200)))
    .filter(session => resolve(session.directory) === resolve(workspace.path) && !session.time.archived).map(({ id, title }) => ({ id, title })) }));
  route("POST", "/preview", async ctx => {
    const schedule = ScheduledTaskInputSchema.shape.schedule.parse((await body(ctx)).schedule);
    const occurrences: string[] = []; let after = Date.now();
    for (let i = 0; i < 3; i++) { const next = nextOccurrence(schedule, after); if (!next) break; occurrences.push(next); after = Date.parse(next); }
    return { occurrences };
  });
  route("POST", "", async (ctx, workspace) => {
    const input = ScheduledTaskInputSchema.parse({ ...await body(ctx), ...assistantTarget(workspace) });
    await checkSession(workspace, input.sessionId);
    return { task: store.create(workspace.id, input) };
  });
  route("GET", "/:task", async (ctx, workspace) => ({ task: store.get(workspace.id, ctx.params.task), runs: store.runs(ctx.params.task) }));
  route("PATCH", "/:task", async (ctx, workspace) => {
    const { revision, ...patch } = ScheduledTaskInputSchema.partial().extend({ reuseChat: ScheduledTaskInputSchema.shape.reuseChat.removeDefault().optional(), pinSession: ScheduledTaskInputSchema.shape.pinSession.removeDefault().optional(), model: ScheduledTaskInputSchema.shape.model.removeDefault().optional(), projectAccess: ScheduledTaskInputSchema.shape.projectAccess.removeDefault().optional(), revision: z.number().int().positive(), status: z.enum(["active", "paused"]).optional() }).parse(await body(ctx));
    const current = store.get(workspace.id, ctx.params.task);
    if (patch.sessionId !== undefined || patch.status === "active") await checkSession(workspace, patch.sessionId === undefined ? current.sessionId : patch.sessionId);
    return { task: store.update(workspace.id, ctx.params.task, revision, { ...patch, ...assistantTarget(workspace) }) };
  });
  route("DELETE", "/:task", async (ctx, workspace) => {
    const { revision } = z.object({ revision: z.number().int().positive() }).parse(await body(ctx));
    store.remove(workspace.id, ctx.params.task, revision); return { ok: true };
  });
}
