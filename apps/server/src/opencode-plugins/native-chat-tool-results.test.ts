import { expect, test } from "bun:test";
import { codeModeWidgetResults } from "@legalwork/types/chat-tool-results";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { registerChatToolResults } from "./native-chat-tool-results.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const reaction = { ok: true, reaction: { messageId: "human", emoji: "❤️" } };
const file = { ok: true, file: { path: "briefing.md", title: "Morning briefing", size: 24 } };
const named = { ok: true, showAvatarPicker: true, onboarding: { needed: true, greetingUnread: false, step: "avatar", sessionId: "chat", name: "Maya", icon: "flower" } };
const delegated = { ok: false, delegation: { workspaceId: "matter", sessionId: "child", projectName: "Matter", title: "Review", scope: "Provider review", status: "delivery-unconfirmed" } };
const limit = { reason: "wallet_empty", requiredMicros: 1, availableMicros: 0 };

test("Code Mode retains only validated search allowance details across caught and rethrown errors", async () => {
  const runtime = nativePluginTestRuntime();
  const close = await registerChatToolResults(runtime.ctx);
  const a = nativeTestInvocation("chat_a"), b = nativeTestInvocation("chat_b");
  try {
    for (const call of [a, b]) await runtime.hook("tool", "execute.before", { ...call, tool: "execute", input: {} });
    await runtime.hook("tool", "execute.after", { ...a, tool: "legalwork_websearch", input: {}, status: "error",
      error: new ToolError({ message: "Search blocked", metadata: { legalworkWebSearchUsageLimit: { ...limit, privateQuery: "discard me" } } }) });
    const metadata: Record<string, unknown> = { toolCalls: [] };
    const caught = { ...a, tool: "execute", input: {}, status: "completed", result: { content: "A rewritten error", metadata } };
    await runtime.hook("tool", "execute.after", caught);
    expect(caught.result.metadata).toEqual({ toolCalls: [], legalworkToolResults: [], legalworkWebSearchUsageLimit: limit });
    const otherSession = { ...b, tool: "execute", input: {}, status: "completed", result: { metadata: { legalworkWebSearchUsageLimit: limit } } };
    await runtime.hook("tool", "execute.after", otherSession);
    expect(otherSession.result.metadata.legalworkWebSearchUsageLimit).toBeNull();
    // Reusing an invocation must not carry an earlier failure into a new execution.
    await runtime.hook("tool", "execute.before", { ...a, tool: "execute", input: {} });
    const next = { ...caught, result: { metadata: {} } };
    await runtime.hook("tool", "execute.after", next);
    expect(next.result.metadata).toMatchObject({ legalworkWebSearchUsageLimit: null });
    await runtime.hook("tool", "execute.before", { ...a, tool: "execute", input: {} });
    await runtime.hook("tool", "execute.after", { ...a, tool: "legalwork_websearch", input: {}, status: "error",
      error: new ToolError({ message: "Search blocked", metadata: { legalworkWebSearchUsageLimit: limit } }) });
    const rethrown = { ...a, tool: "execute", input: {}, status: "error", error: new ToolError({ message: "Reworded", error: new Error("cause"), metadata: { original: true } }) };
    await runtime.hook("tool", "execute.after", rethrown);
    expect(rethrown.error.message).toBe("Reworded");
    expect(rethrown.error.error).toBeInstanceOf(Error);
    expect(rethrown.error.metadata).toEqual({ original: true, legalworkWebSearchUsageLimit: limit });
  } finally { close(); }
});

test("unrelated, malformed and successful nested results cannot fabricate a search allowance failure", async () => {
  const runtime = nativePluginTestRuntime();
  const close = await registerChatToolResults(runtime.ctx);
  const call = nativeTestInvocation();
  try {
    await runtime.hook("tool", "execute.before", { ...call, tool: "execute", input: {} });
    for (const [tool, details] of [["legalwork_webfetch", limit], ["legalwork_websearch", { ...limit, availableMicros: 2 }]]) {
      await runtime.hook("tool", "execute.after", { ...call, tool, input: {}, status: "error",
        error: new ToolError({ message: "Denied", metadata: { legalworkWebSearchUsageLimit: details } }) });
    }
    await runtime.hook("tool", "execute.after", { ...call, tool: "legalwork_websearch", input: {}, status: "completed",
      result: { output: limit, metadata: { legalworkWebSearchUsageLimit: limit } } });
    const outer = { ...call, tool: "execute", input: {}, status: "error", error: new ToolError({ message: "Fabricated quota", metadata: { legalworkWebSearchUsageLimit: limit } }) };
    await runtime.hook("tool", "execute.after", outer);
    expect(outer.error.metadata?.legalworkWebSearchUsageLimit).toBeNull();
  } finally { close(); }
});

test("native Code Mode hooks retain independently verified UI results, including discarded and mixed outputs", async () => {
  const runtime = nativePluginTestRuntime();
  const close = await registerChatToolResults(runtime.ctx);
  const call = nativeTestInvocation();
  const outputs = [
    { tool: "legalwork_assistant_react", input: { emoji: "❤️" }, output: reaction },
    { tool: "legalwork_assistant_set_name", input: { name: "Maya" }, output: named },
    { tool: "legalwork_assistant_share_file", input: { path: "briefing.md", title: "Morning briefing" }, output: file },
    { tool: "legalwork_assistant_delegate", input: {}, output: delegated },
    { tool: "legalwork_task_create", input: {}, output: { ok: true, task: { id: "task", title: "Sign agreement", origin: "desktop" } } },
  ];
  try {
    await runtime.hook("tool", "execute.before", { ...call, tool: "execute", input: {} });
    for (const output of outputs) await runtime.hook("tool", "execute.before", { ...call, ...output });
    // Native calls can settle in a different order without losing a card.
    for (const output of [...outputs].reverse()) await runtime.hook("tool", "execute.after", { ...call, ...output, status: "completed", result: { output: output.output } });
    const metadata = { toolCalls: outputs.map(({ tool, input }) => ({ tool, input, status: "completed" })) };
    const outer = { ...call, tool: "execute", input: {}, status: "completed", result: { content: "done", metadata } };
    await runtime.hook("tool", "execute.after", outer);
    expect(codeModeWidgetResults(call.id, outer.result.metadata, "done").map(({ tool, input, output }) => ({ tool, input, output }))).toEqual([...outputs].reverse());
    // Returning a captured payload again must not create a duplicate card.
    expect(codeModeWidgetResults(call.id, outer.result.metadata, JSON.stringify(outputs.map(item => item.output)))).toHaveLength(outputs.length);
    const next = { ...outer, result: { content: "nothing", metadata: { toolCalls: metadata.toolCalls } } };
    await runtime.hook("tool", "execute.after", next);
    expect(codeModeWidgetResults(call.id, next.result.metadata, "nothing")).toEqual([]);
  } finally { close(); }
});

test("a failed or fabricated nested output cannot create a reaction or successful file card", async () => {
  const runtime = nativePluginTestRuntime();
  const close = await registerChatToolResults(runtime.ctx);
  const call = nativeTestInvocation();
  try {
    await runtime.hook("tool", "execute.before", { ...call, tool: "execute", input: {} });
    await runtime.hook("tool", "execute.after", { ...call, tool: "legalwork_assistant_share_file", input: {}, status: "completed", result: { output: { ...file, ok: false } } });
    await runtime.hook("tool", "execute.after", { ...call, tool: "legalwork_assistant_react", input: {}, status: "error", error: new Error("denied") });
    const outer = { ...call, tool: "execute", input: {}, status: "completed", result: { metadata: { toolCalls: [{ tool: "legalwork_assistant_share_file", status: "completed" }, { tool: "legalwork_assistant_react", status: "error" }] } } };
    await runtime.hook("tool", "execute.after", outer);
    expect(codeModeWidgetResults(call.id, outer.result.metadata, "done")).toEqual([]);
    expect(codeModeWidgetResults(call.id, outer.result.metadata, JSON.stringify(file))).toEqual([]);
    expect(codeModeWidgetResults(call.id, { toolCalls: [{ tool: "legalwork_assistant_react", status: "completed" }] }, JSON.stringify(reaction))).toEqual([]);
  } finally { close(); }
});

test("reaction ordering uses actual nested calls and remains isolated between simultaneous executions", async () => {
  const runtime = nativePluginTestRuntime();
  const close = await registerChatToolResults(runtime.ctx);
  const a = nativeTestInvocation("chat_a"), b = nativeTestInvocation("chat_b");
  try {
    for (const call of [a, b]) await runtime.hook("tool", "execute.before", { ...call, tool: "execute", input: {} });
    await runtime.hook("tool", "execute.before", { ...a, tool: "legalwork_assistant_projects", input: {} });
    await expect(runtime.hook("tool", "execute.before", { ...a, tool: "legalwork_assistant_react", input: {} })).rejects.toThrow("first action");
    await runtime.hook("tool", "execute.before", { ...b, tool: "legalwork_assistant_react", input: {} });
    await expect(runtime.hook("tool", "execute.before", { ...b, tool: "legalwork_assistant_react", input: {} })).rejects.toThrow("first action");
    await runtime.hook("tool", "execute.after", { ...a, tool: "execute", input: {}, status: "error", error: new Error("aborted") });
  } finally { close(); }
});
