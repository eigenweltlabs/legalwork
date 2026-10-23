import { announceSyncChange } from "../app-sync-events.js";
import type { SessionViewPreview } from "@legalwork/types/views";
import { beginSessionDeletion, withSessionExecution } from "../session-execution-gate.js";
import { REVIEW_RECOVERY_PROMPT } from "../reviews/recover-empty-review-response.js";
import { reviewSessionViews, savedSessionViews, sessionViewPreviews } from "../views/session-previews.js";
import { retryStopReason } from "../session-retry-policy.js";
import { queueActionSchema, queuedPromptPayload, type QueueEntry } from "../session-queue-schema.js";
import { QueuePreparationError, registerMessageQueue } from "../session-message-queue.js";
import { assertNoHostShellInterpolation, assertSandboxProxyAllowed } from "../agent-sandbox/proxy-gate.js";
import { WikiStore } from "../wiki/store.js";
import { grantWikiAgentSession, revokeWikiAgentSession } from "../wiki/agent-access.js";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "../errors.js";
import { canonicalFilePath } from "../file-write-lock.js";
import { posix, win32 } from "node:path";
import { applySessionUsageLimits, deleteSessionUsageLimits, recordSessionUsageLimit } from "../session-usage-limits.js";
import { usageLimitDetailsSchema } from "../provider-usage-limit.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot } from "../session-read-model.js";
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

type JsonResponse = (data: unknown, status?: number) => Response;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type ParseOptionalPositiveInteger = (value: string | null, name: string) => number | undefined;
type ParseOptionalNonNegativeInteger = (value: string | null, name: string) => number | undefined;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;
type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response: Response };
type UnwrapOpencodeResult = <T, E>(result: OpencodeClientResult<T, E>, path: string) => NonNullable<T>;

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
  resolveWorkspaceMetadata?: (config: ServerConfig, id: string) => WorkspaceInfo;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  unwrapOpencodeResult: UnwrapOpencodeResult;
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
    createWorkspaceOpencodeClient,
    unwrapOpencodeResult,
  } = options;
  const metadata = options.resolveWorkspaceMetadata ?? resolveWorkspace;
  const sessionGroupEvents = new SessionGroupEventStore();
  const groupChanged = (workspaceId: string, action: Parameters<SessionGroupEventStore["record"]>[1], details?: Parameters<SessionGroupEventStore["record"]>[2]) => {
    sessionGroupEvents.record(workspaceId, action, details);
    announceSyncChange(config, "groups");
  };
  async function validateQueuedExecution(client: WorkspaceOpencodeClient, execution: QueueEntry["execution"]) {
    if (!config.agentSandboxEnabled && !(await new WikiStore(config).list()).length) return;
    if (execution.kind === "shell") assertSandboxProxyAllowed("POST", "/session/queued/shell");
    if (execution.kind === "command") {
      assertNoHostShellInterpolation(execution.arguments);
      const commands = unwrapOpencodeResult(await client.command.list(), "/command");
      const definition = commands.find(item => item.name === execution.command);
      if (!definition) throw new ApiError(404, "command_not_found", "Command not found.");
      assertNoHostShellInterpolation(definition.template);
    }
  }
  async function queueClient(workspace: WorkspaceInfo, sessionID: string) {
    const client = createWorkspaceOpencodeClient(config, workspace);
    const session = unwrapOpencodeResult(await client.session.get({ sessionID }), "session");
    const directory = workspace.directory?.trim() || (workspace.workspaceType === "local" ? workspace.path : unwrapOpencodeResult(await client.path.get(), "path").directory);
    const normalize = async (path: string) => {
      const clean = path.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
      if (workspace.workspaceType === "local") return canonicalFilePath(clean);
      return /^[a-z]:[\\/]|^\\\\/i.test(clean) ? win32.normalize(clean).replace(/[\\/]+$/, "").toLowerCase() : posix.normalize(clean).replace(/\/$/, "");
    };
    if (!directory || !session.directory || await normalize(directory) !== await normalize(session.directory)) throw new ApiError(404, "session_not_found", "This chat does not belong to the project.");
    return client;
  }
  const messageQueue = registerMessageQueue(config, {
    confirmed: async (workspaceId, sessionID, entry) => {
      if (entry.execution.kind !== "prompt") return false;
      const workspace = await resolveWorkspace(config, workspaceId);
      const client = await queueClient(workspace, sessionID);
      const messageID = `msg_${entry.id.replaceAll("-", "")}`;
      const result = await client.session.message({ sessionID, messageID }, { signal: AbortSignal.timeout(5000) });
      return result.data?.info.id === messageID && result.data.info.role === "user" && result.data.info.sessionID === sessionID;
    },
    idle: async (workspaceId, sessionId) => {
      if (config.readOnly) return false;
      const workspace = await resolveWorkspace(config, workspaceId);
      const client = createWorkspaceOpencodeClient(config, workspace);
      const statuses = unwrapOpencodeResult(await client.session.status(), "session/status");
      return !statuses[sessionId] || statuses[sessionId].type === "idle";
    },
    send: (workspaceId, sessionID, entry) => withSessionExecution(config, sessionID, async () => {
      ensureWritable(config);
      const client = await (async () => {
        try {
          const workspace = await resolveWorkspace(config, workspaceId);
          const client = await queueClient(workspace, sessionID);
          // Revalidate restored queues and shortcut definitions changed since enqueue.
          await validateQueuedExecution(client, entry.execution);
          unwrapOpencodeResult(await client.session.update({ sessionID, time: { archived: 0 } }), "session/update");
          return client;
        } catch (error) {
          throw new QueuePreparationError(error instanceof Error ? error.message : "Could not prepare message delivery.");
        }
      })();
      const execution = entry.execution;
      if (execution.kind === "prompt") {
        const result = unwrapOpencodeResult(await client.session.prompt({ sessionID, messageID: `msg_${entry.id.replaceAll("-", "")}`, ...queuedPromptPayload(execution) }), "session/prompt");
        // A terminal assistant result confirms delivery, including Stop/model errors.
        // Pause follow-ups, but never offer to resend the already accepted prompt.
        return { pause: Boolean(result.info.error), reason: result.info.error?.name === "MessageAbortedError" ? "stop" : "error" };
      } else if (execution.kind === "command") unwrapOpencodeResult(await client.session.command({ sessionID, ...execution }), "session/command");
      else unwrapOpencodeResult(await client.session.shell({ sessionID, command: execution.command }), "session/shell");
    }, true),
  });
  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/queue", "client", async ctx => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    await queueClient(workspace, ctx.params.sessionId);
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
      if (parsed.data.type === "enqueue") await validateQueuedExecution(client, parsed.data.execution);
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


  function remapSessionReadError(error: unknown): never {
    if (error instanceof ApiError && error.code === "opencode_request_failed") {
      const details = error.details;
      const upstreamStatus =
        isRecord(details) && "status" in details ? Number(details.status) : NaN;
      if (upstreamStatus === 400) {
        throw new ApiError(400, "invalid_query", "OpenCode rejected the session read request", details);
      }
      if (upstreamStatus === 404) {
        throw new ApiError(404, "session_not_found", "Session not found", details);
      }
    }
    throw error;
  }

  async function listWorkspaceSessions(
    workspace: WorkspaceInfo,
    input: { roots?: boolean; start?: number; search?: string; limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSessionList(
        unwrapOpencodeResult(
          await opencode.session.list({
            roots: input.roots,
            start: input.start,
            search: input.search,
            limit: input.limit,
          }),
          "/session",
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSession(workspace: WorkspaceInfo, sessionId: string) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSession(
        unwrapOpencodeResult(
          await opencode.session.get({ sessionID: sessionId }),
          `/session/${encodeURIComponent(sessionId)}`,
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionMessages(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSessionMessages(
        await applySessionUsageLimits(config, workspace.id, sessionId, unwrapOpencodeResult(
          await opencode.session.messages({ sessionID: sessionId, limit: input.limit }),
          `/session/${encodeURIComponent(sessionId)}/message`,
        )),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionSnapshot(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const [session, messages, todos, statuses] = await Promise.all([
        opencode.session
          .get({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}`)),
        opencode.session
          .messages({ sessionID: sessionId, limit: input.limit })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/message`)),
        opencode.session
          .todo({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/todo`)),
        opencode.session.status().then((result) => unwrapOpencodeResult(result, "/session/status")),
      ]);
      return buildSessionSnapshot({ session, messages: await applySessionUsageLimits(config, workspace.id, sessionId, messages), todos, statuses });
    } catch (error) {
      remapSessionReadError(error);
    }
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

  addRoute(routes, "GET", "/session-groups/events", "client", async (ctx) => {
    let raw: unknown;
    try { raw = JSON.parse(ctx.url.searchParams.get("cursors") || "{}"); }
    catch { throw new ApiError(400, "invalid_cursors", "Invalid group event cursors."); }
    if (!isRecord(raw) || Object.keys(raw).length > 500) throw new ApiError(400, "invalid_cursors", "Invalid group event cursors.");
    const items = [];
    for (const [id, since] of Object.entries(raw)) {
      ctx.request.signal.throwIfAborted();
      if (since !== null && (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0)) throw new ApiError(400, "invalid_cursors", "Invalid group event cursor.");
      try {
        const workspace = await metadata(config, id);
        const cursor = sessionGroupEvents.cursor(workspace.id);
        const events = sessionGroupEvents.list(workspace.id, typeof since === "number" ? since : undefined);
        // Include state on the first read and cursor reset (a server restart), too.
        const state = since === null || (typeof since === "number" && since > cursor) || events.length > 0
          ? await readSessionGroupState(config, workspace.id) : undefined;
        items.push({ workspaceId: workspace.id, cursor, ...(state ? { state: state.state, updatedAt: state.updatedAt } : {}) });
      } catch (error) {
        if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
      }
    }
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups", "client", async (ctx) => {
    const workspace = await metadata(config, ctx.params.id);
    const result = await readSessionGroupState(config, workspace.id);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const state = normalizeSessionGroupState(body.state);
    const result = await updateWorkspaceSessionGroups(workspace.id, () => state);
    groupChanged(workspace.id, "imported");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const requestedId = typeof body.id === "string" ? body.id.trim().slice(0, 128) : "";
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const existingIds = new Set(current.groups.map((group) => group.id));
      const id = requestedId && !existingIds.has(requestedId) ? requestedId : createSessionGroupId();
      return { ...current, groups: [...current.groups, { id, label }] };
    });
    const groupId = result.state.groups[result.state.groups.length - 1]?.id;
    groupChanged(workspace.id, "created", groupId ? { groupId } : undefined);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/reorder", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
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
    groupChanged(workspace.id, "reordered");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/assignments/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
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
    groupChanged(workspace.id, "assigned", { sessionId, ...(groupId ? { groupId } : {}) });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, label } : group),
    }));
    groupChanged(workspace.id, "updated", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "DELETE", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await metadata(config, ctx.params.id);
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
    groupChanged(workspace.id, "deleted", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups/events", "client", async (ctx) => {
    const workspace = await metadata(config, ctx.params.id);
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

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/messages", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const items = await readWorkspaceSessionMessages(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
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
    const client = await queueClient(workspace, sessionId);
    const statuses = unwrapOpencodeResult(await client.session.status(), "session/status");
    const status = statuses[sessionId];
    const reason = status && retryStopReason(status);
    if (!reason) return jsonResponse({ stopped: false });
    const messages = unwrapOpencodeResult(await client.session.messages({ sessionID: sessionId }), "session/messages");
    const last = messages.at(-1)?.info;
    if (last?.role !== "assistant") return jsonResponse({ stopped: false });
    // Recheck after reads: a completed retry or new user turn takes precedence.
    const current = unwrapOpencodeResult(await client.session.status(), "session/status")[sessionId];
    if (current?.type !== "retry" || status.type !== "retry" || current.attempt !== status.attempt || current.next !== status.next) return jsonResponse({ stopped: false });
    await messageQueue.act(workspace.id, sessionId, { type: "pause", paused: true });
    await recordSessionUsageLimit(config, workspace.id, sessionId, last.id, last.providerID, null, reason);
    unwrapOpencodeResult(await client.session.abort({ sessionID: sessionId }), "session/abort");
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
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const message = unwrapOpencodeResult(
        await opencode.session.message({
          sessionID: sessionId,
          messageID: messageId,
        }),
        "session message",
      );
      if (
        message.info.role !== "assistant" ||
        message.info.sessionID !== sessionId
      )
        throw new ApiError(
          400,
          "invalid_message",
          "An assistant turn in this session is required",
        );
      await recordSessionUsageLimit(
        config,
        workspace.id,
        sessionId,
        messageId,
        message.info.providerID,
        limit?.success ? limit.data : null,
      );
      return jsonResponse({ ok: true });
    },
  );

  const recoveredRequests = new Map<string, string>();
  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/review-recovery", "client", async ctx => {
    ensureWritable(config); requireClientScope(ctx, "collaborator");
    return withSessionExecution(config, ctx.params.sessionId, async () => {
      const workspace = await resolveWorkspace(config, ctx.params.id), sessionID = ctx.params.sessionId;
      const client = await queueClient(workspace, sessionID);
      const { messageId } = await readJsonBodyLimited(ctx.request, 4096);
      const last = unwrapOpencodeResult(await client.session.messages({ sessionID, limit: 1 }), "session messages").at(-1);
      if (!last || last.info.id !== messageId || last.info.role !== "assistant" || last.info.finish !== "stop" || last.info.error || last.info.summary
        || !last.parts.some(part => part.type === "reasoning" && part.text.trim()) || last.parts.some(part => part.type === "tool" || part.type === "text" && part.text.trim()))
        throw new ApiError(409, "recovery_changed", "The chat no longer needs recovery.");
      const user = unwrapOpencodeResult(await client.session.message({ sessionID, messageID: last.info.parentID }), "session message");
      if (user.info.role !== "user" || !user.parts.some(part => part.type === "text" && !part.synthetic) || user.parts.some(part => part.type === "compaction"))
        throw new ApiError(409, "recovery_changed", "The originating request is unavailable.");
      const todos = unwrapOpencodeResult(await client.session.todo({ sessionID }), "session todo");
      if (!todos.some(todo => todo.status === "pending" || todo.status === "in_progress")) return jsonResponse({ ok: true });
      const latest = unwrapOpencodeResult(await client.session.messages({ sessionID, limit: 1 }), "session messages").at(-1);
      if (latest?.info.id !== messageId) throw new ApiError(409, "recovery_changed", "New input takes precedence over recovery.");
      await requireIdle(client, [sessionID]);
      if (recoveredRequests.get(sessionID) === user.info.id) return jsonResponse({ ok: true });
      recoveredRequests.set(sessionID, user.info.id);
      const result = await client.session.promptAsync({ sessionID, agent: user.info.agent, model: user.info.model,
        parts: [{ type: "text", synthetic: true, text: REVIEW_RECOVERY_PROMPT }] });
      if (!result.response?.ok) throw new ApiError(502, "recovery_send", "Could not confirm recovery delivery. Check the chat before retrying.");
      return jsonResponse({ ok: true });
    });
  });

  async function viewReview(workspace: WorkspaceInfo, sessionId: string, lock?: (id: string) => void) {
    const pending = [sessionId], sessionIds = new Set<string>(), items: SessionViewPreview[] = [];
    while (pending.length) {
      const id = pending.shift()!;
      if (sessionIds.has(id)) throw new ApiError(409, "invalid_session_tree", "This chat's related chats could not be verified.");
      if (sessionIds.size >= 1000) throw new ApiError(413, "session_tree_too_large", "Review and delete related chats in smaller groups.");
      sessionIds.add(id);
      lock?.(id);
      const client = await queueClient(workspace, id);
      if (lock) await requireIdle(client, [id]);
      const [messageResult, childResult] = await Promise.all([client.session.messages({ sessionID: id }), client.session.children({ sessionID: id })]);
      const messages = unwrapOpencodeResult(messageResult, "session messages");
      if (lock && messages.some(message => message.parts.some(part => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))))
        throw new ApiError(409, "session_busy", "A tool is still running in this chat. Wait for it to finish before deleting.");
      items.push(...sessionViewPreviews(messages).map(item => ({ ...item, sessionId: id })));
      pending.push(...unwrapOpencodeResult(childResult, "session children").map(child => child.id));
    }
    return { review: reviewSessionViews(items, items.length ? await savedSessionViews(config) : [], workspace.id, sessionId), sessionIds: [...sessionIds] };
  }
  async function requireIdle(client: WorkspaceOpencodeClient, sessionIds: string[]) {
    const statuses = unwrapOpencodeResult(await client.session.status(), "session/status");
    if (sessionIds.some(id => statuses[id] && statuses[id].type !== "idle")) throw new ApiError(409, "session_busy", "Stop this chat and its related agent chats before deleting, so their dashboards can be checked.");
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
      const opencode = await queueClient(workspace, sessionId);
      const { review, sessionIds } = await viewReview(workspace, sessionId, lock);
      await requireIdle(opencode, sessionIds);
      const discardReview = ctx.url.searchParams.get("discardReview");
      if (review.items.length && discardReview !== review.reviewToken) throw new ApiError(409, "unsaved_session_views", "Save or explicitly discard this chat's dashboards before deleting it.", review);
      // Dispatch gates stay held until engine deletion and queue cleanup finish.
      unwrapOpencodeResult(
        await opencode.session.delete({ sessionID: sessionId }),
        `/session/${encodeURIComponent(sessionId)}`,
      );
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
