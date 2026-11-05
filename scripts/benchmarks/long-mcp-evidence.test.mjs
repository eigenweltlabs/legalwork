import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLongMcpExecution } from "./long-mcp-evidence.mjs";
import { evaluateAssertions } from "./evidence.mjs";

const assertion = { id: "mcp", type: "capability.mcp_tool", connector: "benchmark_long_mcp", tool: "fetch_agreement_archive" };
const child = "benchmark_long_mcp.fetch_agreement_archive";
const direct = "benchmark_long_mcp_fetch_agreement_archive";
const tool = (name, state, protocol) => ({ tool: name, messageID: "msg_actual", callID: "call_actual", protocol, state });

test("MCP completion requires exact completed V1/native direct or authoritative Code Mode child execution", () => {
  for (const entry of [
    tool(direct, { status: "completed", output: "complete source" }, "legacy-v1"),
    tool(direct, { status: "completed", content: [{ type: "text", text: "complete source" }] }, "native-v2"),
    tool("execute", { status: "completed", content: [{ type: "text", text: "computed result" }], metadata: { toolCalls: [{ tool: child, status: "completed" }] } }, "native-v2"),
  ]) assert.equal(evaluateLongMcpExecution(assertion, { tools: [entry] }).passed, true);
});

test("MCP completion rejects name collisions, arbitrary execute calls, errors, running and uncorroborated metadata", () => {
  const completed = { status: "completed", content: [{ type: "text", text: "result" }], metadata: { toolCalls: [{ tool: child, status: "completed" }] } };
  for (const entry of [
    tool(`${direct}_spoof`, { status: "completed", output: "result" }, "legacy-v1"),
    tool("execute", { ...completed, status: "running" }, "native-v2"),
    tool("execute", { ...completed, status: "error" }, "native-v2"),
    tool("execute", { ...completed, metadata: { toolCalls: [{ tool: `${child}_spoof`, status: "completed" }] } }, "native-v2"),
    tool("execute", { ...completed, metadata: { toolCalls: [{ tool: child, status: "error" }] } }, "native-v2"),
    tool("execute", { ...completed, metadata: { toolCalls: [{ tool: child, status: "running" }] } }, "native-v2"),
    tool("execute", { ...completed, metadata: { error: true, toolCalls: [{ tool: child, status: "completed" }] } }, "native-v2"),
    tool("execute", { status: "completed", metadata: completed.metadata }, "native-v2"),
    tool("other", completed, "native-v2"),
    tool("execute", { ...completed, output: "result" }, "legacy-v1"),
    { ...tool("execute", completed, "native-v2"), messageID: undefined },
    { ...tool("execute", completed, "native-v2"), callID: "" },
    tool(direct, { status: "completed", output: "result", metadata: { error: true } }, "legacy-v1"),
  ]) assert.equal(evaluateLongMcpExecution(assertion, { tools: [entry] }).passed, false);
});

test("new assertion uses real message normalization without weakening ordinary capability.tool", async () => {
  const native = [{ id: "msg_native", type: "assistant", content: [{ id: "call_native", type: "tool", name: "execute", state: { status: "completed", input: { code: "fixture" }, content: [{ type: "text", text: "complete computed result" }], metadata: { toolCalls: [{ tool: child, status: "completed" }] } } }] }];
  assert.equal((await evaluateAssertions([assertion], ".", native, {}))[0].passed, true);
  assert.equal((await evaluateAssertions([{ type: "capability.tool", names: [direct] }], ".", native, {}))[0].passed, false);
  const legacy = [{ info: { id: "msg_legacy", role: "assistant" }, parts: [{ id: "part_legacy", callID: "call_legacy", type: "tool", tool: direct, state: { status: "completed", input: {}, output: "complete source" } }] }];
  assert.equal((await evaluateAssertions([assertion], ".", legacy, {}))[0].passed, true);
});
