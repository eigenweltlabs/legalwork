import { z } from "zod";
import { ApiError } from "../errors.js";
import { searchAssistantSessions, searchFingerprint } from "../assistant-session-search.js";
import { isMainAssistant } from "../main-assistant.js";
import { matchesSearch, searchExcerpt } from "../search-schema.js";
import { taskStore } from "../task-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { projectSyncStore } from "../project-sync-store.js";
import { calendarOccurrences } from "../calendar/service.js";
import { addDays } from "../calendar/dates.js";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const page = { query: z.string().trim().max(300).default(""), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(2000).optional(), projectId: z.string().min(1).optional() };
function query<T>(schema: z.ZodType<T>, ctx: RequestContext): T {
  const parsed = schema.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) throw new ApiError(400, "assistant_query", "Check the search filters and pagination.");
  return parsed.data;
}

export function registerAssistantSearchRoutes(options: {
  routes: Route[]; config: ServerConfig; jsonResponse: (value: unknown, status?: number) => Response;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { config, routes, jsonResponse } = options;
  const read = (ctx: RequestContext) => options.requireClientScope(ctx, "viewer");
  const projects = async (projectId?: string) => {
    if (projectId) {
      const workspace = await options.resolveWorkspace(config, projectId);
      if (workspace.workspaceType === "remote") throw new ApiError(400, "local_project", "Search an accessible local or synced project.");
      return { workspaces: [workspace], unavailable: [] };
    }
    const candidates = config.workspaces.filter(workspace => workspace.workspaceType !== "remote");
    const results = await Promise.allSettled(candidates.map(workspace => options.resolveWorkspace(config, workspace.id)));
    const workspaces: WorkspaceInfo[] = [], unavailable: string[] = [];
    results.forEach((result, index) => { if (result.status === "fulfilled") workspaces.push(result.value); else unavailable.push(candidates[index].id); });
    return { workspaces: workspaces.sort((a, b) => a.id.localeCompare(b.id, "en")), unavailable };
  };
  addRoute(routes, "GET", "/assistant/sessions/search", "client", async ctx => {
    read(ctx);
    const input = query(z.object({ ...page, query: z.string().trim().min(1).max(300), scope: z.enum(["assistant", "all", "project"]).default("assistant"), sessionId: z.string().min(1).optional(), includeToolOutputs: z.enum(["true", "false"]).default("false") }), ctx);
    if (input.scope === "project" && !input.projectId) throw new ApiError(400, "project_required", "Choose a project for project-scoped search.");
    const projectId = input.scope === "assistant" ? config.workspaces.find(isMainAssistant)?.id : input.scope === "project" ? input.projectId : undefined;
    if (input.scope === "assistant" && !projectId) return jsonResponse({ items: [], nextCursor: null, scanned: 0, unavailable: [] });
    const accessible = await projects(projectId);
    return jsonResponse({ ...await searchAssistantSessions(config, accessible.workspaces, { ...input, includeToolOutputs: input.includeToolOutputs === "true" }, ctx.request.signal), unavailable: accessible.unavailable });
  });
  addRoute(routes, "GET", "/assistant/tasks", "client", async ctx => {
    read(ctx);
    const input = query(z.object({ ...page, status: z.enum(["open", "in_progress", "done", "cancelled"]).optional() }), ctx);
    const accessible = await projects(input.projectId), connection = await readEigenweltConnection(config), orgId = connectedTaskOrgId(connection);
    const links = await projectSyncStore(config);
    const visible = new Set(accessible.workspaces.filter(workspace => {
      const link = links.linkByWorkspace(workspace.id);
      return !link || link.role === "owner" || (link.orgId === orgId && link.state === "active" && link.settings.scope.tasks);
    }).map(workspace => workspace.id));
    const store = await taskStore(config);
    const result = store.listTasks({ projectId: input.projectId, status: input.status, cursor: input.cursor, limit: 200 }, orgId);
    const items = []; let scanned = 0;
    for (const task of result.tasks) {
      ctx.request.signal.throwIfAborted(); scanned++;
      if (task.projectId ? !visible.has(task.projectId) : Boolean(input.projectId)) continue;
      if (!matchesSearch(`${task.title} ${task.description}`, input.query)) continue;
      items.push({ id: task.id, projectId: task.projectId, title: task.title, description: searchExcerpt(task.description, input.query), status: task.status, dueDate: task.dueDate, priority: task.priority, assigneeName: task.assigneeName });
      if (items.length >= input.limit) break;
    }
    return jsonResponse({ items, nextCursor: scanned < result.tasks.length || result.nextCursor ? result.tasks[scanned - 1]?.id ?? null : null, scanned, unavailable: accessible.unavailable });
  });
  addRoute(routes, "GET", "/assistant/calendar", "client", async ctx => {
    read(ctx);
    const input = query(z.object({ ...page, from: z.iso.date(), to: z.iso.date(), kind: z.enum(["deadline", "event", "task"]).optional() }), ctx);
    if (input.to <= input.from || input.to > addDays(input.from, 366)) throw new ApiError(400, "calendar_range", "Choose a date range of at most one year.");
    const accessible = await projects(input.projectId);
    const fingerprint = searchFingerprint([input.query, input.from, input.to, input.kind, input.projectId]);
    let cursor: { fingerprint: string; project: string; after: string } | undefined;
    if (input.cursor) {
      try { cursor = z.object({ fingerprint: z.string(), project: z.string(), after: z.string() }).parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString())); }
      catch { throw new ApiError(400, "search_cursor", "The calendar cursor is invalid."); }
      if (cursor.fingerprint !== fingerprint) throw new ApiError(400, "search_cursor", "Keep the same calendar filters when following a cursor.");
    }
    const candidates = accessible.workspaces.filter(workspace => !cursor || workspace.id.localeCompare(cursor.project, "en") >= 0);
    const encode = (project: string, after = "") => Buffer.from(JSON.stringify({ fingerprint, project, after })).toString("base64url");
    const items: CalendarOccurrence[] = [];
    for (let index = 0; index < Math.min(candidates.length, 10); index++) {
      ctx.request.signal.throwIfAborted();
      const workspace = candidates[index];
      const key = (item: CalendarOccurrence) => `${item.start}\0${item.id}`;
      const occurrences = (await calendarOccurrences(config, workspace, input.from, input.to)).sort((a, b) => key(a).localeCompare(key(b), "en"));
      for (const item of occurrences) {
        if (cursor?.project === workspace.id && key(item).localeCompare(cursor.after, "en") <= 0) continue;
        if ((input.kind && input.kind !== item.kind) || !matchesSearch(item.title, input.query)) continue;
        items.push(item);
        if (items.length >= input.limit) return jsonResponse({ items, nextCursor: encode(workspace.id, key(item)), unavailable: accessible.unavailable });
      }
    }
    return jsonResponse({ items, nextCursor: candidates.length > 10 ? encode(candidates[10].id) : null, unavailable: accessible.unavailable });
  });
}
