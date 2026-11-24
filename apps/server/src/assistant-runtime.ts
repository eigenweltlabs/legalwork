import { registeredMessageQueue } from "./session-message-queue.js";
import { dispatchQueueAction } from "./session-dispatch.js";
import { localWorkdayModel, type WorkdayModel } from "./back-office/timesheet-schema.js";
import { assistantSubscriptionAvailable, requireAssistantSubscription } from "./assistant-subscription.js";
import { resolve } from "node:path";
import { ApiError } from "./errors.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { runtimeDbPath } from "./runtime-db.js";
import { createAssistantEngineClient } from "./assistant-engine.js";
import { MainAssistant, isMainAssistant } from "./main-assistant.js";
import { AssistantSessionAccess, assertAssistantDispatchAuthority } from "./assistant-session-access.js";
import { AssistantDelegations } from "./assistant-delegations.js";
import { readDelegationResult } from "./assistant-delegation-result.js";
import { createAssistantSessionQueue } from "./assistant-session-executor.js";
import type { Route } from "./routes/registry.js";
import { registerMainAssistantRoutes } from "./routes/main-assistant.js";
import { withSessionExecution } from "./session-execution-gate.js";
import { announceSyncChange } from "./app-sync-events.js";
import { AssistantPush } from "./push/service.js";
import { readPushEvents } from "./push/events.js";
import { registerPushRoutes } from "./push/routes.js";
import { migrateMorningBriefing } from "./assistant-briefing.js";
import { openTimekeepingProject, registerTimeChatRoutes } from "./time-capture/chat-project.js";
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

  const push = await AssistantPush.open(runtimeDbPath(config),
    () => readPushEvents(config, mainAssistant, delegations, workspace => createWorkspaceOpencodeClient(config, workspace)), options.tokenActive);
  async function register(routes: Route[], helpers: Helpers) {
    const { readJsonBodyLimited } = helpers;
    const assistantRoutes: Parameters<typeof registerMainAssistantRoutes>[0] = { ...helpers, routes, config, assistant: mainAssistant, delegations, sessionQueue, sessionAccess: assistantSessionAccess,
      preparePrompt: (workspace, directory) => prepareWorkspacePrompt(config, workspace, directory), resolveWorkspace,
      client: workspace => createWorkspaceOpencodeClient(config, workspace), changed: () => { options.changed(); announceSyncChange(config, "projects"); } };
    registerTimeChatRoutes(config, routes, mainAssistant, assistantRoutes.changed);
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
    async startTimeReview(profileId: string, date: string, requestId: string, model?: Pick<WorkdayModel, "providerID" | "modelID">, previousDate?: string) {
      const workspace = await openTimekeepingProject(config, profileId, options.changed);
      const { day } = await mainAssistant.projectDay(workspace);
      const authority = { scope: "owner" as const, scheduledProjects: [workspace.id] };
      await assistantSessionAccess.authorize(day.sessionId, workspace.path, authority);
      const prompt = "Review my work on " + date + " and create client-ready time suggestions. Use the timekeeping workday tool to read my activity, booked entries and existing drafts. Read the guidelines for each matter, then publish the suggestions to my timeline as you prepare them." +
        " Describe the human work in concise invoice language and omit activity you cannot substantiate." +
        (previousDate ? " Also review " + previousDate + " for uncovered work after its last check. Read that date separately, respect existing entries and user edits, and publish any missing suggestions on their original service date." : "");
      const queue = registeredMessageQueue(config);
      if (!queue) throw new ApiError(503, "queue_unavailable", "The chat queue is starting. Try again.");
      const native = createWorkspaceOpencodeClient(config, workspace).native;
      const session = await native.session.get({ sessionID: day.sessionId });
      const models = (await native.model.list({ location: session.location })).data;
      if (model?.providerID === localWorkdayModel.providerID && model.modelID === localWorkdayModel.modelID &&
          !models.some(item => item.providerID === model.providerID && (item.id === model.modelID || item.modelID === model.modelID)))
        throw new ApiError(409, "timekeeping_model", "The selected local model is unavailable. Choose a model in the Timekeeping chat.");
      const agents = (await native.agent.list({ location: session.location })).data.filter(item => !item.hidden && item.mode !== "subagent");
      const agent = agents.find(item => item.id === session.agent) ?? agents[0];
      if (!agent) throw new ApiError(409, "timekeeping_chat", "Choose an available agent in the Timekeeping chat.");
      const action = dispatchQueueAction({ kind: "prompt", id: "msg_time_" + requestId, text: prompt, agent: agent.id,
        ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}) });
      const submitted = await queue.act(workspace.id, day.sessionId, action);
      const receipt = submitted.entries.find(item => item.id === action.id);
      if (receipt?.status === "failed" || receipt?.status === "uncertain") throw new ApiError(409, "timekeeping_chat", receipt.error ?? "Check the Timekeeping chat.");
      announceSyncChange(config, "sessions");
    },
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
    },
  };
}
