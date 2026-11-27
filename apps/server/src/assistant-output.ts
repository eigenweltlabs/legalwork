import type { AssistantEngineClient } from "./assistant-engine.js";
import type { AssistantSubmission, AssistantOutput } from "@legalwork/types/launcher";

/** Read the answer belonging to this exact operation, including older turns. */
export async function readAssistantOutput(client: AssistantEngineClient, submission: AssistantSubmission): Promise<AssistantOutput> {
  const identity = { requestId: submission.requestId, messageId: submission.messageId, conversationId: submission.conversationId };
  const signal = AbortSignal.timeout(10_000);
  const result = await client.session.messages({ sessionID: submission.sessionId, untilMessageID: submission.messageId }, { signal, throwOnError: true });
  const messages = result.data ?? [];
  const answers = messages.filter(message => message.info.role === "assistant" && !message.info.summary && message.info.parentID === submission.messageId).sort((a, b) => b.info.time.created - a.info.time.created || b.info.id.localeCompare(a.info.id));
  const answer = answers[0];
  if (answer?.info.role === "assistant") {
    if (answer.info.error) return { ...identity, state: "failed", error: "The Assistant could not finish this reply." };
    if (!answer.info.time.completed || !answer.info.finish || answer.info.finish === "tool-calls") return { ...identity, state: "pending" };
    if (answer.info.finish !== "stop") return { ...identity, state: "failed", error: "The reply ended before it was complete." };
    const text = answer.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n").trim();
    return text ? { ...identity, state: "ready", text } : { ...identity, state: "failed", error: "This reply has no text to output." };
  }
  return submission.state === "failed" ? { ...identity, state: "failed", error: submission.error ?? "This request failed." } : { ...identity, state: "pending" };
}
