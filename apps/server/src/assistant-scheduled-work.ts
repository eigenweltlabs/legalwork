import { resolve } from "node:path";
import type { AssistantEngineClient, Session } from "./assistant-engine.js";
import type { ScheduledTask } from "@legalwork/types/scheduled-tasks";
import type { AssistantDelegations } from "./assistant-delegations.js";
import type { MainAssistant } from "./main-assistant.js";
import type { WorkspaceInfo } from "./types.js";
import { ApiError } from "./errors.js";

/** A parent ID links the work for tracking, without copying the daily chat's messages. */
export async function createAssistantScheduledSession(task: ScheduledTask, assistant: Pick<MainAssistant, "current">, client: AssistantEngineClient) {
  const { workspace, day } = await assistant.current();
  const result = await client.session.create({ parentID: day.sessionId, title: task.title }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
  const session = result.data;
  if (!session || session.parentID !== day.sessionId || resolve(session.directory) !== resolve(workspace.path))
    throw new ApiError(502, "schedule_worker_scope", "The engine did not create an isolated Assistant worker.");
  return session.id;
}

/** Track completion durably; only the final result returns to the daily chat. */
export async function prepareAssistantScheduledWork(task: ScheduledTask, workspace: WorkspaceInfo, session: Session, client: AssistantEngineClient, delegations: Pick<AssistantDelegations, "track">) {
  if (!session.parentID) throw new ApiError(400, "schedule_worker_required", "Assistant schedules must run in an isolated worker.");
  const options = { throwOnError: true, signal: AbortSignal.timeout(10000) };
  const parent = (await client.session.get({ sessionID: session.parentID }, options)).data;
  if (!parent || parent.parentID || resolve(parent.directory) !== resolve(workspace.path) || parent.time.archived)
    throw new ApiError(400, "schedule_worker_parent", "The Assistant worker's source chat is no longer available.");
  const history = await client.session.messages({ sessionID: parent.id, limit: 1 }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
  const last = history.data?.at(-1)?.info;
  const model = task.model ?? (last?.role === "assistant" ? { providerID: last.providerID, modelID: last.modelID } : last?.model) ?? null;
  delegations.track({ workspaceId: workspace.id, sessionId: session.id, sourceWorkspaceId: workspace.id, sourceSessionId: parent.id,
    scheduledTaskId: task.id, title: task.title, scope: `Carry out the scheduled task ${JSON.stringify(task.title)}.`, model,
    authority: { scope: task.wikiScope, scheduledProjects: task.projectAccess === "all" ? "all" : [workspace.id] } });
  return {
    model,
    prompt: `[Scheduled task: ${task.title}]\n\nYou are the isolated background worker for this scheduled task, not the user's daily conversation. Do the research and tool work in this session. Keep raw records, transcripts and intermediate tool outputs here. Do not react, send a conversational acknowledgement, or repeat the task in the daily chat. Stay within the task's existing permissions and authorized scope. Save detailed deliverables in the project. Finish with a concise, complete result: the verified outcome or blocker, the essential next actions, and exact paths to saved deliverables. Choose the length needed to communicate the result accurately. Your final result will be delivered back to the Assistant automatically; do not start another session to report it.\n\nTask:\n${task.prompt}`,
  };
}
