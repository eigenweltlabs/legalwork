import { z } from "zod";
import type { AssistantEngineClient } from "./assistant-engine.js";

/** Native durable events are wake-up hints; public output is read from history. */
export function channelEventWakes(event: { type: string; data?: unknown }, sessionId: string, _messageId: string) {
  const data = z.object({ sessionID: z.string() }).passthrough().safeParse(event.data);
  if (!data.success || data.data.sessionID !== sessionId) return false;
  return ["session.text.ended", "session.tool.success", "session.tool.failed", "session.step.ended", "session.step.failed",
    "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "permission.asked", "form.created"].includes(event.type);
}

export async function watchChannelEvents(client: AssistantEngineClient, sessionId: string, messageId: string,
  notify: () => void, signal: AbortSignal, textEnded?: (messageId: string, ordinal: number) => void) {
  for await (const event of client.native.event.subscribe({ signal })) {
    if (signal.aborted) break;
    if (event.type === "session.text.ended" && event.data.sessionID === sessionId) textEnded?.(event.data.assistantMessageID, event.data.ordinal);
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
