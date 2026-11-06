import type { AssistantEngineClient } from "./assistant-engine.js";
import type { DelegationResult } from "./assistant-delegations.js";

/** Read both terminal replies and input requests, which can keep the engine busy. */
export async function readDelegationResult(client: AssistantEngineClient, sessionId: string, requestMessageId?: string): Promise<DelegationResult | null> {
  const options = () => ({ signal: AbortSignal.timeout(10000) });
  const [statuses, messages] = await Promise.all([
    client.session.status({}, options()),
    client.session.messages({ sessionID: sessionId, limit: 1 }, options()),
  ]);
  if (!statuses.data || !messages.data) throw new Error("Could not read delegated chat progress.");
  const last = messages.data.at(-1);
  // A queued follow-up must not consume the previous turn or an unrelated direct message.
  if (requestMessageId && (last?.info.role === "user" ? last.info.id : last?.info.parentID) !== requestMessageId) return null;
  const idle = !statuses.data[sessionId] || statuses.data[sessionId].type === "idle";
  if (idle && last?.info.role === "assistant" && last.info.sessionID === sessionId && !last.info.summary) {
    const text = last.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n");
    // Interrupted/error messages do not always receive a completed timestamp.
    if (last.info.error) return { messageId: last.info.id, outcome: last.info.error.name === "MessageAbortedError" ? "interrupted" : "failed", text: `${text}\n${JSON.stringify(last.info.error)}` };
    if (last.info.time.completed && (last.info.finish === "stop" || last.info.finish === "length"))
      return { messageId: last.info.id, outcome: last.info.finish === "length" ? "failed" : "reply", text };
  }
  // Engine versions expose legacy and v2 endpoints independently. Read both,
  // deduplicate request IDs, and never treat a failed request as completion.
  const pending = await Promise.allSettled([
    client.v2.session.question.list({ sessionID: sessionId }, options()).then(result => Array.isArray(result.data?.data) ? result.data.data : []),
    client.v2.session.permission.list({ sessionID: sessionId }, options()).then(result => Array.isArray(result.data?.data) ? result.data.data : []),
  ]);
  const requests = new Map<string, unknown>();
  for (const [index, result] of pending.entries()) {
    if (result.status !== "fulfilled") continue;
    const kind = index === 0 ? "question" : "approval";
    for (const request of result.value) if (request.sessionID === sessionId) requests.set(`${kind}:${request.id}`, { kind, ...request });
  }
  if (!requests.size) return null;
  return { messageId: [...requests.keys()].sort().join("|"), outcome: "input-required", text: JSON.stringify([...requests.values()]) };
}
