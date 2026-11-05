import { sessionDispatchSchema } from "../session-queue-schema.js";
import { dispatchQueueAction } from "../session-dispatch.js";
import type { SessionViewPreview } from "@legalwork/types/views";
import { beginSessionDeletion, withSessionExecution, withSessionDispatch } from "../session-execution-gate.js";
import { REVIEW_RECOVERY_PROMPT } from "../reviews/recover-empty-review-response.js";
import { reviewSessionViews, savedSessionViews, sessionViewPreviews } from "../views/session-previews.js";
import { retryStopReason } from "../session-retry-policy.js";
import { queueActionSchema, type QueueEntry } from "../session-queue-schema.js";
import { registerMessageQueue } from "../session-message-queue.js";
import { assertSandboxProxyAllowed } from "../agent-sandbox/proxy-gate.js";
import { WikiStore } from "../wiki/store.js";
import { grantWikiAgentSession, revokeWikiAgentSession } from "../wiki/agent-access.js";
import type { OpenCodeClient } from "@opencode/client";
import { createEngineClient, getWorkspaceEngineSession, listEngineMessages, listEngineSessions, workspaceEngineLocation } from "../engine-client.js";
import { nativeQueueTransport } from "../native-queue-transport.js";
import { assertRunnableCommand, interruptEngineSession, runNativeCommand } from "../native-command-control.js";
import { ApiError, findApiError } from "../errors.js";
import { toolImageOriginalStore } from "../tool-image-original-store.js";
import { assertOriginalImageCommitted } from "../tool-image-original-access.js";
import { nativeHistoryImageSource } from "../session-history-images.js";
import { resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ToolImageOriginalReference } from "../tool-image-original-schema.js";
import { applySessionUsageLimits, deleteSessionUsageLimits, recordSessionUsageLimit } from "../session-usage-limits.js";
import { usageLimitDetailsSchema } from "../provider-usage-limit.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot, sessionTodos, sessionStatus } from "../session-read-model.js";
import { readSessionHistoryProvenance, readScopedSessionHistoryProvenance } from "../session-history-provenance.js";
import { assertSessionHistoryReady, prepareSessionHistoryUndo } from "../session-history-undo.js";
import {
  createSessionGroupId,
  normalizeSessionGroupState,
  readSessionGroupState,
  SessionGroupEventStore,
  updateSessionGroupState,
  type SessionGroupDefinition,
  type SessionGroupState,
} from "../session-groups.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { registerHistoryImageRoutes } from "./history-images.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type ParseOptionalPositiveInteger = (value: string | null, name: string) => number | undefined;
type ParseOptionalNonNegativeInteger = (value: string | null, name: string) => number | undefined;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = OpenCodeClient;

interface RegisterSessionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  parseOptionalBoolean: ParseOptionalBoolean;
  parseOptionalPositiveInteger: ParseOptionalPositiveInteger;
  parseOptionalNonNegativeInteger: ParseOptionalNonNegativeInteger;
  readJsonBody: ReadJsonBody;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerSessionRoutes(options: RegisterSessionRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    readJsonBody,
    readJsonBodyLimited,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
  } = options;
  registerHistoryImageRoutes({ routes, config, resolveWorkspace, jsonResponse });
  const originalImages = toolImageOriginalStore(config);
  const sessionGroupEvents = new SessionGroupEventStore();
  async function validateQueuedExecution(client: WorkspaceOpencodeClient, workspace: WorkspaceInfo, execution: QueueEntry["execution"]) {
    if (!config.agentSandboxEnabled && !(await new WikiStore(config).list()).length) return;
    if (execution.kind === "shell") assertSandboxProxyAllowed("POST", "/session/queued/shell");
    if (execution.kind === "command") {
      await assertRunnableCommand(client, workspaceEngineLocation(workspace), execution.command);
      // Definitions and argument interpolation execute only through the
      // verified managed adapter, which applies normal sandbox permissions.
    }
  }
  async function queueClient(workspace: WorkspaceInfo, sessionID: string, allowUnresolved=false) {
    const client = createEngineClient(config, workspace);
    if(allowUnresolved)await prepareSessionHistoryUndo(config,workspace,client,await getWorkspaceEngineSession(client,workspace,sessionID));
    else await assertSessionHistoryReady(config,workspace,client,sessionID);
    return client;
  }
  const messageQueue = registerMessageQueue(config, nativeQueueTransport(config, {
    client: async (workspaceId, sessionID) => queueClient(await resolveWorkspace(config, workspaceId), sessionID),
    prepare: async (workspaceId, _sessionID, client, entry) => {
      ensureWritable(config);
      const workspace = await resolveWorkspace(config, workspaceId);
      await validateQueuedExecution(client, workspace, entry.execution);
    },
  }));
  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/dispatch", "client", async ctx => {
    ensureWritable(config); requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id), sessionID = ctx.params.sessionId;
    const client = await queueClient(workspace, sessionID);
    const parsed = sessionDispatchSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_session_dispatch", "Valid native message or command input is required.", { issues: parsed.error.issues });
    const input = parsed.data;
    if (input.kind === "synthetic") {
      const { kind, waitForCompletion, ...payload } = input;
      const admitted = await withSessionDispatch(config, sessionID, () => client.session.synthetic({ sessionID, ...payload }));
      if (waitForCompletion && input.resume !== false) await client.session.wait({ sessionID }, { signal: ctx.request.signal });
      return jsonResponse({ accepted: true, messageID: admitted.id, staged: false });
    }
    await validateQueuedExecution(client, workspace, input);
    await grantWikiAgentSession(config, { sessionId: sessionID, directory: workspaceEngineLocation(workspace).directory,
      scope: ctx.actor?.type === "host" ? "owner" : ctx.actor?.scope ?? "viewer" });
    if (input.delivery === "steer" || input.kind === "prompt" && input.resume === false) {
      const messageID = await withSessionDispatch(config, sessionID, async () => {
        if (input.agent) await client.session.switchAgent({ sessionID, agent: input.agent });
        if (input.model) await client.session.switchModel({ sessionID, model: input.model });
        await client.session.update({ sessionID, archived: false });
        if (input.kind === "command") {
          await runNativeCommand(client, { sessionID, name: input.command, text: input.args, files: input.files, agents: input.agents, skills: input.skills, delivery: "steer" });
          return undefined;
        }
        const { kind, model, agent, draft, waitForCompletion, ...prompt } = input;
        return (await client.session.prompt({ sessionID, ...prompt })).id;
      });
      if (input.waitForCompletion && !(input.kind === "prompt" && input.resume === false)) await client.session.wait({ sessionID }, { signal: ctx.request.signal });
      return jsonResponse({ accepted: true, messageID, staged: false });
    }
    const action = dispatchQueueAction(input);
    const state = await messageQueue.act(workspace.id, sessionID, action);
    const entry = state.entries.find(entry => entry.id === action.id);
    if (entry?.status === "failed") throw new ApiError(409, "queue_preparation_failed", entry.error ?? "Could not prepare message delivery.", { entryId: action.id });
    if (input.waitForCompletion) await messageQueue.waitForEntry(workspace.id, sessionID, action.id, ctx.request.signal);
    return jsonResponse({ accepted: true, ...(action.execution.kind === "prompt" ? { messageID: action.execution.id } : {}), staged: true });
  });
  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/queue", "client", async ctx => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    await queueClient(workspace, ctx.params.sessionId,true);
    return jsonResponse(await messageQueue.readIfChanged(workspace.id, ctx.params.sessionId, new URL(ctx.request.url).searchParams.get("revision")));
  });
  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/queue", "client", async ctx => {
    ensureWritable(config); requireClientScope(ctx, "collaborator");
    return withSessionExecution(config, ctx.params.sessionId, async () => {
      const workspace = await resolveWorkspace(config, ctx.params.id);
      const parsed = queueActionSchema.safeParse(await readJsonBodyLimited(ctx.request, 64 * 1024 * 1024));
      if (!parsed.success) throw new ApiError(400, "invalid_queue_action", "Invalid message queue action.");
      // Reject stale/deleted or cross-workspace sessions before storing executable work.
      const client = await queueClient(workspace, ctx.params.sessionId);
      if (parsed.data.type === "enqueue") await validateQueuedExecution(client, workspace, parsed.data.execution);
      // Queued prompts bypass the public engine proxy. Refresh their authenticated
      // origin here too, including an existing chat resumed after server restart.
      await grantWikiAgentSession(config, {
        sessionId: ctx.params.sessionId,
        directory: workspace.directory?.trim() || workspace.path,
        scope: ctx.actor?.type === "host" ? "owner" : ctx.actor?.scope ?? "viewer",
    });
    return jsonResponse(await messageQueue.act(workspace.id, ctx.params.sessionId, parsed.data));
    });
  });


  async function listWorkspaceSessions(workspace: WorkspaceInfo, input: { roots?: boolean; start?: number; search?: string; limit?: number }) {
    const client = createEngineClient(config, workspace);
    const sessions = await listEngineSessions(client, { directory: workspaceEngineLocation(workspace).directory,
      ...(input.roots ? { parentID: null } : {}), search: input.search,
      ...(input.start === undefined ? { limit: input.limit } : {}),
    });
    const start = input.start;
    const filtered = start === undefined ? sessions : sessions.filter(session => session.time.updated >= start);
    return buildSessionList(input.limit === undefined ? filtered : filtered.slice(0, input.limit));
  }
  async function readWorkspaceSession(workspace: WorkspaceInfo, sessionID: string) {
    const client=createEngineClient(config,workspace);
    return buildSession((await prepareSessionHistoryUndo(config,workspace,client,await getWorkspaceEngineSession(client,workspace,sessionID))).session);
  }
  async function readWorkspaceSessionMessages(workspace: WorkspaceInfo, sessionID: string, input: { limit?: number }) {
    const client = await queueClient(workspace, sessionID,true);
    const messages = await listEngineMessages(client, sessionID, { ...input, order: "desc" });
    return buildSessionMessages(await applySessionUsageLimits(config, workspace.id, sessionID, messages.reverse()));
  }
  async function readTodos(client: WorkspaceOpencodeClient, sessionID: string) {
    // Native todos live in the latest completed todowrite metadata, possibly
    // before a compaction or the current UI message page.
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.message.list({ sessionID, ...(cursor ? { cursor } : { type: "assistant", order: "desc" }) });
      const todos = sessionTodos([...page.data].reverse());
      if (todos !== undefined) return todos;
      cursor = page.cursor.next ?? undefined;
      if (cursor && seen.has(cursor)) throw new ApiError(502, "opencode_invalid_cursor", "The engine repeated a todo history cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [];
  }
  async function readWorkspaceSessionSnapshot(workspace: WorkspaceInfo, sessionID: string, input: { limit?: number }) {
    const client = await queueClient(workspace, sessionID,true);
    const [session, messages, todos, active] = await Promise.all([
      getWorkspaceEngineSession(client, workspace, sessionID),
      readWorkspaceSessionMessages(workspace, sessionID, input), readTodos(client, sessionID), client.session.active(),
    ]);
    const historyUndo=await prepareSessionHistoryUndo(config,workspace,client,session);
    const historyProvenance = {...await readSessionHistoryProvenance(config, workspace, session, messages),...(historyUndo.state ? {undo:historyUndo.state}:{})};
    return { ...buildSessionSnapshot({ session, messages, todos, active: active[sessionID] }), historyProvenance };
  }
  async function updateWorkspaceSessionGroups(
    workspaceId: string,
    updater: (current: SessionGroupState) => SessionGroupState,
  ) {
    return updateSessionGroupState(config, workspaceId, updater);
  }

  function requireStringField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} is required`);
    }
    return value.trim();
  }

  addRoute(routes, "GET", "/workspace/:id/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listWorkspaceSessions(workspace, {
      roots: parseOptionalBoolean(ctx.url.searchParams.get("roots"), "roots"),
      start: parseOptionalNonNegativeInteger(ctx.url.searchParams.get("start"), "start"),
      search: ctx.url.searchParams.get("search")?.trim() || undefined,
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const result = await readSessionGroupState(config, workspace.id);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const state = normalizeSessionGroupState(body.state);
    const result = await updateWorkspaceSessionGroups(workspace.id, () => state);
    sessionGroupEvents.record(workspace.id, "imported");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const requestedId = typeof body.id === "string" ? body.id.trim().slice(0, 128) : "";
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const existingIds = new Set(current.groups.map((group) => group.id));
      const id = requestedId && !existingIds.has(requestedId) ? requestedId : createSessionGroupId();
      return { ...current, groups: [...current.groups, { id, label }] };
    });
    const groupId = result.state.groups[result.state.groups.length - 1]?.id;
    sessionGroupEvents.record(workspace.id, "created", groupId ? { groupId } : undefined);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/reorder", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const requestedIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const byId = new Map(current.groups.map((group) => [group.id, group]));
      const used = new Set<string>();
      const groups: SessionGroupDefinition[] = [];
      for (const id of requestedIds) {
        const group = byId.get(id);
        if (!group || used.has(id)) continue;
        groups.push(group);
        used.add(id);
      }
      for (const group of current.groups) {
        if (!used.has(group.id)) groups.push(group);
      }
      return { ...current, groups };
    });
    sessionGroupEvents.record(workspace.id, "reordered");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/assignments/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) throw new ApiError(400, "invalid_payload", "sessionId is required");
    const body = await readJsonBody(ctx.request);
    const groupId = typeof body.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : null;
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const assignments = { ...current.assignments };
      if (groupId && current.groups.some((group) => group.id === groupId)) {
        assignments[sessionId] = groupId;
      } else {
        delete assignments[sessionId];
      }
      return { ...current, assignments };
    });
    sessionGroupEvents.record(workspace.id, "assigned", { sessionId, ...(groupId ? { groupId } : {}) });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, label } : group),
    }));
    sessionGroupEvents.record(workspace.id, "updated", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "DELETE", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const assignments: Record<string, string> = {};
      for (const [sessionId, assignedGroupId] of Object.entries(current.assignments)) {
        if (assignedGroupId !== groupId) assignments[sessionId] = assignedGroupId;
      }
      return {
        groups: current.groups.filter((group) => group.id !== groupId),
        assignments,
      };
    });
    sessionGroupEvents.record(workspace.id, "deleted", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = sessionGroupEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: sessionGroupEvents.cursor(workspace.id), workspaceId: workspace.id });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSession(workspace, sessionId);
    return jsonResponse({ item });
  });

  addRoute(routes,"GET","/workspace/:id/sessions/:sessionId/history-provenance","client",async ctx=>{
    const workspace=await resolveWorkspace(config,ctx.params.id),caller=ctx.url.searchParams.get("callerSessionID")?.trim();
    if(!caller)throw new ApiError(400,"invalid_session","The actual caller chat is required.");
    return jsonResponse(await readScopedSessionHistoryProvenance(config,workspace,createEngineClient(config,workspace),caller,ctx.params.sessionId));
  });
  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/messages", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const items = await readWorkspaceSessionMessages(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    const session = await readWorkspaceSession(workspace, sessionId);
    return jsonResponse({ items, historyProvenance: await readSessionHistoryProvenance(config, workspace, session, items) });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/snapshot", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSessionSnapshot(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ item });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/retry-stop", "client", async ctx => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = ctx.params.sessionId;
    const client = await queueClient(workspace, sessionId,true);
    const messages = await listEngineMessages(client, sessionId);
    const status = sessionStatus((await client.session.active())[sessionId], messages);
    const reason = retryStopReason(status);
    const last = [...messages].reverse().find(message => message.type === "assistant");
    if (!reason || last?.type !== "assistant") return jsonResponse({ stopped: false });
    const currentMessages = await listEngineMessages(client, sessionId, { limit: 1, order: "desc" });
    const current = sessionStatus((await client.session.active())[sessionId], currentMessages);
    if (current.type !== "retry" || status.type !== "retry" || current.attempt !== status.attempt || current.next !== status.next) return jsonResponse({ stopped: false });
    await messageQueue.act(workspace.id, sessionId, { type: "pause", paused: true });
    await recordSessionUsageLimit(config, workspace.id, sessionId, last.id, last.model.providerID, null, reason);
    await interruptEngineSession(client, sessionId, { managedCommands: config.engineProjectTrustRequired === true });
    return jsonResponse({ stopped: true });
  });

  addRoute(
    routes,
    "POST",
    "/workspace/:id/sessions/:sessionId/usage-limit",
    "client",
    async (ctx) => {
      ensureWritable(config);
      requireClientScope(ctx, "collaborator");
      const workspace = await resolveWorkspace(config, ctx.params.id);
      const body = await readJsonBody(ctx.request);
      const messageId = requireStringField(body, "messageId");
      const limit = body.limit === undefined ? null : usageLimitDetailsSchema.safeParse(body.limit);
      if (limit && !limit.success) throw new ApiError(400, "invalid_usage_limit", "Valid admission details are required");
      const sessionId = ctx.params.sessionId;
      const opencode = await queueClient(workspace, sessionId);
      const message = await opencode.session.message.get({ sessionID: sessionId, messageID: messageId });
      if (message.type !== "assistant") throw new ApiError(400, "invalid_message", "An assistant turn in this session is required");
      await recordSessionUsageLimit(
        config,
        workspace.id,
        sessionId,
        messageId,
        message.model.providerID,
        limit?.success ? limit.data : null,
      );
      return jsonResponse({ ok: true });
    },
  );

  const recoveredRequests = new Map<string, string>();
  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/review-recovery", "client", async ctx => {
    ensureWritable(config); requireClientScope(ctx, "collaborator");
    return withSessionExecution(config, ctx.params.sessionId, () => withSessionDispatch(config, ctx.params.sessionId, async () => {
      const workspace = await resolveWorkspace(config, ctx.params.id), sessionID = ctx.params.sessionId;
      const client = await queueClient(workspace, sessionID);
      const { messageId } = await readJsonBodyLimited(ctx.request, 4096);
      const messages = await listEngineMessages(client, sessionID);
      const last = messages.filter(message => message.type === "assistant" || message.type === "user").at(-1);
      if (!last || last.id !== messageId || last.type !== "assistant" || last.finish !== "stop" || last.error
        || !last.content.some(part => part.type === "reasoning" && part.text.trim())
        || last.content.some(part => part.type === "tool" || part.type === "text" && part.text.trim()))
        throw new ApiError(409, "recovery_changed", "The chat no longer needs recovery.");
      const user = messages.slice(0, messages.indexOf(last)).reverse().find(message => message.type === "user");
      if (!user || user.type !== "user" || !user.text.trim()) throw new ApiError(409, "recovery_changed", "The originating request is unavailable.");
      const requestMessages = messages.slice(messages.indexOf(user) + 1);
      if (!requestMessages.some(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && part.name.startsWith("legalwork_review_")))) return jsonResponse({ ok: true });
      if (requestMessages.some(message => message.type === "synthetic" && message.metadata?.legalworkReviewRecovery === true)) return jsonResponse({ ok: true });
      if (!(await readTodos(client, sessionID)).some(todo => todo.status === "pending" || todo.status === "in_progress")) return jsonResponse({ ok: true });
      const latest = (await listEngineMessages(client, sessionID)).filter(message => message.type === "assistant" || message.type === "user").at(-1);
      if (latest?.id !== messageId) throw new ApiError(409, "recovery_changed", "New input takes precedence over recovery.");
      await requireIdle(client, [sessionID]);
      if (recoveredRequests.get(sessionID) === user.id) return jsonResponse({ ok: true });
      await client.session.synthetic({ sessionID, id: `msg_review_recovery_${user.id}`, text: REVIEW_RECOVERY_PROMPT,
        metadata: { legalworkReviewRecovery: true, sourceUserID: user.id } });
      recoveredRequests.set(sessionID, user.id);
      return jsonResponse({ ok: true });
    }));
  });

  async function viewReview(workspace: WorkspaceInfo, sessionId: string, lock?: (id: string) => void) {
    const pending = [sessionId], sessionIds = new Set<string>(), items: SessionViewPreview[] = [];
    while (pending.length) {
      const id = pending.shift()!;
      if (sessionIds.has(id)) throw new ApiError(409, "invalid_session_tree", "This chat's related chats could not be verified.");
      if (sessionIds.size >= 1000) throw new ApiError(413, "session_tree_too_large", "Review and delete related chats in smaller groups.");
      sessionIds.add(id);
      lock?.(id);
      const client = await queueClient(workspace, id,!lock);
      if (lock) await requireIdle(client, [id]);
      const [messages, children] = await Promise.all([listEngineMessages(client, id), listEngineSessions(client, { parentID: id })]);
      if (lock && messages.some(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && (part.state.status === "streaming" || part.state.status === "running"))))
        throw new ApiError(409, "session_busy", "A tool is still running in this chat. Wait for it to finish before deleting.");
      items.push(...sessionViewPreviews(messages).map(item => ({ ...item, sessionId: id })));
      pending.push(...children.map(child => child.id));
    }
    return { review: reviewSessionViews(items, items.length ? await savedSessionViews(config) : [], workspace.id, sessionId), sessionIds: [...sessionIds] };
  }
  async function requireIdle(client: WorkspaceOpencodeClient, sessionIds: string[]) {
    const active = await client.session.active();
    if (sessionIds.some(id => active[id])) throw new ApiError(409, "session_busy", "Stop this chat and its related agent chats before deleting, so their dashboards can be checked.");
  }
  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/views", "client", async ctx => {
    requireClientScope(ctx, "viewer");
    return jsonResponse((await viewReview(await resolveWorkspace(config, ctx.params.id), ctx.params.sessionId)).review);
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    const locks = new Map<string, () => void>();
    const lock = (id: string) => { if (!locks.has(id)) locks.set(id, beginSessionDeletion(config, id)); };
    try {
      lock(sessionId);
      const connection = resolveWorkspaceOpencodeConnection(config, workspace);
      const affinity = config.managedImageAffinity?.(workspace);
      const checkImageDeletionConnection = () => {
        const currentWorkspace = config.workspaces.find(item => item.id === workspace.id);
        const current = currentWorkspace && resolveWorkspaceOpencodeConnection(config, currentWorkspace);
        if (!currentWorkspace || !current || current.baseUrl !== connection.baseUrl || current.authHeader !== connection.authHeader || config.managedImageAffinity?.(currentWorkspace) !== affinity)
          throw new ApiError(409, "original_delete_connection_changed", "The engine connection changed while deleting this chat. Stored images are preserved; reconnect before retrying.");
      };
      const opencode = await queueClient(workspace, sessionId);
      checkImageDeletionConnection();
      const { review, sessionIds } = await viewReview(workspace, sessionId, lock);
      await requireIdle(opencode, sessionIds);
      const discardReview = ctx.url.searchParams.get("discardReview");
      if (review.items.length && discardReview !== review.reviewToken) throw new ApiError(409, "unsaved_session_views", "Save or explicitly discard this chat's dashboards before deleting it.", review);
      const references: ToolImageOriginalReference[] = [];
      if (await originalImages.hasIndex()) {
        const source = nativeHistoryImageSource(opencode);
        // Manual connections have no stable engine identity. Only exact UUIDs
        // proven in THIS native engine before deletion may be removed there.
        for (const id of sessionIds) {
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = await originalImages.page(id, cursor);
            for (const image of page.images) {
              try {
                await assertOriginalImageCommitted(source, workspace, id, image, ctx.request.signal);
                if (image.source.storageNamespace === "unverified") references.push(image.reference);
              } catch (error) { if (findApiError(error)?.status !== 404) throw error; }
            }
            cursor = page.nextCursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new Error("Original image deletion repeated a metadata cursor.");
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
      }
      // Dispatch gates stay held until engine deletion and queue cleanup finish.
      checkImageDeletionConnection();
      ctx.request.signal.throwIfAborted();
      await opencode.session.remove({ sessionID: sessionId });
      checkImageDeletionConnection();
      if (affinity) await originalImages.removeSessions(affinity.storageNamespace, sessionIds);
      if (references.length) await originalImages.removeReferences(references);
      for (const id of sessionIds) {
        revokeWikiAgentSession(config, id);
        recoveredRequests.delete(id);
        await messageQueue.removeSession(workspace.id, id);
        await deleteSessionUsageLimits(config, workspace.id, id);
      }

      return jsonResponse({ ok: true });
    } finally { for (const release of locks.values()) release(); }
  });
}
