import { expect, test } from "bun:test";
import type { ToolDefinition } from "./tool-validation-feedback.js";
import { toolProgressGuard, type ToolAttempt } from "./tool-progress-guard.js";
import recoveryPlugin from "./legalwork-tool-recovery.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";
import { assertCachePrefix, CacheRequestSchema, type CacheRequest } from "../prompt-cache.test-support.js";
import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool";

function failure(index: number, input: unknown = { query: "" }, messageID = `message-${index}`): ToolAttempt {
  return { id: `part-${index}`, sessionID: "child", messageID, tool: "fixture", input,
    error: '[{"code":"too_small","path":["query"],"message":"Invalid input"}]' };
}
const definition = { description: 'Supply a non-empty query, for example {"query":"invoice"}.', jsonSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"] } } satisfies ToolDefinition;
function setup() {
  const stopped: string[] = [];
  const guard = toolProgressGuard(async (_session, reason) => { stopped.push(reason); });
  void guard.definition({ toolID: "fixture" }, definition);
  const deliver = async (index: number, input: unknown = { query: "" }, messageID = `message-${index}`) => {
    const next = failure(index, input, messageID);
    await guard.observe(next);
    const text = guard.guidance(next.sessionID, next.id);
    if (text) guard.delivered(next.sessionID, next.id, text);
    return text;
  };
  return { ...guard, stopped, deliver };
}
test("gives guidance immediately and allows three recovery steps after the warning", async () => {
  const guard = setup();
  expect(await guard.deliver(1)).toContain('"query":"invoice"');
  await guard.deliver(2);
  expect(await guard.deliver(3)).toContain("three further assistant steps");
  expect(guard.stopped).toHaveLength(0);
  expect(await guard.deliver(4)).toContain("two further assistant steps");
  expect(await guard.deliver(5)).toContain("Final warning: one retry remains.");
  expect(guard.stopped).toHaveLength(0);
  await guard.deliver(6); await guard.deliver(7);
  expect(guard.stopped).toHaveLength(1);
  expect(guard.stopped[0]).toContain("after correction guidance");
});

/** Save the actual after-hook result, then rebuild each request from that saved
 * history. A request-only amendment cannot survive this trajectory. */
async function recoveryHistory(nested: boolean, runtime = nativePluginTestRuntime("/project")) {
  runtime.tools.set("fixture", { name: "fixture", description: definition.description, input: definition.jsonSchema, execute: async () => ({ content: "unused" }) });
  await runtime.start(recoveryPlugin);
  const saved: CacheRequest = CacheRequestSchema.parse({ model: "fixture", messages: [{ role: "user", content: [{ type: "text", text: "Synthetic task" }] }] });
  const context = async () => {
    const request = structuredClone(saved);
    await runtime.hook("session", "context", { sessionID: "child", messages: request.messages });
    return request;
  };
  await context();
  const attempt = async (index: number, failed: boolean) => {
    const call = { ...failure(index), status: failed ? "error" : "completed" };
    if (nested) await runtime.hook("tool", "execute.before", { ...call, tool: "execute" });
    const original = failure(index).error ?? "Invalid input";
    const cause = new globalThis.Error(original);
    const error = { ...call, error: new ToolError({ message: original, error: cause, metadata: { original: true } }) };
    const success = { ...call, result: { content: "Successful synthetic work" } };
    await runtime.hook("tool", "execute.after", failed ? error : success);
    const outer = { ...call, tool: "execute", status: "completed", result: {
      content: [{ type: "text", text: failed ? "Nested failure" : "Nested success" }, { type: "file", uri: "synthetic://file", mime: "text/plain" }],
      output: { output: "exact typed output", toolCalls: [], files: [] }, metadata: { original: true },
    } satisfies Result };
    if (nested) await runtime.hook("tool", "execute.after", outer);
    const result = nested ? { type: "content", value: outer.result.content }
      : failed ? { type: "error", value: { error: { type: "unknown", message: error.error.error instanceof globalThis.Error ? error.error.error.message : error.error.message }, content: [] } }
        : { type: "text", value: success.result.content };
    saved.messages.push({ role: "assistant", content: [{ type: "tool-call", id: call.id, name: nested ? "execute" : "fixture", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", id: call.id, name: nested ? "execute" : "fixture", result }] });
    return { result, error: error.error, cause, outer: outer.result };
  };
  return { runtime, saved, context, attempt };
}

for (const nested of [false, true]) {
  test(`${nested ? "Code Mode" : "direct"} guidance is saved once and replays after progress, new failures, idle and restart`, async () => {
    const history = await recoveryHistory(nested);
    try {
      const first = await history.attempt(1, true);
      expect(JSON.stringify(first.result)).toContain("[LegalWork tool recovery]");
      expect(first.error.metadata).toEqual({ original: true });
      if (!nested) expect(first.error.error).toMatchObject({ cause: first.cause });
      else expect(first.error.message).not.toContain("[LegalWork tool recovery]");
      expect(first.outer.metadata).toEqual({ original: true });
      expect(first.outer.output).toEqual({ output: "exact typed output", toolCalls: [], files: [] });
      if (nested) {
        const content = JSON.stringify(first.outer.content);
        expect(content).toContain("[LegalWork tool recovery]");
        expect(content).toContain("Nested failure");
        expect(content).toContain("synthetic://file");
      }
      const before = await history.context();
      assertCachePrefix(before, await history.context(), "repeated context");
      await history.attempt(2, false);
      const progress = await history.context();
      assertCachePrefix(before, progress, "successful recovery");
      await history.attempt(3, true);
      const anotherFailure = await history.context();
      assertCachePrefix(progress, anotherFailure, "another failed tool");
      await history.runtime.hook("session", "prompt", { sessionID: "child", messageID: "follow-up", prompt: { text: "Continue" } });
      history.saved.messages.push({ role: "user", content: [{ type: "text", text: "Continue" }] });
      const followUp = await history.context();
      assertCachePrefix(anotherFailure, followUp, "user follow-up");
      await history.runtime.event({ type: "session.idle", data: { sessionID: "child" } });
      assertCachePrefix(followUp, await history.context(), "idle");
      await history.runtime.close();
      const restarted = await recoveryHistory(nested);
      try {
        restarted.saved.messages = structuredClone(history.saved.messages);
        assertCachePrefix(followUp, await restarted.context(), "fresh plugin replay");
      } finally { await restarted.runtime.close(); }
    } finally { await history.runtime.close(); }
  });
}
test("never stops before correction guidance reaches a model request", async () => {
  const guard = setup();
  for (let index = 0; index < 12; index++) {
    await guard.observe(failure(index));
    expect(guard.guidance("child", `part-${index}`)).toContain("[LegalWork tool recovery]");
  }
  expect(guard.stopped).toHaveLength(0);
});
test("duplicate events and parallel calls cannot exhaust recovery steps", async () => {
  const guard = setup();
  await guard.deliver(1); await guard.deliver(2); await guard.deliver(3);
  await guard.observe(failure(3));
  for (let index = 4; index < 12; index++) await guard.observe(failure(index, { query: "" }, "one-parallel-step"));
  expect(guard.stopped).toHaveLength(0);
  await guard.deliver(12); expect(guard.stopped).toHaveLength(0);
  await guard.deliver(13); expect(guard.stopped).toHaveLength(1);
});
test("corrected arguments, successful progress and new user turns reset recovery", async () => {
  const guard = setup();
  await guard.deliver(1); await guard.deliver(2); await guard.deliver(3); await guard.deliver(4);
  await guard.deliver(5, { query: "corrected" });
  await guard.deliver(6); await guard.deliver(7);
  await guard.observe({ ...failure(8), error: undefined });
  await guard.deliver(9); await guard.deliver(10);
  guard.reset("child"); await guard.deliver(11);
  expect(guard.stopped).toHaveLength(0);
});
test("ignores other tools and service errors with valid arguments", async () => {
  const guard = setup();
  for (let index = 0; index < 8; index++) {
    await guard.observe({ ...failure(index, { query: "valid" }), error: "HTTP 503: temporarily unavailable" });
    await guard.observe({ ...failure(index), tool: "unknown_tool" });
  }
  expect(guard.stopped).toHaveLength(0);
});

test("freezes a rendered hint and only admits the matching attempt's exact warning", async () => {
  const guard = setup();
  for (let index = 1; index <= 3; index++) await guard.observe(failure(index));
  const warning = guard.guidance("child", "part-3");
  expect(warning).toContain("three further assistant steps");
  await guard.definition({ toolID: "fixture" }, { ...definition, description: "A changed tool description" });
  expect(guard.guidance("child", "part-3")).toBe(warning);
  guard.delivered("child", "part-2", warning ?? "");
  guard.delivered("child", "part-3", "Warning was truncated away");
  for (let index = 4; index <= 8; index++) await guard.observe(failure(index));
  expect(guard.stopped).toHaveLength(0);
  const current = guard.guidance("child", "part-8");
  guard.delivered("child", "part-8", current ?? "");
  for (let index = 9; index <= 11; index++) await guard.observe(failure(index));
  expect(guard.stopped).toHaveLength(1);
});

test("Code Mode guidance belongs to its outer call and duplicate notifications do not duplicate it", async () => {
  const { runtime } = await recoveryHistory(true);
  try {
    for (const id of ["outer-a", "outer-b"]) await runtime.hook("tool", "execute.before", { tool: "execute", sessionID: "child", messageID: "parallel", id });
    await runtime.hook("tool", "execute.after", { ...failure(1), id: "outer-a", messageID: "parallel", status: "error", error: new ToolError({ message: failure(1).error ?? "Invalid input" }) });
    const unrelated = { tool: "execute", sessionID: "child", messageID: "parallel", id: "outer-b", status: "completed", result: { content: "Unrelated result" } };
    await runtime.hook("tool", "execute.after", unrelated);
    expect(unrelated.result.content).toBe("Unrelated result");
    const owning = { ...unrelated, id: "outer-a", result: { content: "Caught the error", output: { exact: true }, metadata: { original: true } } satisfies Result };
    await runtime.hook("tool", "execute.after", owning);
    const once = JSON.stringify(owning.result);
    expect(once).toContain("[LegalWork tool recovery]");
    await runtime.hook("tool", "execute.after", owning);
    expect(JSON.stringify(owning.result)).toBe(once);
    expect(owning.result.output).toEqual({ exact: true });
    expect(owning.result.metadata).toEqual({ original: true });
  } finally { await runtime.close(); }
});
for (const nested of [false, true]) test(`native ${nested ? "Code Mode" : "direct"} stops persist the reason after the failed result`, async () => {
  const history = await recoveryHistory(nested), { runtime } = history;
  try {
    let previous = await history.context();
    for (let index = 1; index <= 6; index++) {
      const attempt = failure(index);
      const persisted = await history.attempt(index, true);
      expect(runtime.interrupts).toHaveLength(0);
      if (index === 5) expect(JSON.stringify(persisted.result)).toContain("Final warning: one retry remains.");
      const current = await history.context();
      assertCachePrefix(previous, current, `recovery step ${index}`);
      previous = current;
      await runtime.event({ type: nested ? "session.tool.success" : "session.tool.failed", data: { sessionID: "child", id: attempt.id } });
    }
    expect(runtime.interrupts).toEqual(["child"]);
    expect(runtime.sessions.get("child")?.metadata).toEqual({ legalworkToolStops: { "message-6": { reason: "repeated-invalid-tool-calls" } } });
    expect(runtime.synthetics).toEqual([]);
    await runtime.hook("session", "prompt", { sessionID: "child", messageID: "follow-up", prompt: { text: "Try another approach" } });
    expect(JSON.stringify((await history.attempt(7, true)).result)).toContain("Correct these arguments before retrying.");
    assertCachePrefix(previous, await history.context(), "new user recovery");
  } finally { await runtime.close(); }
});
