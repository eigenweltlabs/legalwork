import { test, expect } from "bun:test";
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { channelRecoveryPlan, retryableChannelError, retryChannelTurn } from "./channel-recovery.js";
import type { ChannelReceipt } from "./channel-runtime.js";

const user: UserMessage = { id: "human", sessionID: "session", role: "user", time: { created: 1 }, agent: "legalwork", model: { providerID: "test", modelID: "test" } };
const assistant = (finish?: string): AssistantMessage => ({ id: "reply", parentID: "human", sessionID: "session", role: "assistant", time: { created: 2, completed: 3 },
  modelID: "test", providerID: "test", mode: "legalwork", agent: "legalwork", path: { cwd: "/owned", root: "/owned" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish });
const history = (info = assistant("stop"), parts: Part[] = []): { info: Message; parts: Part[] }[] => [{ info: user, parts: [] }, { info, parts }];
const completedTool: Part = { id: "tool", sessionID: "session", messageID: "reply", type: "tool", tool: "send_email", callID: "call",
  state: { status: "completed", input: {}, output: "Already sent", title: "Sent", metadata: {}, time: { start: 1, end: 2 } } };
const receipt: ChannelReceipt = { id: "job", userId: "user", orgId: "org", channel: "ios", conversationId: "conversation", text: "Original request", attachments: [],
  fingerprint: "fingerprint", workspaceId: "owned", sessionId: "session", messageId: "human", state: "running", textResult: null, files: [], events: [],
  code: "empty_reply", createdAt: 1, updatedAt: 1, retries: 1, retryAt: null };

test("empty stop markers recover, while real output, filtering, newer input and uncertain tools do not", () => {
  expect(channelRecoveryPlan(history(), "human")).toEqual({ emptyMessageId: "reply" });
  expect(channelRecoveryPlan(history(assistant("content-filter")), "human")).toBeNull();
  expect(channelRecoveryPlan([...history(), { info: { ...user, id: "new-human" }, parts: [] }], "human")).toBeNull();
  const prose: Part = { id: "prose", messageID: "reply", sessionID: "session", type: "text", text: "Actual reply" };
  expect(channelRecoveryPlan(history(assistant("stop"), [prose]), "human")).toBeNull();
  const uncertain: Part = { ...completedTool, state: { status: "running", input: {}, time: { start: 1 } } };
  expect(channelRecoveryPlan(history(assistant(), [uncertain]), "human")).toBeNull();
});
test("completed tool outputs and acknowledgement bubbles are retained when resuming an interrupted turn", () => {
  expect(channelRecoveryPlan(history(assistant("tool-calls"), [completedTool]), "human")).toEqual({ emptyMessageId: null });
  const messages = history(assistant("tool-calls"), [completedTool]);
  messages.push({ info: { ...assistant("stop"), id: "empty" }, parts: [] });
  expect(channelRecoveryPlan(messages, "human")).toEqual({ emptyMessageId: "empty" });
});
test("transient provider failures retry, but cancellations, permissions and permanent errors do not", () => {
  expect(retryableChannelError({ name: "APIError", data: { message: "Unavailable", statusCode: 503, isRetryable: true } })).toBe(true);
  expect(retryableChannelError({ name: "APIError", data: { message: "Unauthorized", statusCode: 401, isRetryable: false } })).toBe(false);
  expect(retryableChannelError({ name: "UnknownError", data: { message: "fetch failed" } })).toBe(true);
  const error = { name: "MessageAbortedError", data: { message: "Stopped" } } satisfies NonNullable<AssistantMessage["error"]>;
  expect(retryableChannelError(error)).toBe(false);
  expect(channelRecoveryPlan(history({ ...assistant(), error }), "human")).toBeNull();
});
test("engine recovery wakes the same message with no repeated text or attachments, removing only the empty attempt", async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const client = createOpencodeClient({ baseUrl: "http://engine.test", fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url); requests.push({ method: request.method, path: url.pathname, body: request.method === "POST" ? await request.json() : null });
    if (url.pathname === "/session/status") return Response.json({});
    if (request.method === "DELETE") return Response.json(true);
    if (url.pathname.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    return Response.json(history());
  }, { preconnect: () => {} }) });
  expect(await retryChannelTurn(client, receipt)).toBe(true);
  expect(requests.filter(r => r.method === "DELETE").map(r => r.path)).toEqual(["/session/session/message/reply"]);
  expect(requests.at(-1)?.body).toEqual({ messageID: "human", agent: "legalwork", model: user.model, parts: [] });
});
test("a still-running engine is inspected without dispatching another prompt", async () => {
  let requests = 0;
  const client = createOpencodeClient({ baseUrl: "http://engine.test", fetch: Object.assign(async () => { requests++; return Response.json({ session: { type: "busy" } }); }, { preconnect: () => {} }) });
  expect(await retryChannelTurn(client, receipt)).toBe(true); expect(requests).toBe(1);
});
