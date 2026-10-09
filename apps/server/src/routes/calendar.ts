import { calculationScript, runPythonCalculation } from "../calculations/python-runner.js";
import type { DocumentPreparation } from "../document-preparation/service.js";
import type { ApprovalRequest } from "../types.js";
import { presentCalculation, validatePresentationSources } from "../calculations/present.js";
import { CalculationCardSchema, CalculationPresentationInputSchema } from "../calculations/schema.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { requireIntakeClient, intakeRequest } from "../eigenwelt-intake.js";
import { projectSyncStore } from "../project-sync-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { z } from "zod";
import { resolve } from "node:path";
import { CalendarCreateSchema, CalendarPatchSchema } from "../calendar/schema.js";
import { validateCalendarLinks } from "../calendar/links.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addDays, dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { calendarStore } from "../calendar/store.js";
import { calendarExport, calendarOccurrences, calendarVisible, collectCalendarReminders, datedTasks } from "../calendar/service.js";
import { DEADLINE_SKILLS } from "../calendar/deadline-rules.js";
import { calculateWithSkill, DEADLINE_CODE_HASH, ensureDeadlineSkills } from "../calendar/skills.js";
import { announceSyncChange } from "../app-sync-events.js";
import { scheduleProjectSync } from "../project-sync.js";
import { calendarSubscription, changeCalendarSubscription } from "../calendar/subscriptions.js";

export function registerCalendarRoutes(options: {
  preparation: DocumentPreparation;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
  routes: Route[]; config: ServerConfig; jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void; requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  listSessions: (workspace: WorkspaceInfo, search?: string) => Promise<{ id: string; title: string; directory: string }[]>;
  getSession: (workspace: WorkspaceInfo, id: string) => Promise<{ directory: string } | null>;
}) {
  const { config } = options;
  void ensureDeadlineSkills().catch(error => console.warn("[calendar] Skill installation failed", error));
  const body = (ctx: RequestContext) => options.readJsonBodyLimited(ctx.request, 2_100_000);
  const range = (ctx: RequestContext) => {
    const input = z.object({ from: z.iso.date(), to: z.iso.date() }).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!input.success || input.data.to <= input.data.from || input.data.to > addDays(input.data.from, 366)) throw new ApiError(400, "calendar_range", "Choose a valid date range of at most one year.");
    return input.data;
  };
  const changed = () => { announceSyncChange(config, "projects"); scheduleProjectSync(config, 500); };
  const route = (method: string, path: string, action: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>, readOnly = method === "GET") => {
    addRoute(options.routes, method, `/workspace/:id/calendar${path}`, "client", async ctx => {
      options.requireClientScope(ctx, readOnly ? "viewer" : "collaborator");
      if (!readOnly) options.ensureWritable(config);
      const workspace = await options.resolveWorkspace(config, ctx.params.id);
      if (!(await calendarVisible(config, workspace))) throw new ApiError(403, "calendar_not_shared", "Calendar sharing is disabled for this project.");
      try { const result = await action(ctx, workspace); if (!readOnly) changed(); return result instanceof Response ? result : options.jsonResponse(result); }
      catch (error) { if (error instanceof z.ZodError) throw new ApiError(400, "calendar_input", "Check the calendar inputs.", { issues: error.issues }); throw error; }
    });
  };
  route("GET", "", async (ctx, workspace) => ({ items: (await calendarStore(config)).list(workspace.id, ctx.url.searchParams.get("deleted") === "include"), conflicts: (await calendarStore(config)).conflicts(workspace.id) }));
  route("GET", "/occurrences", async (ctx, workspace) => { const { from, to } = range(ctx); return { occurrences: await calendarOccurrences(config, workspace, from, to) }; });
  route("GET", "/export", async (ctx, workspace) => new Response(await calendarExport(config, workspace, ctx.url.searchParams.get("profile") === "native" ? "native" : "calendar"), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } }));
  route("GET", "/rules", async () => ({ skills: DEADLINE_SKILLS, codeHash: DEADLINE_CODE_HASH }));
  // Subscription URLs are bearer credentials. Viewer clients cannot retrieve them.
  for (const method of ["GET", "POST", "DELETE"]) {
    const subscription = async (ctx: RequestContext, workspaceId: string | null) => {
      options.requireClientScope(ctx, "collaborator");
      if (method !== "GET") options.ensureWritable(config);
      return method === "GET" ? calendarSubscription(config, workspaceId) : changeCalendarSubscription(config, workspaceId, method === "POST");
    };
    route(method, "/subscription", (ctx, workspace) => subscription(ctx, workspace.id));
    addRoute(options.routes, method, "/calendar/subscription", "client", async ctx => options.jsonResponse(await subscription(ctx, null)));
  }
  route("GET", "/links", async (ctx, workspace) => ({ projectName: workspace.displayName?.trim() || workspace.name,
    sessions: (await options.listSessions(workspace, ctx.url.searchParams.get("search")?.slice(0, 255))).filter(session => resolve(session.directory) === resolve(workspace.path)).map(({ id, title }) => ({ id, title })) }));
  route("POST", "/calculate", async (ctx, workspace) => {
    const input = z.strictObject({ skill: z.string(), input: z.unknown() }).parse(await body(ctx));
    return { calculation: (await calendarStore(config)).recordCalculation(workspace.id, await calculateWithSkill(workspace.path, input.skill, input.input), DEADLINE_CODE_HASH) };
  });
  route("POST", "/run", async (ctx, workspace) => {
    const input = z.object({ skill: z.string().min(1), input: z.record(z.string(), z.unknown()) }).parse(await body(ctx));
    const script = await calculationScript(workspace.path, input.skill);
    await options.requireApproval(ctx, { workspaceId: workspace.id, action: "calculations.execute", summary: `Execute installed calculation skill ${input.skill}`, paths: [script.path] });
    const run = await runPythonCalculation(await calendarStore(config), workspace.id, input.skill, script, input.input, ctx.request.signal);
    return { runId: run.id, status: run.status, results: run.results, missingFacts: run.missingFacts };
  });
  route("POST", "/present", async (ctx, workspace) => {
    const input = CalculationPresentationInputSchema.parse(await body(ctx));
    if (input.sessionId) await validateCalendarLinks(workspace, { sessionIds: [input.sessionId] }, undefined, options.getSession);
    const presentation = await presentCalculation(await calendarStore(config), workspace, input, ctx.request.signal, options.preparation);
    return { ...CalculationCardSchema.parse({ presentation }), status: presentation.state, instruction: presentation.mode === "confirm" ? "The card is visible in chat. Wait for the human to use its actions. Do not save these receipts in the background." : "The informational card is visible in chat. Continue according to the user request." };
  });
  route("GET", "/presentations/:presentation", async (ctx, workspace) => ({ presentation: (await calendarStore(config)).presentation(workspace.id, ctx.params.presentation) }));
  route("POST", "/presentations/:presentation/decision", async (ctx, workspace) => {
    const { action } = z.object({ action: z.enum(["save", "reject", "acknowledge"]) }).parse(await body(ctx));
    const store = await calendarStore(config), card = store.presentation(workspace.id, ctx.params.presentation);
    if (action === "save" && card.state !== "saved") {
      await validatePresentationSources(workspace, card.sources);
      await validateCalendarLinks(workspace, { attachmentPaths: card.sources.map(source => source.path), sessionIds: card.sessionId ? [card.sessionId] : [] }, undefined, options.getSession);
    }
    return { presentation: store.decidePresentation(workspace.id, card.id, action) };
  });
  route("POST", "", async (ctx, workspace) => {
    const { calculationId, ...input } = await body(ctx);
    await validateCalendarLinks(workspace, CalendarCreateSchema.parse(input), undefined, options.getSession);
    if (Array.isArray(input.taskIds)) { const tasks = await datedTasks(config, workspace.id); if (input.taskIds.some(id => !tasks.some(task => task.id === id))) throw new ApiError(400, "calendar_task_link", "Link only tasks in this project."); }
    return { item: (await calendarStore(config)).create(workspace.id, input, z.uuid().optional().parse(calculationId)) };
  });
  route("POST", "/import", async (ctx, workspace) => {
    const input = z.strictObject({ ical: z.string(), source: z.string().max(4000).default(""), timeZone: z.string().default("Europe/Berlin"), revisions: z.record(z.string(), z.number().int()).default({}) }).parse(await body(ctx));
    return { items: (await calendarStore(config)).import(workspace.id, input.ical, input.source, input.revisions, input.timeZone) };
  });
  route("POST", "/feeds", async (_ctx, workspace) => ({ token: (await calendarStore(config)).createFeed(workspace.id) }));
  route("DELETE", "/feeds/:token", async (ctx, workspace) => {
    const store = await calendarStore(config); if (store.feed(ctx.params.token)?.projectId !== workspace.id) throw new ApiError(404, "feed_not_found", "Feed not found.");
    store.revokeFeed(ctx.params.token); return { ok: true };
  });
  route("GET", "/:item", async (ctx, workspace) => ({ item: (await calendarStore(config)).get(workspace.id, ctx.params.item) }));
  route("GET", "/:item/history", async (ctx, workspace) => ({ history: (await calendarStore(config)).history(workspace.id, ctx.params.item) }));
  route("PATCH", "/:item", async (ctx, workspace) => {
    const input = await body(ctx);
    await validateCalendarLinks(workspace, CalendarPatchSchema.parse(input), (await calendarStore(config)).get(workspace.id, ctx.params.item), options.getSession);
    if (Array.isArray(input.taskIds)) { const tasks = await datedTasks(config, workspace.id); if (input.taskIds.some(id => !tasks.some(task => task.id === id))) throw new ApiError(400, "calendar_task_link", "Link only tasks in this project."); }
    return { item: (await calendarStore(config)).patch(workspace.id, ctx.params.item, input) };
  });
  for (const restore of [false, true]) route("POST", `/:item/${restore ? "restore" : "delete"}`, async (ctx, workspace) => {
    const { revision } = z.strictObject({ revision: z.number().int().nonnegative() }).parse(await body(ctx)); return { item: (await calendarStore(config)).remove(workspace.id, ctx.params.item, revision, restore) };
  });
  route("POST", "/:item/conflict", async (ctx, workspace) => {
    const input = z.strictObject({ revision: z.number().int().nonnegative(), keep: z.enum(["mine", "theirs"]) }).parse(await body(ctx));
    return { item: (await calendarStore(config)).resolve(workspace.id, ctx.params.item, input.revision, input.keep) };
  });
  addRoute(options.routes, "GET", "/calendar/occurrences", "client", async ctx => {
    options.requireClientScope(ctx, "viewer"); const { from, to } = range(ctx);
    const occurrences = (await Promise.all(config.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(workspace => calendarOccurrences(config, workspace, from, to)))).flat();
    for (const task of await datedTasks(config)) {
      if (task.projectId || !task.dueDate || task.status === "cancelled") continue;
      const day = task.dueDate.length === 10 ? task.dueDate : dayInZone(task.dueDate, "Europe/Berlin");
      if (day < from || day >= to) continue;
      occurrences.push({ id: `task:${task.id}`, itemId: task.id, uid: `task-${task.id}@legalwork`, projectId: null, projectName: "Inbox", kind: "task", title: task.title,
        start: task.dueDate, end: null, allDay: task.dueDate.length === 10, timeZone: "Europe/Berlin", status: task.status, assigneeUserId: task.assigneeUserId, provenance: null, verified: true, recurring: false });
    }
    return options.jsonResponse({ occurrences });
  });
  addRoute(options.routes, "POST", "/calendar/reminders/claim", "client", async ctx => {
    options.requireClientScope(ctx, "collaborator"); await collectCalendarReminders(config);
    const connection = await readEigenweltConnection(config);
    const visible = new Set<string>(); for (const workspace of config.workspaces) if (workspace.workspaceType !== "remote" && await calendarVisible(config, workspace)) visible.add(workspace.id);
    const reminders = (await calendarStore(config)).claimReminders(visible, connection.account?.userId ?? null);
    try {
      if (connectedTaskOrgId(connection)) {
        const remote = z.object({ reminders: z.array(z.object({ id: z.string(), itemId: z.string(), projectId: z.string(), title: z.string(), deadline: z.string() })) }).parse(await intakeRequest(requireIntakeClient(connection), "POST", "/api/calendar/reminders", {}));
        const links = await projectSyncStore(config);
        for (const reminder of remote.reminders) {
          const link = links.linkByProject(reminder.projectId);
          if (link?.state === "active" && link.settings.scope.calendar !== false && !reminders.some(item => item.id === reminder.id)) reminders.push({ ...reminder, projectId: link.workspaceId });
        }
      }
    } catch { /* Local reminders remain available while the platform is offline. */ }
    return options.jsonResponse({ reminders });
  });
  addRoute(options.routes, "GET", "/calendar/feed/:token", "none", async ctx => {
    const feed = (await calendarStore(config)).feed(ctx.params.token); if (!feed?.projectId) throw new ApiError(404, "feed_not_found", "Feed not found.");
    const workspace = await options.resolveWorkspace(config, feed.projectId);
    if (!(await calendarVisible(config, workspace))) throw new ApiError(404, "feed_not_found", "Feed is no longer available.");
    return new Response(await calendarExport(config, workspace, "calendar"), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  });
}
