import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  appleFoundationModelsStatus,
  connectAppleFoundationModels,
  appleFoundationModelsUrl,
  listAppleFoundationModels,
  readAppleToolTestStream,
  testAppleFoundationModelsTools,
} from "./apple-foundation-models.mjs";

const supported = { platform: "darwin", systemVersion: "27.0", flag: "1", hasCli: true };
const status = appleFoundationModelsStatus(supported);

test("experiment is explicit opt-in, product-version gated and requires the CLI", () => {
  assert.equal(status.available, true);
  for (const patch of [
    { flag: undefined }, { flag: "0" }, { flag: "true" },
    { platform: "linux" }, { platform: "win32" },
    { systemVersion: "15.6.1" }, { systemVersion: "26.6" },
    { systemVersion: "" }, { systemVersion: "Darwin 26" }, { hasCli: false },
  ]) assert.equal(appleFoundationModelsStatus({ ...supported, ...patch }).available, false, JSON.stringify(patch));
  assert.equal(appleFoundationModelsStatus({ ...supported, systemVersion: "27.1" }).available, true);
  assert.equal(appleFoundationModelsStatus({ ...supported, systemVersion: "28.0" }).available, true);
});

test("native model discovery accepts only loopback HTTP /v1 URLs", () => {
  for (const url of ["http://127.0.0.1:1976/v1", "http://localhost:1977/v1/", "http://[::1]:1976/v1"]) {
    assert.equal(appleFoundationModelsUrl(url).pathname, "/v1/models");
  }
  for (const url of ["https://example.com/v1", "http://192.168.1.2/v1", "http://127.0.0.1.evil.test/v1", "file:///v1", "http://user:pass@localhost/v1", "http://localhost/v1?proxy=x", "http://localhost/v1#x", "http://localhost/admin"]) {
    assert.throws(() => appleFoundationModelsUrl(url));
  }
});

test("model discovery reports unsupported systems and stopped servers without making remote requests", async () => {
  let requests = 0;
  const unavailable = async () => { requests++; throw new Error("ECONNREFUSED"); };
  await assert.rejects(listAppleFoundationModels({ ...status, available: false }, status.baseURL, unavailable), /requires/);
  assert.equal(requests, 0);
  await assert.rejects(listAppleFoundationModels(status, status.baseURL, unavailable), /Start it in Terminal/);
  assert.equal(requests, 1);
  await assert.rejects(listAppleFoundationModels(status, status.baseURL, async () => Response.json({ data: [] })), /no model IDs/);
  await assert.rejects(listAppleFoundationModels(status, status.baseURL, async () => new Response("", { status: 503 })), /HTTP 503/);
});

function event(delta, finish_reason = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
}
function toolEvents() {
  return event({ tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "legalwork_connection_probe", arguments: '{"request":' } }] })
    + event({ tool_calls: [{ index: 0, function: { arguments: '"verify"}' } }] })
    + event({}, "tool_calls") + "data: [DONE]\r\n\r\n";
}
function textEvents(content) {
  return event({ content }) + event({}, "stop") + "data: [DONE]\r\n\r\n";
}

test("SSE handles split byte chunks, partial JSON arguments, and UTF-8", async () => {
  const bytes = new TextEncoder().encode(event({ content: "ä" }) + toolEvents());
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
  } });
  const result = await readAppleToolTestStream(new Response(stream));
  assert.equal(result.content, "ä");
  assert.equal(result.toolCalls[0].function.arguments, '{"request":"verify"}');
  assert.equal(result.finishReason, "tool_calls");
});

test("tool probe rejects text-only claims, invalid arguments, incomplete streams and guessed results", async () => {
  await assert.rejects(testAppleFoundationModelsTools(status, status.baseURL, "pcc", async () => new Response(textEvents("I ran your tool successfully."))), /structured tool call/);
  await assert.rejects(testAppleFoundationModelsTools(status, status.baseURL, "pcc", async () => new Response(toolEvents().replace('verify', 'wrong'))), /incorrect tool arguments/);
  await assert.rejects(readAppleToolTestStream(new Response(event({ content: "hello" }))), /incomplete/);
  await assert.rejects(readAppleToolTestStream(new Response('data: {"error":{"message":"rate limit"}}\n\n')), /reported an error/);
  let calls = 0;
  await assert.rejects(testAppleFoundationModelsTools(status, status.baseURL, "pcc", async () => new Response(++calls === 1 ? toolEvents() : textEvents("invented-code"))), /actual tool result/);
});

test("HTTP discovery and streamed tool round-trip preserve the selected model and genuine tool result", async (t) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "pcc" }, { id: "system" }, { id: "pcc" }, { id: null }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const result = body.messages.find((message) => message.role === "tool");
    res.setHeader("Content-Type", "text/event-stream");
    res.end(result ? textEvents(result.content) : toolEvents());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  assert.deepEqual(await listAppleFoundationModels(status, baseURL), ["pcc", "system"]);
  const result = await testAppleFoundationModelsTools(status, baseURL, "pcc");
  assert.match(result.message, /Passed/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "pcc");
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].tool_choice, "auto");
  assert.equal(requests[1].messages[1].tool_calls[0].id, "call_probe");
  assert.match(requests[1].messages[2].content, /^LW-[0-9a-f]{24}$/);
  assert.equal(JSON.stringify(requests[0]).includes(requests[1].messages[2].content), false);
});

test("one-click connection starts a stopped server, retries readiness and checks tools before returning config", async () => {
  let started = 0;
  let discovery = 0;
  let requests = 0;
  const fakeFetch = async (url, options) => {
    if (url.pathname === "/v1/models") {
      if (++discovery <= 2) throw new Error("not ready");
      return Response.json({ data: [{ id: "pcc" }, { id: "system" }] });
    }
    requests++;
    const body = JSON.parse(options.body);
    const result = body.messages.find((message) => message.role === "tool");
    return new Response(result ? textEvents(result.content) : toolEvents());
  };
  const result = await connectAppleFoundationModels(status, async () => { started++; }, fakeFetch, async () => {});
  assert.equal(started, 1);
  assert.equal(discovery, 3);
  assert.equal(requests, 2);
  assert.deepEqual(result, { baseURL: status.baseURL, model: "pcc" });
});

test("one-click connection reuses a running server but does not connect if tool calling fails", async () => {
  let started = 0;
  const fakeFetch = async (url) => url.pathname === "/v1/models"
    ? Response.json({ data: [{ id: "pcc" }] })
    : new Response(textEvents("I called the tool."));
  await assert.rejects(connectAppleFoundationModels(status, async () => { started++; }, fakeFetch), /structured tool call/);
  assert.equal(started, 0);
});

test("one-click connection refuses unavailable platforms, missing PCC and startup failure", async () => {
  let started = 0;
  const start = async () => { started++; };
  await assert.rejects(connectAppleFoundationModels({ ...status, available: false }, start), /requires macOS/);
  assert.equal(started, 0);
  await assert.rejects(connectAppleFoundationModels(status, start, async () => Response.json({ data: [{ id: "system" }] })), /Private Cloud Compute is not available/);
  assert.equal(started, 0);
  await assert.rejects(connectAppleFoundationModels(status, start, async () => { throw new Error("offline"); }, async () => {}), /could not start/);
  assert.equal(started, 1);
});
