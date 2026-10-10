import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client";

/** Engine events are wake-up hints. Receipts and public output still come from the durable inbox. */
export function channelEventWakes(event: Event, sessionId: string, messageId: string) {
  if (!("sessionID" in event.properties) || event.properties.sessionID !== sessionId) return false;
  if (event.type === "message.updated") return event.properties.info.role === "assistant" &&
    event.properties.info.parentID === messageId && Boolean(event.properties.info.time.completed || event.properties.info.error);
  if (event.type === "message.part.updated") {
    const part = event.properties.part;
    return part.type === "text" ? part.time?.end !== undefined && !part.synthetic && !part.ignored :
      part.type === "tool" && (part.state.status === "completed" || part.state.status === "error");
  }
  return event.type === "session.idle" || event.type === "session.error" ||
    (event.type === "session.status" && event.properties.status.type === "idle") ||
    event.type === "permission.asked" || event.type === "permission.v2.asked" ||
    event.type === "question.asked" || event.type === "question.v2.asked";
}

export async function watchChannelEvents(client: OpencodeClient, sessionId: string, messageId: string,
  notify: () => void, signal: AbortSignal) {
  // Each host long-poll owns this short subscription. A broken SSE connection
  // falls back to its bounded receipt refresh instead of retrying privately.
  const { stream } = await client.event.subscribe({}, { signal, sseMaxRetryAttempts: 1 });
  for await (const event of stream) {
    if (signal.aborted) break;
    if (channelEventWakes(event, sessionId, messageId)) notify();
  }
}

/** Retain a hint arriving during inspection; remove timers and abort listeners on every exit. */
export function channelEventWait(waitMs: number, signal: AbortSignal) {
  let settle: () => void = () => {};
  const done = new Promise<void>(resolve => { settle = resolve; });
  const timer = setTimeout(() => settle(), waitMs);
  const abort = () => settle();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) settle();
  return { done, notify: () => settle(), close: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
}
