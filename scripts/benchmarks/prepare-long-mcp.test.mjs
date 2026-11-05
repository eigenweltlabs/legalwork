import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareLongMcp } from "./prepare-long-mcp.mjs";
import { startLongMcpServer } from "./long-mcp-server.mjs";
import { evaluateAssertions, privateWrite, readJson, sha256 } from "./evidence.mjs";

test("frozen controller fixture hides expectations and places legally decisive evidence beyond one MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-long-mcp-"));
  try {
    const prepared = await prepareLongMcp(join(root, "controller"));
    const task = prepared.suite.tasks[0];
    const bytes = await readFile(join(prepared.root, "source-response.json"));
    const expected = task.assertions.find(item => item.type === "artifact.json").equals;
    assert.deepEqual(task.assertions.filter(item => item.scope === "subtree").map(item => item.type), ["agent.no_error", "capability.mcp_tool"]);
    assert.equal(task.assertions.find(item => item.type === "artifact.json").scope, undefined);
    assert.ok(bytes.length > 1024 * 1024);
    for (const fact of [expected.source_quote, expected.archive_verification_record, expected.future_document]) {
      assert.ok(bytes.indexOf(Buffer.from(fact)) > 1024 * 1024);
      assert.equal(task.prompt.includes(fact), false);
    }
    assert.equal(task.prompt.includes("75"), false);
    assert.equal(task.prompt.includes(expected.source_sha256), false);
    assert.equal(task.copyFiles, undefined); assert.equal(task.files, undefined);
    assert.equal(expected.source_sha256, sha256(bytes));
    assert.equal(JSON.parse(bytes.toString()).records.length, expected.record_count);
    assert.equal((await stat(join(prepared.root, "transport.json"))).mode & 0o777, 0o600);
    const transport = await readJson(join(prepared.root, "transport.json"));
    assert.equal(transport.v1.mcp.benchmark_long_mcp.enabled, true);
    assert.equal(transport.v2.mcp.servers.benchmark_long_mcp.disabled, false);
    assert.equal(transport.v2.mcp.servers.benchmark_long_mcp.enabled, undefined);
    assert.deepEqual(transport.v1.mcp.benchmark_long_mcp.headers, transport.v2.mcp.servers.benchmark_long_mcp.headers);
    assert.equal((await readJson(join(prepared.root, "source-provenance.json"))).status, "prepared-not-real-agent-executed");
    await assert.rejects(() => prepareLongMcp(prepared.root), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("full Streamable HTTP JSON-RPC MCP response preserves identical structuredContent and original text, with private complete traces", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-long-mcp-wire-"));
  let server;
  try {
    const prepared = await prepareLongMcp(join(root, "controller"));
    const transport = await readJson(join(prepared.root, "transport.json"));
    server = await startLongMcpServer({ directory: prepared.root, port: 0 });
    assert.equal((await fetch(server.url, { method: "POST", body: "{}" })).status, 401);
    let id = 0;
    const rpc = async (method, params) => {
      const response = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${transport.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      assert.equal(response.status, 200); return response.json();
    };
    assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion, "2025-03-26");
    const definitions = (await rpc("tools/list", {})).result.tools;
    const expected = prepared.suite.tasks[0].assertions.find(item => item.type === "artifact.json").equals;
    assert.equal(JSON.stringify(definitions).includes(expected.source_quote), false);
    assert.equal(JSON.stringify(definitions).includes(expected.source_sha256), false);
    const result = (await rpc("tools/call", { name: definitions[0].name, arguments: { matter_id: expected.matter_id } })).result;
    assert.equal(result.isError, undefined);
    assert.ok(Buffer.byteLength(result.content[0].text) > 1024 * 1024);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(sha256(result.content[0].text), expected.source_sha256);
    assert.equal(sha256(JSON.stringify(result.structuredContent)), expected.source_sha256);
    assert.equal((await rpc("tools/call", { name: definitions[0].name, arguments: { matter_id: "other-matter" } })).result.isError, true);
    assert.equal((await rpc("unimplemented", {})).error.code, -32601);
    await server.close(); server = undefined;
    const traces = join(prepared.root, "fixture-traces");
    const receipts = await Promise.all((await readdir(traces)).filter(file => file.endsWith(".receipt.json")).map(file => readJson(join(traces, file))));
    const call = receipts.find(item => item.method === "tools/call" && !item.isError);
    assert.equal(call.sourceSha256, expected.source_sha256); assert.equal(call.deliveryCompleted, true);
    assert.ok(call.responseBytes > prepared.bytes * 2);
    assert.equal((await readFile(join(traces, `${call.id}.response.json`))).length, call.responseBytes);
    assert.equal(sha256(await readFile(join(traces, `${call.id}.response.json`))), call.responseSha256);
  } finally { if (server) await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("substantive legal verdict rejects earlier or future terms, fabricated quote, partial-source digest and wrong record count", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-long-mcp-verdict-"));
  try {
    const prepared = await prepareLongMcp(join(root, "controller"));
    const assertions = prepared.suite.tasks[0].assertions.filter(item => item.type === "artifact.json");
    const expected = assertions[0].equals;
    const agent = join(root, "guest-mirror");
    const verdict = async value => { await privateWrite(join(agent, "mcp-notice-review.json"), value); return (await evaluateAssertions(assertions, agent, [], {}))[0].passed; };
    assert.equal(await verdict(expected), true);
    for (const change of [
      { notice_days: 45, controlling_document: "AMENDMENT-2025-A" },
      { notice_days: 90, controlling_document: "AMENDMENT-2026-C" },
      { source_quote: "The notice period is probably 75 days." },
      { source_sha256: sha256((await readFile(join(prepared.root, "source-response.json"))).subarray(0, 1024 * 1024)) },
      { archive_verification_record: "invented" }, { record_count: 100 }, { superseded_notice_days: [45, 30] },
    ]) assert.equal(await verdict({ ...expected, ...change }), false);
    assert.deepEqual(await readdir(agent), ["mcp-notice-review.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
