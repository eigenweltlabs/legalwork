import { createHash } from "node:crypto";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AssistantAttentionItemSchema, type AssistantAttentionItem, type AssistantAttentionReply } from "@legalwork/types/main-assistant";
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

/** Read the original engine requests. An unsupported protocol is not an empty inbox. */
export async function readAssistantAttention(client: OpencodeClient, source: AttentionSource): Promise<AssistantAttentionItem[]> {
  const sessionID = source.sessionId;
  const results = await Promise.allSettled([
    client.permission.list({}, options()).then(result => result.data),
    client.v2.session.permission.list({ sessionID }, options()).then(result => result.data?.data),
    client.question.list({}, options()).then(result => result.data),
    client.v2.session.question.list({ sessionID }, options()).then(result => result.data?.data),
    client.session.messages({ sessionID, limit: 20 }, options()).then(result => result.data),
  ]);
  if (results.slice(0, 2).every(result => result.status === "rejected") || results.slice(2, 4).every(result => result.status === "rejected"))
    throw new Error("Pending requests could not be read.");
  const items = new Map<string, AssistantAttentionItem>();
  const add = (kind: "approval" | "question" | "widget", requestId: string, payload: object) => {
    const id = fingerprint([source.workspaceId, sessionID, kind, requestId]);
    const item = AssistantAttentionItemSchema.parse({ ...source, id, revision: fingerprint(payload), visible: false, presentedAt: 0, kind, ...payload });
    items.set(id, item);
  };
  const [legacyPermissions, permissions, legacyQuestions, questions, messages] = results;
  if (legacyPermissions.status === "fulfilled") for (const item of legacyPermissions.value ?? []) if (item.sessionID === sessionID)
    add("approval", item.id, { requestId: item.id, protocol: "legacy", permission: item.permission, patterns: item.patterns, metadata: item.metadata });
  if (permissions.status === "fulfilled") for (const item of permissions.value ?? []) if (item.sessionID === sessionID)
    add("approval", item.id, { requestId: item.id, protocol: "v2", permission: item.action, patterns: item.resources, metadata: item.metadata ?? {} });
  if (legacyQuestions.status === "fulfilled") for (const item of legacyQuestions.value ?? []) if (item.sessionID === sessionID)
    add("question", item.id, { requestId: item.id, protocol: "legacy", questions: item.questions });
  if (questions.status === "fulfilled") for (const item of questions.value ?? []) if (item.sessionID === sessionID)
    add("question", item.id, { requestId: item.id, protocol: "v2", questions: item.questions });
  if (messages.status === "rejected") throw new Error("Project widgets could not be read.");
  for (const message of messages.value ?? []) {
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
export async function replyToAssistantAttention(client: OpencodeClient, item: AssistantAttentionItem, input: AssistantAttentionReply) {
  if (item.id !== input.id || item.revision !== input.revision || item.workspaceId !== input.workspaceId || item.sessionId !== input.sessionId || item.kind !== input.kind)
    throw new ApiError(409, "attention_changed", "This request changed. Refresh it before responding.");
  if (item.kind === "approval" && input.kind === "approval") {
    const result = item.protocol === "v2"
      ? await client.v2.session.permission.reply({ sessionID: item.sessionId, requestID: item.requestId, reply: input.reply }, options())
      : await client.permission.reply({ requestID: item.requestId, reply: input.reply }, options());
    if (!result.response.ok || result.data === false) throw new Error("Approval delivery was not confirmed. Refresh the request before retrying.");
  } else if (item.kind === "question" && input.kind === "question") {
    if (input.answers.length !== item.questions.length || input.answers.some((answers, index) => {
      const question = item.questions[index];
      return !answers.length || (!question.multiple && answers.length !== 1) || answers.some(answer => !answer.trim() || (question.custom === false && !question.options.some(option => option.label === answer)));
    })) throw new ApiError(400, "attention_answers", "Answer each question using its available choices or allowed custom answer.");
    const result = item.protocol === "v2"
      ? await client.v2.session.question.reply({ sessionID: item.sessionId, requestID: item.requestId, questionV2Reply: { answers: input.answers } }, options())
      : await client.question.reply({ requestID: item.requestId, answers: input.answers }, options());
    if (!result.response.ok || result.data === false) throw new Error("Answer delivery was not confirmed. Refresh the request before retrying.");
  }
}
