import { enqueueAssistantSubmission, sendAssistantSubmission } from "./assistant-submission-send.js";
import { LauncherFolders } from "./launcher-folders.js";
import type { QueueEntry } from "./session-queue-schema.js";
import { getMessageQueue } from "./session-message-queue.js";
import { AssistantConversations } from "./assistant-conversations.js";
import { AssistantSubmissions } from "./assistant-submissions.js";
import { QuickActionStore } from "./launcher-actions.js";
import { LauncherContextStore } from "./launcher-context.js";
import { LauncherFileIndex } from "./launcher-file-index.js";
import type { DocumentPreparation } from "./document-preparation/service.js";
import { assistantSubscriptionAvailable, requireAssistantSubscription, requireAssistantWorkspaceSubscription } from "./assistant-subscription.js";
import { resolve } from "node:path";
import { ApiError, findApiError } from "./errors.js";
import { isCompactionCommand } from "./native-command-control.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { runtimeDbPath } from "./runtime-db.js";
import { createAssistantEngineClient } from "./assistant-engine.js";
import { MainAssistant, isMainAssistant } from "./main-assistant.js";
import { AssistantSessionAccess, assertAssistantDispatchAuthority } from "./assistant-session-access.js";
import { AssistantDelegations } from "./assistant-delegations.js";
import { readDelegationResult } from "./assistant-delegation-result.js";
import { createAssistantSessionQueue } from "./assistant-session-executor.js";
import { registerMainAssistantRoutes } from "./routes/main-assistant.js";
import { withSessionDispatch, withSessionExecution } from "./session-execution-gate.js";
import { announceSyncChange } from "./app-sync-events.js";
import type { Route } from "./routes/registry.js";
import { AssistantPush } from "./push/service.js";
import { readPushEvents } from "./push/events.js";
import { registerPushRoutes } from "./push/routes.js";
import { migrateMorningBriefing } from "./assistant-briefing.js";
import { registerAssistantProactivityRoutes } from "./routes/assistant-proactivity.js";
import { startAssistantProactivity } from "./assistant-proactivity.js";
import { assistantLanguageContext } from "./assistant-language-context.js";
import { createAssistantScheduledSession, prepareAssistantScheduledWork } from "./assistant-scheduled-work.js";
import type { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import type { ScheduledTask } from "./scheduled-tasks/schema.js";

const unwrapOpencodeResult = <T>(result: { data?: T; response: Response }, path: string): T => {
  if (!result.response.ok || result.data === undefined) throw new ApiError(result.response.status, "assistant_engine", `Could not read ${path}.`);
  return result.data;
};
type Helpers = Pick<Parameters<typeof registerMainAssistantRoutes>[0], "jsonResponse" | "readJsonBodyLimited" | "ensureWritable" | "requireClientScope" | "requireApproval">;

export async function createAssistantRuntime(config: ServerConfig, options: {
  scheduledTasks: ScheduledTaskStore;
  preparation: DocumentPreparation;
  deferStart?: boolean;
  resolveWorkspace: (id: string) => Promise<WorkspaceInfo>;
  changed: () => void;
  tokenActive: (hash: string) => Promise<boolean>;
}) {
  const scheduledTasks = options.scheduledTasks;
  const resolveWorkspace = (_config: ServerConfig, id: string) => options.resolveWorkspace(id);
  const createWorkspaceOpencodeClient = createAssistantEngineClient;
  const restartReloadWatchers = options.changed;
  const prepareWorkspacePrompt = async (_config: ServerConfig, workspace: WorkspaceInfo, _directory: string) => {
    await requireAssistantSubscription(config);
    await createWorkspaceOpencodeClient(config, workspace).native.model.list({ location: { directory: workspace.path } });
  };
  const assistantSessionAccess = await AssistantSessionAccess.open(runtimeDbPath(config), config);
  const mainAssistant = await MainAssistant.open(config, runtimeDbPath(config), workspace => {
    const client = createWorkspaceOpencodeClient(config, workspace);
    return {
      get: async id => {
        const result = await client.session.get({ sessionID: id }, { signal: AbortSignal.timeout(10000) });
        return result.response.status === 404 ? null : unwrapOpencodeResult(result, "/session");
      },
      list: async () => unwrapOpencodeResult(await client.session.list({}, { signal: AbortSignal.timeout(10000) }), "/session"),
      create: async title => unwrapOpencodeResult(await client.session.create({ title }, { signal: AbortSignal.timeout(10000) }), "/session"),
    };
  }, () => { restartReloadWatchers(); announceSyncChange(config, "projects"); });
  const delegationSession = async (workspaceId: string, sessionId: string) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    const client = createWorkspaceOpencodeClient(config, workspace);
    const session = unwrapOpencodeResult(await client.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(10000) }), "/session");
    if (resolve(session.directory) !== resolve(workspace.path)) throw new Error("The delegated chat is outside this project.");
    return { workspace, client, session };
  };
  // Conversations are explicit and stable; delegated results return to the conversation that started them.
  const conversations = await AssistantConversations.open(runtimeDbPath(config), workspaceId => mainAssistant.days(workspaceId));
  const delegations = await AssistantDelegations.open(runtimeDbPath(config), {
    allowed: delegation => !config.workspaces.some(workspace => workspace.id === delegation.sourceWorkspaceId && isMainAssistant(workspace)) || mainAssistant.canAccessProject(delegation.workspaceId),
    result: async (delegation, requestMessageId) => {
      const { client, session } = await delegationSession(delegation.workspaceId, delegation.sessionId);
      if (session.time.archived) return null;
      const children = await client.session.children({ sessionID: session.id }, { signal: AbortSignal.timeout(10000) });
      for (const child of children.data ?? []) if (child.parentID === session.id && resolve(child.directory) === resolve(session.directory) && !child.time.archived)
        delegations.track({ ...delegation, sessionId: child.id, title: child.title, inputOnly: true, initialMessageId: undefined, authoritySessionId: delegation.authoritySessionId ?? delegation.sessionId });
      const result = await readDelegationResult(client, session.id, requestMessageId);
      return delegation.inputOnly && result?.outcome !== "input-required" ? null : result;
    },
    destination: async delegation => {
      const source = await resolveWorkspace(config, delegation.sourceWorkspaceId);
      if (isMainAssistant(source)) {
        // No silent midnight retargeting: the origin conversation receives its results. Only an archived or
        // deleted origin falls back to the current conversation, which keeps a link back through Work.
        const origin = await createWorkspaceOpencodeClient(config, source).session.get({ sessionID: delegation.sourceSessionId }, { signal: AbortSignal.timeout(10000) });
        if (origin.data && !origin.data.time.archived && resolve(origin.data.directory) === resolve(source.path)) return { workspaceId: source.id, sessionId: origin.data.id };
        const current = conversations.current(source.id);
        if (current) return { workspaceId: source.id, sessionId: current.sessionId };
        const { workspace, day } = await mainAssistant.current();
        return { workspaceId: workspace.id, sessionId: day.sessionId };
      }
      return { workspaceId: source.id, sessionId: delegation.sourceSessionId };
    },
    idle: async destination => {
      if (config.readOnly || !await assistantSubscriptionAvailable(config)) return false;
      const { client, session } = await delegationSession(destination.workspaceId, destination.sessionId);
      if (session.time.archived) return false;
      const statuses = unwrapOpencodeResult(await client.session.status({}, { signal: AbortSignal.timeout(10000) }), "/session/status");
      return !statuses[session.id] || statuses[session.id].type === "idle";
    },
    hasMessage: async (destination, messageId) => {
      const { client } = await delegationSession(destination.workspaceId, destination.sessionId);
      const result = await client.session.message({ sessionID: destination.sessionId, messageID: messageId }, { signal: AbortSignal.timeout(10000) });
      if (result.response.status === 404) return false;
      return unwrapOpencodeResult(result, "/session/message").info.id === messageId;
    },
    send: (delegation, notice) => withSessionExecution(config, notice.sessionId, async () => {
      const worker = await delegationSession(delegation.workspaceId, delegation.authoritySessionId ?? delegation.sessionId);
      const authority = await assistantSessionAccess.prepare(worker.session.id, worker.session.directory, delegation.authority);
      assertAssistantDispatchAuthority(authority, worker.workspace.id);
      const { workspace, client, session } = await delegationSession(notice.workspaceId, notice.sessionId);
      await assistantSessionAccess.prepareReturn(session.id, session.directory, authority);
      await prepareWorkspacePrompt(config, workspace, session.directory);
      const languageContext = isMainAssistant(workspace) ? await assistantLanguageContext(client.native.message,
        [notice.sessionId, ...mainAssistant.history(workspace.id).days.map(day => day.sessionId)]) : "";
      const result = await client.session.promptAsync({ sessionID: notice.sessionId, messageID: notice.messageId, agent: "legalwork", ...(delegation.model ? { model: delegation.model } : {}),
        parts: [{ type: "text", text: notice.text + languageContext, synthetic: true }] }, { signal: AbortSignal.timeout(30000) });
      if (!result.response.ok) throw new Error("Could not confirm delivery of the delegated result.");
      announceSyncChange(config, "sessions");
    }, true),
  });
  const sessionQueue = await createAssistantSessionQueue(runtimeDbPath(config), { workspace: id => resolveWorkspace(config, id),
    client: workspace => createWorkspaceOpencodeClient(config, workspace), assistant: mainAssistant, changed: () => announceSyncChange(config, "sessions"),
    config, access: assistantSessionAccess, watchRequest: (sessionId, messageId) => delegations.watchRequest(sessionId, messageId),
    preparePrompt: (workspace, directory) => prepareWorkspacePrompt(config, workspace, directory) });

  const submissions = await AssistantSubmissions.open(runtimeDbPath(config), {
    waiting: async (entry, payload) => {
      if (!payload.queue) return false;
      const queue = await getMessageQueue(config).read(entry.workspaceId, entry.sessionId);
      return queue.entries.some(item => item.id === payload.queue?.id && item.messageId === entry.messageId && (item.status === "queued" || item.status === "failed"));
    },
    hasMessage: async (target, messageId, payload) => {
      if (payload.queue) {
        const queue = await getMessageQueue(config).read(target.workspaceId, target.sessionId);
        if (queue.entries.some(item => item.id === payload.queue?.id && item.messageId === messageId) || queue.completedIds.includes(payload.queue.id)) return true;
      }
      const { client } = await delegationSession(target.workspaceId, target.sessionId);
      const pending = await client.native.session.inbox.list({ sessionID: target.sessionId }, { signal: AbortSignal.timeout(10000) });
      if (pending.some(item => item.id === messageId)) return true;
      try {
        const result = await client.native.session.message.get({ sessionID: target.sessionId, messageID: messageId }, { signal: AbortSignal.timeout(10000) });
        return result.id === messageId;
      } catch (error) {
        if (findApiError(error)?.status === 404) return false;
        throw error;
      }
    },
    send: async (entry, payload) => {
      await requireAssistantWorkspaceSubscription(config, entry.workspaceId);
      if (payload.queue) {
        await enqueueAssistantSubmission(getMessageQueue(config), entry, payload);
        announceSyncChange(config, "sessions");
        return;
      }
      await withSessionDispatch(config, entry.sessionId, async () => {
        const { client } = await delegationSession(entry.workspaceId, entry.sessionId);
        await sendAssistantSubmission(client, entry, payload);
        announceSyncChange(config, "sessions");
      });
    },
    outcome: async (target, messageId, payload) => {
      const { client } = await delegationSession(target.workspaceId, target.sessionId);
      if (payload.queue) {
        const queue = await getMessageQueue(config).read(target.workspaceId, target.sessionId);
        const waiting = queue.entries.find(item => item.id === payload.queue?.id);
        if (waiting?.messageId && waiting.messageId !== messageId) return "failed";
        if (waiting?.status === "queued" || waiting?.status === "failed") return "accepted";
        if (!waiting && queue.completedIds.includes(payload.queue.id)) {
          const message = await client.session.message({ sessionID: target.sessionId, messageID: messageId }, { signal: AbortSignal.timeout(10000) });
          if (message.response.status === 404) return "failed"; // Removed before delivery.
        }
      }
      if (payload.command && isCompactionCommand(payload.command.name)) {
        if ((await client.native.session.inbox.list({ sessionID: target.sessionId })).some(item => item.id === messageId)) return "accepted";
        const message = await client.native.session.message.get({ sessionID: target.sessionId, messageID: messageId });
        return message.type === "compaction" ? message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "running" : "accepted";
      }
      const [statuses, messages] = await Promise.all([
        client.session.status({}, { signal: AbortSignal.timeout(10000) }),
        client.session.messages({ sessionID: target.sessionId, untilMessageID: messageId }, { signal: AbortSignal.timeout(10000) }),
      ]);
      const list = messages.data ?? [];
      const reply = [...list].reverse().find(message => message.info.role === "assistant" && message.info.parentID === messageId);
      if (reply?.info.role === "assistant") {
        if (reply.info.error || reply.info.finish === "length") return "failed";
        if (reply.info.time.completed && reply.info.finish === "stop") return "completed";
        return "running";
      }
      const status = statuses.data?.[target.sessionId];
      return status && status.type !== "idle" ? "running" : "accepted";
    },
  });
  const launcher = { conversations, submissions, quickActions: await QuickActionStore.open(runtimeDbPath(config)), searchFolders: await LauncherFolders.open(runtimeDbPath(config)), stagedContext: new LauncherContextStore(), fileIndex: new LauncherFileIndex() };

  const push = await AssistantPush.open(runtimeDbPath(config),
    () => readPushEvents(config, mainAssistant, delegations, workspace => createWorkspaceOpencodeClient(config, workspace)), options.tokenActive);
  async function register(routes: Route[], helpers: Helpers) {
    const { readJsonBodyLimited } = helpers;
    const assistantRoutes: Parameters<typeof registerMainAssistantRoutes>[0] = { ...helpers, ...launcher, preparation: options.preparation, routes, config, assistant: mainAssistant, delegations, sessionQueue, sessionAccess: assistantSessionAccess,
      preparePrompt: (workspace, directory) => prepareWorkspacePrompt(config, workspace, directory), resolveWorkspace,
      client: workspace => createWorkspaceOpencodeClient(config, workspace), changed: () => { options.changed(); announceSyncChange(config, "projects"); } };
    registerMainAssistantRoutes(assistantRoutes);
    registerAssistantProactivityRoutes(assistantRoutes, scheduledTasks);
    registerPushRoutes(routes, push, readJsonBodyLimited);
  }
  let startPromise: Promise<void> | undefined, closed = false;
  let stopPush: ReturnType<typeof push.start> | undefined;
  let stopMain: ReturnType<typeof mainAssistant.start> | undefined;
  let stopDelegations: ReturnType<typeof delegations.start> | undefined;
  let stopQueue: ReturnType<typeof sessionQueue.start> | undefined;
  let stopProactivity: Awaited<ReturnType<typeof startAssistantProactivity>> | undefined;
  const start = () => {
    if (closed) return Promise.resolve();
    return startPromise ??= (async () => {
      stopPush = push.start();
      migrateMorningBriefing(config, scheduledTasks);
      if (!config.readOnly) {
        stopMain = mainAssistant.start(undefined, () => assistantSubscriptionAvailable(config));
        stopDelegations = delegations.start();
        stopQueue = sessionQueue.start();
      }
      stopProactivity = await startAssistantProactivity(config, mainAssistant, options.resolveWorkspace, assistantSessionAccess);
    })();
  };
  if (!options.deferStart) await start();
  return {
    register, start,
    prepareQueuedSubmission: (workspaceId: string, sessionId: string, entry: QueueEntry) => submissions.prepareQueued({ workspaceId, sessionId }, entry, async ceiling => {
      const { workspace, session } = await delegationSession(workspaceId, sessionId);
      const authority = await assistantSessionAccess.prepare(sessionId, session.directory, ceiling);
      assertAssistantDispatchAuthority(authority, workspace.id);
    }),
    scheduledSession: async (task: ScheduledTask, workspace: WorkspaceInfo) => {
      if (!isMainAssistant(workspace)) return null;
      await requireAssistantSubscription(config);
      return createAssistantScheduledSession(task, mainAssistant, createWorkspaceOpencodeClient(config, workspace));
    },
    scheduledWork: async (task: ScheduledTask, workspace: WorkspaceInfo, sessionId: string) => {
      if (isMainAssistant(workspace)) await requireAssistantSubscription(config);
      const client = createWorkspaceOpencodeClient(config, workspace);
      const session = unwrapOpencodeResult(await client.session.get({ sessionID: sessionId }, { throwOnError: true }), "/session");
      await assistantSessionAccess.authorize(sessionId, session.directory, { scope: task.wikiScope, scheduledProjects: task.projectAccess === "all" ? "all" : [workspace.id] });
      return isMainAssistant(workspace) ? prepareAssistantScheduledWork(task, workspace, session, client, delegations) : { model: task.model, prompt: task.prompt };
    },
    async close() {
      closed = true; await startPromise?.catch(() => {});
      stopMain?.(); await stopProactivity?.(); await stopDelegations?.(); await stopQueue?.(); await stopPush?.();
      launcher.fileIndex.dispose();
    },
  };
}
