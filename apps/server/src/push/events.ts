import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { MainAssistant } from "../main-assistant.js";
import { isMainAssistant } from "../main-assistant.js";
import type { AssistantDelegations } from "../assistant-delegations.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { readSessionInbox } from "../session-inbox.js";
import { readAssistantAttention } from "../assistant-attention.js";
import type { PushEvent } from "./apns.js";

export async function readPushEvents(config: ServerConfig, assistant: MainAssistant, delegations: AssistantDelegations,
  client: (workspace: WorkspaceInfo) => OpencodeClient): Promise<PushEvent[]> {
  const workspace = config.workspaces.find(isMainAssistant);
  if (!workspace) return [];
  const events: PushEvent[] = [];
  const replySessions = new Map<string, string>();
  const engine = client(workspace);
  const options = () => ({ signal: AbortSignal.timeout(10_000), throwOnError: true });
  const statuses = await engine.session.status({}, options());
  if (!statuses.data) throw new Error("Assistant status is unavailable.");
  const inbox = await readSessionInbox(config, [workspace], []);
  // Only the latest real reply of an idle turn qualifies. Tool acknowledgements,
  // compaction summaries, project transcripts, and partial streaming never do.
  for (const entry of inbox.filter(item => Date.now() - (item.assistantAt ?? 0) < 86400_000)) {
    if (statuses.data[entry.sessionId]?.type && statuses.data[entry.sessionId].type !== "idle") continue;
    const response = await engine.session.messages({ sessionID: entry.sessionId, limit: 1 }, options());
    const last = response.data?.at(-1);
    if (!last || last.info.role !== "assistant" || last.info.summary || last.info.error || !last.info.time.completed
      || !["stop", "length", "content-filter"].includes(last.info.finish ?? "")) continue;
    const body = last.parts.flatMap(part => part.type === "text" && !part.synthetic ? [part.text] : []).join("\n").trim();
    replySessions.set(`reply:${workspace.id}:${last.info.id}`, entry.sessionId);
    events.push({ id: `reply:${workspace.id}:${last.info.id}`, at: last.info.time.completed,
      title: assistant.profile().name ?? "Assistant", body: body.slice(0, 240) || "Shared a file with you.", tab: 0, kind: "reply" });
  }
  // Match the Assistant's presented approval inbox, not arbitrary project work.
  const cards = delegations.cards().filter(card => card.visible && Date.now() - card.presentedAt < 86400_000);
  const groups = new Map(cards.map(card => [`${card.workspaceId}:${card.sessionId}`, card]));
  const results = await Promise.allSettled([...groups.values()].map(async card => {
    const project = config.workspaces.find(item => item.id === card.workspaceId);
    if (!project) return [];
    const items = await readAssistantAttention(client(project), { workspaceId: project.id, sessionId: card.sessionId,
      projectName: project.displayName || project.name, sessionTitle: "" });
    return items.flatMap(item => {
      const presented = cards.find(value => value.id === item.id && value.revision === item.revision);
      if (!presented || item.kind === "widget") return [];
      const event: PushEvent = { id: `approval:${item.id}:${item.revision}`, at: presented.presentedAt,
        title: "Your review is needed", body: presented.title, tab: 1, kind: "approval" };
      return [event];
    });
  }));
  for (const result of results) {
    if (result.status === "rejected") throw new Error("Approval status is unavailable.");
    events.push(...result.value);
  }
  // Recheck after reading messages: a new turn may have started during the read.
  const finalStatuses = await engine.session.status({}, options());
  if (!finalStatuses.data) throw new Error("Assistant status is unavailable.");
  const busySessions = new Set(inbox.filter(entry => {
    const status = finalStatuses.data?.[entry.sessionId]?.type;
    return status && status !== "idle";
  }).map(entry => entry.sessionId));
  if (busySessions.size) {
    // Reply IDs include the message identity; retain only replies from sessions
    // observed idle both before and after the message fetch.
    return events.filter(event => event.kind !== "reply" || !replySessions.has(event.id) || !busySessions.has(replySessions.get(event.id)!));
  }
  return events;
}
