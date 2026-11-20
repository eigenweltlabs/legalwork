import { createHash } from "node:crypto";
import type { AssistantEngineClient } from "./assistant-engine.js";
import { AssistantAttentionItemSchema } from "./assistant-schema.js";
import type { AssistantAttentionItem, AssistantAttentionReply } from "@legalwork/types/main-assistant";
import { CalculationCardSchema } from "./calculations/schema.js";
import { ReviewToolCardSchema } from "./reviews/schema.js";
import { ScheduledTaskSchema } from "./scheduled-tasks/schema.js";
import { ApiError } from "./errors.js";

type AttentionSource = { workspaceId: string; sessionId: string; projectName: string; sessionTitle: string };
const options = () => ({ signal: AbortSignal.timeout(10000), throwOnError: true });
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only outputs with an actual rich renderer qualify. Activity and file reads never do. */
export function assistantWidget(tool: string, output: string) {
  try {
    const data: unknown = JSON.parse(output.split('\n\n<system-reminder topic="')[0]);
    const payload = data && typeof data === "object" && "referenceData" in data ? data.referenceData : data;
    if (tool === "legalwork_calculation_present") {
      const card = CalculationCardSchema.safeParse(payload);
      if (card.success) return { key: `calculation:${card.data.presentation.id}`, output: JSON.stringify(card.data) };
    }
    if (["legalwork_review_create", "legalwork_review_launch", "legalwork_review_edit", "legalwork_review_start", "legalwork_review_cancel"].includes(tool)) {
      const card = ReviewToolCardSchema.safeParse(payload);
      if (card.success) return { key: `review:${card.data.review.id}`, output: JSON.stringify(card.data) };
    }
    if (["legalwork_schedule_create", "legalwork_schedule_update"].includes(tool)) {
      const card = ScheduledTaskSchema.safeParse(payload && typeof payload === "object" && "task" in payload ? payload.task : null);
      if (card.success) return { key: `schedule:${card.data.id}`, output: JSON.stringify({ task: card.data }) };
    }
  } catch { /* Non-widget output remains available in the original chat. */ }
  return null;
}

export async function readPendingAssistantRequests(client: AssistantEngineClient, sessionID: string) {
  const [permissions, questions] = await Promise.all([
    client.v2.session.permission.list({ sessionID }, options()),
    client.v2.session.question.list({ sessionID }, options()),
  ]).catch(cause => { throw new Error("Pending requests could not be read.", { cause }); });
  if (!permissions.data || !questions.data) throw new Error("Pending requests could not be read.");
  return {
    permissions: permissions.data.data.filter(item => item.sessionID === sessionID),
    questions: questions.data.data.filter(item => item.sessionID === sessionID),
  };
}

/** Read the original engine requests. An unsupported protocol is not an empty inbox. */
export async function readAssistantAttention(client: AssistantEngineClient, source: AttentionSource): Promise<AssistantAttentionItem[]> {
  const sessionID = source.sessionId;
  const [pending, messages] = await Promise.all([
    readPendingAssistantRequests(client, sessionID),
    client.session.messages({ sessionID, limit: 20 }, options()).catch(cause => { throw new Error("Project widgets could not be read.", { cause }); }),
  ]);
  const items = new Map<string, AssistantAttentionItem>();
  const add = (kind: "approval" | "question" | "widget", requestId: string, payload: object) => {
    const id = fingerprint([source.workspaceId, sessionID, kind, requestId]);
    const item = AssistantAttentionItemSchema.parse({ ...source, id, revision: fingerprint(payload), visible: false, presentedAt: 0, kind, ...payload });
    items.set(id, item);
  };
  for (const item of pending.permissions)
    add("approval", item.id, { requestId: item.id, protocol: "v2", permission: item.action, patterns: item.resources, metadata: item.metadata ?? {} });
  for (const item of pending.questions)
    add("question", item.id, { requestId: item.id, protocol: "v2", questions: item.questions });
  for (const message of messages.data ?? []) {
    if (message.info.sessionID !== sessionID || message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue;
      if (part.state.output.length > 150000) continue;
      const widget = assistantWidget(part.tool, part.state.output);
      if (!widget) continue;
      // Successive updates to the same review/schedule/calculation replace its candidate.
      add("widget", widget.key, { messageId: message.info.id, toolCallId: part.callID, toolName: part.tool, input: part.state.input, output: widget.output });
    }
  }
  return [...items.values()];
}

/** Reply only to a fresh, exact request. Never widen an approval to a persistent rule. */
export async function replyToAssistantAttention(client: AssistantEngineClient, item: AssistantAttentionItem, input: AssistantAttentionReply) {
  if (item.id !== input.id || item.revision !== input.revision || item.workspaceId !== input.workspaceId || item.sessionId !== input.sessionId || item.kind !== input.kind)
    throw new ApiError(409, "attention_changed", "This request changed. Refresh it before responding.");
  if (item.kind === "approval" && input.kind === "approval") {
    const result = await client.v2.session.permission.reply({ sessionID: item.sessionId, requestID: item.requestId, reply: input.reply }, options());
    if (!result.response.ok || result.data === false) throw new Error("Approval delivery was not confirmed. Refresh the request before retrying.");
  } else if (item.kind === "question" && input.kind === "question") {
    if (input.answers.length !== item.questions.length || input.answers.some((answers, index) => {
      const question = item.questions[index];
      return !answers.length || (!question.multiple && answers.length !== 1) || answers.some(answer => !answer.trim() || (question.custom === false && !question.options.some(option => option.label === answer)));
    })) throw new ApiError(400, "attention_answers", "Answer each question using its available choices or allowed custom answer.");
    const result = await client.v2.session.question.reply({ sessionID: item.sessionId, requestID: item.requestId, questionV2Reply: { answers: input.answers } }, options());
    if (!result.response.ok || result.data === false) throw new Error("Answer delivery was not confirmed. Refresh the request before retrying.");
  }
}
