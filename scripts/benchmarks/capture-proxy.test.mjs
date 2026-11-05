// Tests of the trace transport itself. These are not real-model/LegalWork regression results.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestDiagnostics, startCaptureProxy } from "./capture-proxy.mjs";

test("pinned V1 and native session headers are retained without credentials, guessed roles or conflicting attribution", () => {
  const v1=requestDiagnostics({"x-session-id":"root","x-session-affinity":"root","x-parent-session-id":"parent",authorization:"never-retain",cookie:"never-retain"});
  assert.equal(v1.context.sessionID,"root");
  assert.equal(v1.context.parentSessionID,"parent");
  assert.equal(v1.context.attributionConflict,false);
  assert.equal(v1.context.verifiedKind,undefined);
  assert.doesNotMatch(JSON.stringify(v1),/never-retain/);
  const conflict=requestDiagnostics({"x-opencode-session-id":"first","x-session-id":"other"});
  assert.equal(conflict.context.sessionID,null);
  assert.equal(conflict.context.attributionConflict,true);
  assert.equal(conflict.headers["x-opencode-session-id"],"first");
  assert.equal(conflict.headers["x-session-id"],"other");
});

test("exact request and response bytes survive capture with full tool output and unchanged output allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-capture-"));
  let received;
  const wire = 'data: {"usage":{"prompt_tokens":1000,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { body: Buffer.concat(chunks).toString(), headers: request.headers, path: request.url };
    response.writeHead(200, { "content-type": "text/event-stream", "x-litellm-response-cost": "0.1", "set-cookie": "do-not-capture-fixture" });
    response.end(wire);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = await startCaptureProxy({ root, baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "private-upstream-fixture", localToken: "private-local-fixture", models: ["fixture"], fixtureMode: true, budgetEvidence: { enforcement: "test-fixture-only" } });
  try {
    const raw = JSON.stringify({ model: "fixture", messages: [{ role: "tool", content: "x".repeat(120000) + "TAIL-EVIDENCE" }], max_completion_tokens: 65000, stream: true }, null, 3);
    const response = await fetch(`${proxy.baseURL}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer private-local-fixture", "x-opencode-session-id": "owned-main", "x-opencode-parent-session-id": "owned-parent", "x-opencode-client": "legalwork", "x-private-unrelated": "never-persist-this-header" }, body: raw });
    assert.equal(await response.text(), wire);
    assert.equal(received.body, raw);
    assert.equal(received.path, "/v1/chat/completions");
    assert.equal(received.headers.authorization, "Bearer private-upstream-fixture");
    const [id] = await readdir(join(root, "requests"));
    let trace;
    for (let attempts = 0; attempts < 100; attempts++) {
      trace = JSON.parse(await readFile(join(root, "requests", id, "trace.json"), "utf8"));
      if (trace.status === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(trace.status, "completed");
    assert.equal(await readFile(join(root, "requests", id, "request.json"), "utf8"), raw);
    assert.equal(await readFile(join(root, "requests", id, "response.raw"), "utf8"), wire);
    assert.equal(trace.usage.input, 1000);
    assert.equal(received.headers["x-opencode-session-id"], "owned-main");
    assert.equal(trace.requestContext.sessionID, "owned-main");
    assert.equal(trace.requestContext.parentSessionID, "owned-parent");
    assert.equal(trace.requestContext.verifiedKind, undefined);
    const requestHeaders=await readFile(join(root,"requests",id,"request-headers.json"),"utf8");
    assert.doesNotMatch(requestHeaders,/never-persist-this-header|private-upstream-fixture|private-local-fixture/);
    const headers = await readFile(join(root, "requests", id, "response-headers.json"), "utf8");
    assert.doesNotMatch(headers, /do-not-capture-fixture/);
    assert.doesNotMatch(JSON.stringify(trace), /private-upstream-fixture|private-local-fixture/);
    assert.equal((await fetch(`${proxy.baseURL}/health`)).status, 401);
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test("requests remain parallel and preserve native thinking/cache/usage protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-parallel-capture-"));
  const pending = [];
  let maximum = 0;
  const wire = 'data: {"type":"message_start","message":{"usage":{"input_tokens":9,"cache_read_input_tokens":500}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\ndata: {"type":"message_stop"}\n\n';
  const upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers["anthropic-beta"], "fixture-beta");
    assert.equal(JSON.parse(Buffer.concat(chunks)).messages[0].content[0].signature, "opaque-signed-state");
    pending.push(response); maximum = Math.max(maximum, pending.length);
    if (pending.length === 2) for (const item of pending) { item.writeHead(200, { "content-type": "text/event-stream" }); item.end(wire); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = await startCaptureProxy({ root, baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "fixture", localToken: "local", models: ["fixture"], fixtureMode: true });
  try {
    const invoke = () => fetch(`${proxy.baseURL}/v1/messages`, { method: "POST", headers: { authorization: "Bearer local", "anthropic-beta": "fixture-beta" }, body: JSON.stringify({ model: "fixture", max_tokens: 128000, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "opaque-signed-state" }] }] }) }).then(response => response.text());
    const response = await Promise.all([invoke(), invoke()]);
    assert.equal(maximum, 2);
    assert.deepEqual(response, [wire, wire]);
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
