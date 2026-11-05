import { expect, test } from "bun:test";
import { codeModeWidgetResults } from "@legalwork/types/chat-tool-results";
import { registerChatToolResults } from "./native-chat-tool-results.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

const reaction = { ok: true, reaction: { messageId: "human", emoji: "❤️" } };
const file = { ok: true, file: { path: "briefing.md", title: "Morning briefing", size: 24 } };
const named = { ok: true, showAvatarPicker: true, onboarding: { needed: true, greetingUnread: false, step: "avatar", sessionId: "chat", name: "Maya", icon: "flower" } };
const delegated = { ok: false, delegation: { workspaceId: "matter", sessionId: "child", projectName: "Matter", title: "Review", scope: "Provider review", status: "delivery-unconfirmed" } };

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
