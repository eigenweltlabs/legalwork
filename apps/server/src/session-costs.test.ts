import { describe, expect, test } from "bun:test";
import type { SessionInfo, SessionMessageInfo, SessionLogOutput } from "@opencode/client";
import { OpenCode } from "@opencode/client";
import { buildSessionCostSummary, readSessionCosts, sessionCostLedger, type UsageCharge, type UsageLedger } from "./session-costs.js";
import { buildEigenweltModelsMap } from "./eigenwelt-auth.js";

const tokens = (input = 0, cached = 0) => ({ input, output: 0, reasoning: 0, cache: { read: cached, write: 0 } });
const charge = (id: string, costUsd: number | null, promptId: string | null = "msg_user"): UsageCharge => ({
  id, costUsd, promptId, assistantMessageId: id, model: { providerID: "test", id: "model" }, tokens: tokens(10, 90),
});
function ledger(id: string, charges: UsageCharge[], parentId?: string): UsageLedger {
  return { id, parentId, charges, costUsd: charges.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0),
    tokens: tokens(charges.length * 10, charges.length * 90), links: [] };
}
function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { id: "ses_root", projectID: "project", location: { directory: "/tmp/cost-test" }, time: { created: 1, updated: 2 }, cost: 0, tokens: tokens(), ...overrides };
}
const messages: SessionMessageInfo[] = [
  { type: "user", id: "msg_one", text: "Review the sample document", time: { created: 1 } },
  { type: "assistant", id: "msg_a", agent: "build", model: { providerID: "test", id: "model" }, content: [], time: { created: 2 }, cost: 0.1, tokens: tokens(10) },
  { type: "user", id: "msg_two", text: "Also check the dates", time: { created: 3 } },
];
const eventBase = (index: number): { id: string; created: number; durable: { aggregateID: string; seq: number; version: 1 } } =>
  ({ id: `evt_${index}`, created: index, durable: { aggregateID: "ses_root", seq: index, version: 1 } });
const stepEvents: SessionLogOutput[] = [
  { ...eventBase(1), type: "session.inbox.delivered", data: { sessionID: "ses_root", inboxID: "msg_one" } },
  { ...eventBase(2), type: "session.step.started", data: { sessionID: "ses_root", assistantMessageID: "msg_a", agent: "build", model: { providerID: "test", id: "model" }, started: 2 } },
  { ...eventBase(3), type: "session.inbox.delivered", data: { sessionID: "ses_root", inboxID: "msg_two" } },
  { ...eventBase(4), type: "session.step.ended", data: { sessionID: "ses_root", assistantMessageID: "msg_a", finish: "stop", cost: 0.1, tokens: tokens(10) } },
];

describe("session cost accounting", () => {
  test("native API totals and message usage reconcile when only the log watermark is retained", async () => {
    const callTokens = { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 50 } };
    const nativeSession = session({ id: "ses_native_audit", location: { directory: "/tmp/cost-native-audit" }, cost: 0.061,
      tokens: { input: 36, output: 61, reasoning: 15, cache: { read: 300, write: 150 } } });
    const assistant = (id: string, cost: number): SessionMessageInfo => ({ type: "assistant", id,
      agent: "build", model: { providerID: "test", id: "model" }, content: [], time: { created: 2 }, cost, tokens: callTokens });
    const nativeMessages: SessionMessageInfo[] = [messages[0]!, assistant("msg_first", 0.01), assistant("msg_second", 0.02),
      messages[2]!, assistant("msg_third", 0.03)];
    const client = OpenCode.make({ baseUrl: "http://cost-audit.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0]) => {
      const path = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url).pathname;
      if (path.endsWith("/log")) return new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: nativeSession.id, seq: 10 })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      if (path.endsWith("/message")) return Response.json({ data: nativeMessages, cursor: {} });
      if (path === "/api/session") return Response.json({ data: [], cursor: {} });
      if (path === "/api/model") return Response.json({ data: [] });
      if (path === `/api/session/${nativeSession.id}`) return Response.json({ data: nativeSession });
      throw new Error(`Unexpected native request: ${path}`);
    }, { preconnect: fetch.preconnect }) });
    const result = await readSessionCosts(client, { id: "cost-native-audit", name: "Sample", path: "/tmp/cost-native-audit", preset: "starter", workspaceType: "local" }, nativeSession.id);
    expect(result.total.costUsd).toBe(nativeSession.cost);
    expect(result.total.tokens).toEqual(nativeSession.tokens);
    expect(result.total.calls).toBe(3);
    expect(result.prompts.map(prompt => prompt.calls)).toEqual([2, 1]);
    for (const prompt of result.prompts) expect(prompt.costUsd).toBeCloseTo(0.03);
    expect(result.background.costUsd).toBeCloseTo(0.001);
    expect(result.background.tokens.input).toBe(6);
  });

  test("rejects another project's session before reading its messages, log or models", async () => {
    let requests = 0;
    const client = OpenCode.make({ baseUrl: "http://cost-engine.invalid", fetch: Object.assign(async () => {
      requests += 1;
      return Response.json({ data: session({ location: { directory: "/" } }) });
    }, { preconnect: fetch.preconnect }) });
    await expect(readSessionCosts(client, { id: "cost-project", name: "Cost test", path: "/tmp", preset: "starter", workspaceType: "local" }, "ses_root"))
      .rejects.toMatchObject({ status: 404, code: "session_not_found" });
    expect(requests).toBe(1);
  });

  test("adds every step, background and descendant exactly once", () => {
    const root = ledger("root", [charge("one", 0.1), charge("two", 0.2), { ...charge("title", 0.01, null), assistantMessageId: undefined }]);
    root.links = [{ sessionId: "child", promptId: "msg_user" }];
    const child = ledger("child", [charge("child-step", 0.3)], "root");
    child.links = [{ sessionId: "grandchild", promptId: "msg_child_user" }];
    const grandchild = ledger("grandchild", [charge("grandchild-step", 0.4)], "child");
    const result = buildSessionCostSummary("root", [root, child, grandchild, child]);
    expect(result.total.costUsd).toBeCloseTo(1.01);
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0]?.costUsd).toBeCloseTo(1);
    expect(result.prompts[0]?.assistantMessageIds).toEqual(["one", "two"]);
    expect(result.background.costUsd).toBeCloseTo(0.01);
    expect(result.delegated.costUsd).toBeCloseTo(0.7);
    expect(result.total.calls).toBe(4);
    expect(result.total.tokens.cache.read).toBe(450);
  });

  test("steering cannot reassign an in-flight model call to a later prompt", () => {
    const result = sessionCostLedger(session({ cost: 0.1, tokens: tokens(10) }), messages, stepEvents, new Set());
    expect(result.charges[0]?.promptId).toBe("msg_one");
    expect(buildSessionCostSummary("ses_root", [result]).prompts[0]?.costUsd).toBe(0.1);
  });

  test("resuming the same child in a later prompt does not move its earlier spend", () => {
    const root = ledger("root", [charge("root-one", 0.1, "msg_first"), charge("root-two", 0.1, "msg_second")]);
    root.links = [{ sessionId: "child", promptId: "msg_first", createdAt: 10 }, { sessionId: "child", promptId: "msg_second", createdAt: 30 }];
    const child = ledger("child", [{ ...charge("child-one", 0.2), createdAt: 20 }, { ...charge("child-two", 0.3), createdAt: 40 }], "root");
    const result = buildSessionCostSummary("root", [root, child]);
    expect(result.prompts.find(prompt => prompt.messageId === "msg_first")?.costUsd).toBeCloseTo(0.3);
    expect(result.prompts.find(prompt => prompt.messageId === "msg_second")?.costUsd).toBeCloseTo(0.4);
  });

  test("replayed events are idempotent but separate failed attempts still count", () => {
    const failed: SessionLogOutput = { ...eventBase(5), type: "session.step.failed", data: {
      sessionID: "ses_root", assistantMessageID: "msg_a", cost: 0.03, tokens: tokens(3),
      error: { type: "unknown", message: "Interrupted after partial usage" },
    } };
    const result = sessionCostLedger(session({ cost: 0.13, tokens: tokens(13) }), messages, [...stepEvents, ...stepEvents.slice(-1), failed], new Set());
    expect(result.charges).toHaveLength(2);
    expect(buildSessionCostSummary("ses_root", [result]).total.costUsd).toBeCloseTo(0.13);
  });

  test("missing pricing produces an unknown total with a known subtotal", () => {
    const result = buildSessionCostSummary("root", [ledger("root", [charge("priced", 0.1), charge("unpriced", null)])]);
    expect(result.total.costUsd).toBeNull();
    expect(result.total.knownCostUsd).toBe(0.1);
    expect(result.total.unpricedCalls).toBe(1);
    expect(result.prompts[0]?.costUsd).toBeNull();
  });

  test("an unpriced zero is not free, while explicit free pricing is usable", () => {
    const event: SessionLogOutput = { ...eventBase(4), type: "session.step.ended", data: { sessionID: "ses_root", assistantMessageID: "msg_a", finish: "stop", cost: 0, tokens: tokens(10) } };
    expect(sessionCostLedger(session(), messages, [...stepEvents.slice(0, 3), event], new Set()).charges[0]?.costUsd).toBeNull();
    expect(sessionCostLedger(session(), messages, [...stepEvents.slice(0, 3), event], new Set([JSON.stringify(["test", "model"])])).charges[0]?.costUsd).toBe(0);
  });

  test("native lifetime spend survives trimmed or reverted history", () => {
    const root = ledger("root", [charge("retained", 0.1)]);
    root.costUsd = 0.8; root.tokens = tokens(80, 720);
    const result = buildSessionCostSummary("root", [root]);
    expect(result.total.costUsd).toBe(0.8);
    expect(result.background.costUsd).toBeCloseTo(0.7);
    expect(result.total.tokens).toEqual(tokens(80, 720));
  });

  test("copied fork history is not newly billed", () => {
    const result = sessionCostLedger(session({ fork: { sessionID: "ses_original", boundary: { type: "through", messageID: "msg_a" } } }), messages, [], new Set());
    expect(result.charges).toEqual([]);
    expect(buildSessionCostSummary("ses_root", [result]).total.costUsd).toBe(0);
  });

  test("compaction is counted from its usage record, not counted again from the transcript", () => {
    const usage: SessionLogOutput = { ...eventBase(6), type: "session.usage.recorded", data: { sessionID: "ses_root", source: "compaction", cost: 0.02, tokens: tokens(2) } };
    const result = sessionCostLedger(session({ cost: 0.12, tokens: tokens(12) }), messages, [...stepEvents, usage], new Set());
    expect(buildSessionCostSummary("ses_root", [result]).total.costUsd).toBeCloseTo(0.12);
    expect(result.charges).toHaveLength(2);
  });

  test("gateway manifest prices reach the native model without invented defaults", () => {
    const models = buildEigenweltModelsMap([{ id: "priced", cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25,
      context_over_200k: { input: 2, output: 4, cache_read: 0.2, cache_write: 2.5 } } }, { id: "unknown" }]);
    expect(models.priced).toMatchObject({ cost: [
      { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
      { tier: { type: "context", size: 200000 }, input: 2, output: 4, cache: { read: 0.2, write: 2.5 } },
    ] });
    expect(models.unknown?.cost).toBeUndefined();
  });
});
