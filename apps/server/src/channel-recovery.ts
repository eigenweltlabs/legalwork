import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ChannelReceipt } from "./channel-runtime.js";

type TurnMessage = { info: Message; parts: Part[] };

export function retryableChannelError(error: AssistantMessage["error"]): boolean {
  if (!error) return false;
  if (error.name === "APIError") return error.data.isRetryable;
  return error.name === "UnknownError" && /timeout|timed out|network|connection|socket|fetch failed|temporar/i.test(error.data.message);
}

/** Resume only the original, still-current turn, retaining its tool results. */
export function channelRecoveryPlan(messages: TurnMessage[], messageId: string) {
  const user = messages.filter(message => message.info.role === "user").at(-1);
  if (user?.info.id !== messageId) return null;
  const turn = messages.filter(message => message.info.role === "assistant" && message.info.parentID === messageId);
  // A tool with an unknown outcome must not be automatically performed again.
  if (turn.some(message => message.parts.some(part => part.type === "tool" && part.state.status !== "completed"))) return null;
  const final = turn.at(-1);
  if (!final || final.info.role !== "assistant") return { emptyMessageId: null };
  if (final.info.error && !retryableChannelError(final.info.error)) return null;
  if (final.info.finish === "content-filter") return null;
  if (final.info.finish && !["tool-calls", "unknown"].includes(final.info.finish)) {
    // The engine treats a stop marker as done, even when no answer was emitted.
    // Remove only that empty attempt; never remove public prose or tool results.
    if (final.parts.some(part => part.type === "tool" || part.type === "file" ||
      (part.type === "text" && part.text.trim() && !part.synthetic && !part.ignored))) return null;
    return { emptyMessageId: final.info.id };
  }
  return { emptyMessageId: null };
}

export async function retryChannelTurn(client: OpencodeClient, receipt: ChannelReceipt) {
  const options = { throwOnError: true, signal: AbortSignal.timeout(10_000) };
  const status = (await client.session.status({}, options)).data;
  if (!status) throw new Error("Session status unavailable");
  if (status[receipt.sessionId] && status[receipt.sessionId].type !== "idle") return true;
  const messages = (await client.session.messages({ sessionID: receipt.sessionId, limit: 100 }, options)).data;
  if (!messages) throw new Error("Turn history unavailable");
  const plan = channelRecoveryPlan(messages, receipt.messageId);
  if (!plan) return false;
  const user = messages.find(message => message.info.id === receipt.messageId);
  if (!user || user.info.role !== "user") return false;
  if (plan.emptyMessageId) {
    await client.session.deleteMessage({ sessionID: receipt.sessionId, messageID: plan.emptyMessageId }, options);
  }
  // Empty parts leave the original text and attachment parts in place. Reusing
  // the engine message ID wakes its loop without another visible user message.
  const response = await client.session.promptAsync({ sessionID: receipt.sessionId, messageID: receipt.messageId,
    agent: user.info.agent, model: user.info.model, tools: user.info.tools,
    system: user.info.system, format: user.info.format, parts: [],
  }, { signal: AbortSignal.timeout(30_000) });
  if (!response.response.ok) throw new Error("Assistant recovery could not be confirmed");
  return true;
}
