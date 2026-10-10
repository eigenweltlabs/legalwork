import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ChannelRuntime, ChannelOwner, ChannelInput, ChannelCommand, ChannelFileResult, channelObservationVersion } from "./channel-runtime.js";
import { ApiError } from "./errors.js";
import { runtimeDbPath } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import type { MainAssistant } from "./main-assistant.js";
import { isMainAssistant } from "./main-assistant.js";
import { readAssistantAttention, replyToAssistantAttention } from "./assistant-attention.js";
import type { AssistantDelegations } from "./assistant-delegations.js";
import type { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { addRoute, type Route } from "./routes/registry.js";
import { resolveWithinRoot } from "./paths.js";
import { projectSyncStore } from "./project-sync-store.js";
import { createHash } from "node:crypto";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import { channelLiveEvents, channelToolOutput } from "./channel-live-events.js";
import { retryChannelTurn, retryableChannelError } from "./channel-recovery.js";
import { watchChannelEvents } from "./channel-event-wait.js";

const sharedFileTypes: Record<string, string> = { ".txt": "text/plain", ".md": "text/plain", ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4" };

export async function registerChannelRuntimeRoutes(options: {
  config: ServerConfig; routes: Route[]; assistant: MainAssistant; delegations: AssistantDelegations; schedules: ScheduledTaskStore;
  client: (workspace: WorkspaceInfo) => OpencodeClient;
  workspace: (id: string) => Promise<WorkspaceInfo>;
  json: (value: unknown, status?: number) => Response;
  body: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
}) {
  const { config } = options;
  const requestOptions = () => ({ throwOnError: true, signal: AbortSignal.timeout(10000) });
  const available = () => !config.readOnly && (!config.cloudSync || config.cloudSync.canExecute());
  const identity = async () => {
    const path = process.env.LEGALWORK_CHANNEL_IDENTITY;
    if (!path) throw new ApiError(503, "channels_unconfigured", "Channel runtime is not configured.");
    return ChannelOwner.parse(JSON.parse(await readFile(path, "utf8")));
  };
  const model = async () => {
    const path = process.env.LEGALWORK_CHANNEL_MODEL;
    if (!path) throw new ApiError(503, "channels_unconfigured", "Channel model is not configured.");
    return z.strictObject({ providerID: z.literal("eigenwelt-cloud"), modelID: z.string().min(1).max(512) }).parse(JSON.parse(await readFile(path, "utf8")));
  };
  const target = async (input: { workspaceId: string; sessionId: string }) => {
    const workspace = await options.workspace(input.workspaceId);
    if (workspace.workspaceType === "remote" || !isMainAssistant(workspace)) throw new ApiError(409, "channel_session", "Channel session is outside the Assistant.");
    const client = options.client(workspace);
    const session = await client.session.get({ sessionID: input.sessionId }, requestOptions());
    if (!session.data || session.data.time.archived || resolve(session.data.directory) !== resolve(workspace.path))
      throw new ApiError(409, "channel_session", "Channel session is no longer available.");
    return { workspace, client };
  };
  const runtime = await ChannelRuntime.open(runtimeDbPath(config), {
    current: async () => { const current = await options.assistant.current(); return { workspaceId: current.workspace.id, sessionId: current.day.sessionId }; },
    validate: async input => { await target(input); },
    hasMessage: async input => {
      const { client } = await target(input);
      const response = await client.session.message({ sessionID: input.sessionId, messageID: input.messageId }, { signal: AbortSignal.timeout(10000) });
      if (response.response.status === 404) return false;
      if (!response.response.ok || !response.data) throw new Error("Message acceptance unavailable");
      return response.data.info.id === input.messageId;
    },
    busy: async input => {
      const { client } = await target(input); const response = await client.session.status({}, requestOptions());
      if (!response.data) throw new Error("Session status unavailable");
      return Boolean(response.data[input.sessionId] && response.data[input.sessionId].type !== "idle");
    },
    send: async receipt => {
      const { client } = await target(receipt);
      const files = [];
      const inbox = resolve(process.env.LEGALWORK_CHANNEL_INBOX ?? "/data/channel-inbox", receipt.id);
      for (const attachment of receipt.attachments) {
        // Controller writes verified media under this job's private inbox.
        const path = await realpath(attachment.path);
        if (relative(inbox, path).startsWith("..") || !(await stat(path)).isFile()) throw new Error("Attachment outside the channel inbox");
        const file: { type: "file"; mime: string; filename: string; url: string } = { type: "file", mime: attachment.contentType, filename: attachment.filename, url: pathToFileURL(path).href };
        files.push(file);
      }
      const response = await client.session.promptAsync({ sessionID: receipt.sessionId, messageID: receipt.messageId, agent: "legalwork", model: await model(),
        parts: [{ type: "text", text: receipt.text, metadata: { legalworkChannel: receipt.channel, legalworkChannelEvent: receipt.id } }, ...files],
      }, { signal: AbortSignal.timeout(30000) });
      if (!response.response.ok) throw new Error("Channel dispatch could not be confirmed");
    },
    retry: async receipt => { const { client } = await target(receipt); return retryChannelTurn(client, receipt); },
    watch: async (receipt, notify, signal) => {
      const workspace = await options.workspace(receipt.workspaceId);
      if (workspace.workspaceType === "remote" || !isMainAssistant(workspace)) return;
      await watchChannelEvents(options.client(workspace), receipt.sessionId, receipt.messageId, notify, signal);
    },
    result: async input => {
      const { workspace, client } = await target(input);
      const statuses = await client.session.status({}, requestOptions());
      if (!statuses.data) throw new Error("Session status unavailable");
      const response = await client.session.messages({ sessionID: input.sessionId, limit: 100 }, requestOptions());
      const turn = (response.data ?? []).filter(message => message.info.role === "assistant" && message.info.parentID === input.messageId);
      const events = channelLiveEvents(turn, input.messageId);
      if (statuses.data[input.sessionId] && statuses.data[input.sessionId].type !== "idle") return { state: "running", events };
      const final = turn.at(-1);
      if (!final || final.info.role !== "assistant") return Date.now() - (input.lastAttemptAt ?? input.createdAt) < 30000 ? { state: "running", events } : { state: "failed", code: "turn_interrupted", retryable: true, events };
      if (final.info.error) return { state: "failed", code: final.info.error.name === "MessageAbortedError" ? "cancelled" : "engine_error", retryable: retryableChannelError(final.info.error), events };
      if (!final.info.time.completed || !["stop", "length", "content-filter"].includes(final.info.finish ?? "")) return { state: "failed", code: "turn_interrupted", retryable: true, events };
      const text = final.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n").trim();
      const files: z.infer<typeof ChannelFileResult>[] = [];
      for (const message of turn) for (const part of message.parts) {
        if (part.type !== "tool" || part.tool !== "legalwork_assistant_share_file" || part.state.status !== "completed") continue;
        try {
          const output = z.object({ file: z.object({ path: z.string(), title: z.string().optional(), source: z.object({ workspaceId: z.string() }).optional() }) }).parse(channelToolOutput(part.state.output));
          const project = output.file.source ? await options.workspace(output.file.source.workspaceId) : workspace;
          if (project.workspaceType === "remote") continue;
          const path = await resolveWithinRoot(await realpath(project.path), output.file.path);
          const info = await stat(path);
          if (!info.isFile() || info.size > 25 * 1024 * 1024) continue;
          const file = { path: output.file.path, workspaceId: project.id, filename: basename(path), contentType: sharedFileTypes[extname(path).toLowerCase()] ?? "application/octet-stream", size: info.size };
          if (!files.some(existing => existing.workspaceId === file.workspaceId && existing.path === file.path)) files.push(file);
        } catch { /* Only explicit, verified share-file outputs cross the channel boundary. */ }
      }
      if (!text && !files.length && !events.some(item => item.event.type === "message.created")) return { state: "failed", code: "empty_reply", retryable: final.info.finish !== "content-filter", events };
      return { state: "completed", text: text || (files.length ? "I’ve shared the requested file." : ""), files, events };
    },
  }, available);
  const bind = async () => { runtime.bind(await identity()); if (!available()) throw new ApiError(409, "channel_execution_blocked", "Assistant execution is blocked."); };
  const stopSessions = async (sessions: Iterable<{ workspaceId: string; sessionId: string }>) => {
    // Delegated project agents and their children belong to this assistant too.
    // Verify the project and parent link before stopping each child.
    for (const input of sessions) {
      const workspace = await options.workspace(input.workspaceId);
      if (workspace.workspaceType === "remote") throw new Error("Delegated project unavailable");
      const client = options.client(workspace);
      const parent = (await client.session.get({ sessionID: input.sessionId }, requestOptions())).data;
      if (!parent || resolve(parent.directory) !== resolve(workspace.path)) throw new Error("Delegated session changed");
      const descendants = [parent];
      for (let index = 0; index < descendants.length; index++) {
        if (descendants.length > 100) throw new Error("Too many child sessions to stop");
        const children = await client.session.children({ sessionID: descendants[index].id }, requestOptions());
        for (const child of children.data ?? []) if (child.parentID === descendants[index].id && resolve(child.directory) === resolve(workspace.path) && !descendants.some(item => item.id === child.id)) descendants.push(child);
      }
      for (const session of descendants.reverse()) {
        const response = await client.session.abort({ sessionID: session.id }, requestOptions());
        if (response.data !== true) throw new Error("Stop not confirmed");
      }
      const statuses = (await client.session.status({}, requestOptions())).data;
      if (!statuses || descendants.some(session => statuses[session.id] && statuses[session.id].type !== "idle")) throw new Error("Session is still busy");
    }
  };
  const attention = async () => {
    const sessions = new Map<string, { workspaceId: string; sessionId: string }>(runtime.jobs().filter(job => job.state === "running" || job.state === "sending").map(job => [`${job.workspaceId}:${job.sessionId}`, { workspaceId: job.workspaceId, sessionId: job.sessionId }]));
    const source = config.workspaces.find(isMainAssistant);
    if (source) for (const delegation of options.delegations.list(source.id)) sessions.set(`${delegation.workspaceId}:${delegation.sessionId}`, { workspaceId: delegation.workspaceId, sessionId: delegation.sessionId });
    const items = [];
    for (const session of sessions.values()) {
      const workspace = await options.workspace(session.workspaceId); const client = options.client(workspace);
      items.push(...(await readAssistantAttention(client, { workspaceId: workspace.id, sessionId: session.sessionId, projectName: workspace.name, sessionTitle: "Assistant" }))
        .filter(item => item.kind !== "widget").map(item => ({ item, client, revision: runtime.approvalRevision(item.id, item.revision) })));
    }
    return items;
  };
  const snapshot = async () => {
    const links = await projectSyncStore(config);
    const approvals = (await attention()).map(({ item, revision }) => ({ id: item.id, kind: item.kind, revision, sessionId: item.sessionId,
      ...(links.linkByWorkspace(item.workspaceId)?.projectId ? { workspaceId: links.linkByWorkspace(item.workspaceId)?.projectId } : {}),
      ...(item.kind === "approval" ? { permission: item.permission, patterns: item.patterns } : item.kind === "question" ? { questions: item.questions } : {}),
    }));
    const source = config.workspaces.find(isMainAssistant);
    const client = source ? options.client(source) : null;
    const statuses = client ? (await client.session.status({}, requestOptions())).data : {};
    if (!statuses) throw new Error("Assistant status unavailable");
    // Main Assistant schedules use private/local project IDs, not mobile project references.
    const schedules = options.schedules.list().flatMap(task => {
      const projectId = links.linkByWorkspace(task.workspaceId)?.projectId;
      return projectId && config.workspaces.some(project => project.id === task.workspaceId && !isMainAssistant(project)) ? [{ task, projectId }] : [];
    });
    return { running: Object.values(statuses).some(status => status.type !== "idle"), approvals,
      schedules: schedules.map(({ task, projectId }) => ({ id: task.id, workspaceId: projectId, revision: task.revision, title: task.title, prompt: task.prompt,
        status: task.status, schedule: task.schedule, nextRunAt: task.nextRunAt })),
    };
  };
  addRoute(options.routes, "POST", "/channel-runtime/jobs", "host-token", async ctx => {
    await bind(); const input = ChannelInput.parse(await options.body(ctx.request, 512 * 1024));
    const owner = await identity(); if (input.userId !== owner.userId || input.orgId !== owner.orgId) throw new ApiError(403, "channel_owner", "Account mismatch.");
    return options.json(await runtime.accept(input), 202);
  });
  addRoute(options.routes, "POST", "/channel-runtime/configure", "host-token", async () => {
    await bind(); const selected = await model();
    const path = resolve(process.env.XDG_CONFIG_HOME ?? "/data/home/.config", "opencode/opencode.json");
    const config = z.object({ provider: z.record(z.string(), z.unknown()) }).parse(JSON.parse(await readFile(path, "utf8")));
    const provider = config.provider[selected.providerID];
    if (!provider) throw new ApiError(503, "channel_model", "Channel provider unavailable.");
    const fingerprint = createHash("sha256").update(JSON.stringify({ provider, selected })).digest("hex");
    return options.json(await runtime.configure(fingerprint, async () => {
      const workspaces = options.config.workspaces.filter(workspace => workspace.workspaceType !== "remote");
      for (const workspace of workspaces) {
        const statuses = (await options.client(workspace).session.status({}, requestOptions())).data;
        if (!statuses || Object.values(statuses).some(status => status.type !== "idle")) throw new ApiError(409, "channel_busy", "Model configuration waits for idle sessions.");
      }
      // Global OpenCode config is cached at process start. Its runtime file is
      // re-read on dispose, so refresh the managed provider there before reload.
      const primary = options.config.workspaces[0];
      if (!primary || primary.workspaceType === "remote") throw new ApiError(409, "channel_session", "Local Assistant configuration is unavailable.");
      await writeLegalworkRuntimeConfigFile(options.config, primary.id);
      for (const workspace of workspaces) await options.client(workspace).instance.dispose({}, requestOptions());
      const providers = (await options.client(primary).config.providers({}, requestOptions())).data;
      if (!providers?.providers.some(provider => provider.id === selected.providerID && selected.modelID in provider.models))
        throw new ApiError(503, "channel_model", "The engine has not loaded the channel model.");
    }));
  });
  addRoute(options.routes, "GET", "/channel-runtime/jobs/:id", "host-token", async ctx => {
    await bind();
    const waitMs = z.coerce.number().int().min(0).max(3000).parse(ctx.url.searchParams.get("waitMs") ?? 0);
    const after = ctx.url.searchParams.get("after");
    const receipt = await runtime.inspect(ctx.params.id, waitMs && after ? { waitMs, after, signal: ctx.request.signal } : undefined);
    const response = options.json(receipt);
    response.headers.set("X-Channel-Version", channelObservationVersion(receipt));
    return response;
  });
  addRoute(options.routes, "POST", "/channel-runtime/jobs/:id/cancel", "host-token", async ctx => {
    await bind();
    return options.json(await runtime.cancel(ctx.params.id, async receipt => {
      const sessions = [{ workspaceId: receipt.workspaceId, sessionId: receipt.sessionId }];
      for (const delegation of options.delegations.list(receipt.workspaceId)) if (delegation.sourceSessionId === receipt.sessionId)
        sessions.push({ workspaceId: delegation.workspaceId, sessionId: delegation.sessionId });
      await stopSessions(sessions);
    }));
  });
  addRoute(options.routes, "GET", "/channel-runtime/state", "host-token", async () => { await bind(); return options.json(await snapshot()); });
  addRoute(options.routes, "GET", "/channel-runtime/jobs/:id/files/:index", "host-token", async ctx => {
    await bind(); const receipt = await runtime.inspect(ctx.params.id); const index = z.coerce.number().int().min(0).parse(ctx.params.index);
    const file = receipt.files[index]; if (receipt.state !== "completed" || !file) throw new ApiError(404, "channel_file", "No shared file.");
    const workspace = await options.workspace(file.workspaceId);
    const path = await resolveWithinRoot(await realpath(workspace.path), file.path); const info = await stat(path);
    if (!info.isFile() || info.size !== file.size || info.size > 25 * 1024 * 1024) throw new ApiError(409, "channel_file_changed", "Shared file changed.");
    return new Response(await readFile(path), { headers: { "Content-Type": file.contentType, "Cache-Control": "no-store" } });
  });
  addRoute(options.routes, "POST", "/channel-runtime/commands", "host-token", async ctx => {
    await bind(); const input = ChannelCommand.parse(await options.body(ctx.request, 64000)); const owner = await identity();
    if (input.userId !== owner.userId || input.orgId !== owner.orgId) throw new ApiError(403, "channel_owner", "Account mismatch.");
    return options.json(await runtime.command(input, async command => {
      if (command.kind === "approval.reply") {
        const candidate = (await attention()).find(item => item.item.id === command.targetId && item.revision === command.revision);
        if (!candidate) throw new Error("Approval changed");
        const { item, client } = candidate;
        const ref = { workspaceId: item.workspaceId, sessionId: item.sessionId, id: item.id, revision: item.revision };
        if (item.kind === "approval" && command.reply && !command.answers) await replyToAssistantAttention(client, item, { ...ref, kind: "approval", reply: command.reply });
        else if (item.kind === "question" && command.answers && !command.reply) await replyToAssistantAttention(client, item, { ...ref, kind: "question", answers: command.answers });
        else throw new Error("Approval response does not match");
        return { applied: true };
      }
      if (command.kind === "schedule.update") {
        const task = options.schedules.list().find(task => task.id === command.targetId && task.revision === command.revision);
        if (!task || !config.workspaces.some(project => project.id === task.workspaceId && !isMainAssistant(project))) throw new Error("Schedule changed");
        await options.workspace(task.workspaceId); options.schedules.update(task.workspaceId, task.id, task.revision, command.patch); return { applied: true };
      }
      const sessions = new Map<string, { workspaceId: string; sessionId: string }>(runtime.jobs().filter(job => ["running", "sending"].includes(job.state))
        .map(job => [`${job.workspaceId}:${job.sessionId}`, job]));
      const source = config.workspaces.find(isMainAssistant);
      if (source) for (const delegation of options.delegations.list(source.id))
        sessions.set(`${delegation.workspaceId}:${delegation.sessionId}`, delegation);
      if (!sessions.size) throw new Error("Assistant activity changed");
      await stopSessions(sessions.values());
      return { stopped: true };
    }));
  });
  return runtime;
}
