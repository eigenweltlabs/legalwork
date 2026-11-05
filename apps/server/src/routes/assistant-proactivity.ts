import { z } from "zod";
import { isMainAssistant } from "../main-assistant.js";
import { MORNING_BRIEFING_PROMPT } from "../assistant-schema.js";
import { MORNING_BRIEFING_KEY } from "../assistant-briefing.js";
import { assistantProactivityStore } from "../assistant-proactivity-store.js";
import { BriefingActionSchema, ScratchpadWriteSchema } from "../assistant-proactivity-schema.js";
import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { wallTime } from "../scheduled-tasks/schedule.js";
import type { ScheduledTaskStore } from "../scheduled-tasks/store.js";
import { ApiError } from "../errors.js";
import { addRoute } from "./registry.js";
import type { registerMainAssistantRoutes } from "./main-assistant.js";
import { assistantRequestAuthority } from "../assistant-session-access.js";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_assistant_request", "Check the Assistant tool inputs.", parsed.error.issues);
  return parsed.data;
}

export function registerAssistantProactivityRoutes(options: Parameters<typeof registerMainAssistantRoutes>[0], schedules: ScheduledTaskStore) {
  const { config, routes, jsonResponse } = options;
  const source = z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1), sourceSessionId: z.string().min(1) }).refine(input => input.sessionId === input.sourceSessionId);
  const existing = (workspaceId: string) => schedules.defaultTask(MORNING_BRIEFING_KEY) ?? schedules.list(workspaceId)
    .find(task => task.prompt === MORNING_BRIEFING_PROMPT || /morning briefing|morgenbriefing/i.test(task.title)) ?? null;
  for (const kind of ["scratchpad", "briefing"]) addRoute(routes, "POST", `/assistant/${kind}`, "client", async ctx => {
    options.ensureWritable(config);
    options.requireClientScope(ctx, "collaborator");
    const authorityRequest = ctx.request.clone();
    const body = await options.readJsonBodyLimited(ctx.request, 20000);
    const input = parse(source, body);
    const workspace = await options.resolveWorkspace(config, input.workspaceId);
    if (!isMainAssistant(workspace)) throw new ApiError(403, "assistant_only", "Use this tool in the Assistant.");
    const session = await getWorkspaceEngineSession(createEngineClient(config, workspace), workspace, input.sessionId);
    const store = await assistantProactivityStore(config);
    if (kind === "scratchpad") {
      if (body.text === undefined) return jsonResponse({ ok: true, scratchpad: store.scratchpad() });
      if (session.parentID) throw new ApiError(403, "assistant_only", "Only the main Assistant conversation maintains its scratchpad.");
      const write = parse(ScratchpadWriteSchema, body);
      const authority = await options.sessionAccess.captureSource(session.id, session.location.directory,
        await assistantRequestAuthority(config, authorityRequest, ctx.actor));
      return jsonResponse({ ok: true, scratchpad: store.updateScratchpad(write, Date.now(), {
        sessionId: session.id, directory: session.location.directory, authority,
      }) });
    }
    if (session.parentID) throw new ApiError(403, "assistant_only", "Briefing setup belongs in the main Assistant conversation.");
    const action = parse(BriefingActionSchema, body);
    const task = existing(workspace.id);
    if (action.action === "status") return jsonResponse({ ok: true, task, offer: store.briefingOffer(), previouslyCreated: schedules.hasDefault(MORNING_BRIEFING_KEY) });
    if (action.action === "decline") { store.markBriefingOffer("declined"); return jsonResponse({ ok: true }); }
    if (action.action === "offer") return jsonResponse({ ok: true, mayOffer: !task && !schedules.hasDefault(MORNING_BRIEFING_KEY) && store.markBriefingOffer("offered"), task });
    if (task) return jsonResponse({ ok: true, task, alreadyExists: true });
    const timeZone = action.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
    catch { throw new ApiError(400, "invalid_time_zone", "Choose a valid time zone for the briefing."); }
    const startAt = `${wallTime(new Date().toISOString(), timeZone).slice(0, 10)}T${action.time}:00`;
    const created = schedules.createDefault(MORNING_BRIEFING_KEY, workspace.id, {
      title: "Morning briefing", prompt: MORNING_BRIEFING_PROMPT,
      schedule: { kind: "rrule", startAt, timeZone, rrule: action.weekdaysOnly ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : "FREQ=DAILY" },
      projectAccess: "all", sessionId: null, reuseChat: false, pinSession: false, model: null,
    }, Date.now(), { replaceDeleted: true, wikiScope: ctx.actor?.type === "host" || ctx.actor?.scope === "owner" ? "owner" : "collaborator" });
    store.markBriefingOffer("offered");
    options.changed();
    return jsonResponse({ ok: true, task: created ?? existing(workspace.id), alreadyExists: !created });
  });
}
