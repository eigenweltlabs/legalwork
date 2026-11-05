import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { benchmarkProviderConfiguration } from "./setup-provider.mjs";
import { verifyCaptureTransport } from "./packaged-environment.mjs";

test("remote model traffic uses the guest reverse listener when controller and guest ports differ", async () => {
  const received = [];
  let forwarded = 0;
  const host = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ path: request.url, bytes: Buffer.concat(chunks), authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"fixture":"no-inference"}');
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  const hostPort = host.address().port;
  const guest = http.createServer(async (request, response) => {
    forwarded++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:${hostPort}${request.url}`, {
      method: request.method,
      headers: { authorization: request.headers.authorization, "content-type": "application/json" },
      body: Buffer.concat(chunks),
    });
    response.writeHead(upstream.status, { "content-type": "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  guest.listen(0, "127.0.0.1");
  await once(guest, "listening");
  const guestPort = guest.address().port;
  try {
    assert.notEqual(hostPort, guestPort);
    const capture = { baseURL: `http://127.0.0.1:${hostPort}`, localToken: "test-local-only" };
    const transport = verifyCaptureTransport(capture, { hostPort, guestPort }, `gcloud compute ssh owned -- -N -R 127.0.0.1:${guestPort}:127.0.0.1:${hostPort}`);
    const model = { name: "Fixture", limit: { context: 1048576, output: 65536 }, variants: { medium: { reasoningEffort: "medium" } } };
    const body = benchmarkProviderConfiguration({ modelID: "fixture", model, capture: { ...capture, baseURL: transport.guestBaseURL } });
    const provider = body.opencode.provider.benchmark;
    assert.equal(provider.options.baseURL, `${transport.guestBaseURL}/v1`);
    assert.strictEqual(provider.models.fixture, model);
    const payload = Buffer.from('{"model":"fixture","messages":[{"role":"user","content":"source-only fixture"}],"reasoning_effort":"medium"}');
    assert.equal((await fetch(provider.options.baseURL + "/chat/completions", { method: "POST", headers: { authorization: `Bearer ${provider.options.apiKey}`, "content-type": "application/json" }, body: payload })).status, 200);
    assert.equal(forwarded, 1, "The configured model must traverse the guest listener, not bypass it using the controller port");
    assert.deepEqual(received, [{ path: "/v1/chat/completions", bytes: payload, authorization: "Bearer test-local-only" }]);
    // Negative control: the historical host-URL configuration reaches this
    // synthetic host directly, but demonstrably bypasses the guest hop.
    const old = benchmarkProviderConfiguration({ modelID: "fixture", model, capture });
    await fetch(old.opencode.provider.benchmark.options.baseURL + "/chat/completions", { method: "POST", headers: { authorization: "Bearer test-local-only" }, body: payload });
    assert.equal(forwarded, 1);
    assert.equal(received.length, 2);
  } finally {
    guest.closeAllConnections(); host.closeAllConnections();
    await Promise.all([new Promise(resolve => guest.close(resolve)), new Promise(resolve => host.close(resolve))]);
  }
});

test("native migration receives the verified guest transport and preserves the complete model contract", () => {
  const capture = { baseURL: "http://127.0.0.1:39180", localToken: "test-local-only" };
  const model = { name: "Fixture", modalities: { input: ["text", "image", "pdf"] }, variants: { medium: { reasoningEffort: "medium" } }, limit: { context: 1048576, output: 65536 } };
  const native = { conversionResult: "explicit-test-sentinel" };
  let conversions = 0;
  const configured = benchmarkProviderConfiguration({ modelID: "fixture", model, capture, migrateProvider: provider => {
    conversions++;
    assert.equal(provider.options.baseURL, "http://127.0.0.1:39180/v1");
    assert.equal(provider.options.apiKey, "test-local-only");
    assert.strictEqual(provider.models.fixture, model);
    return native;
  } });
  assert.equal(conversions, 1);
  assert.strictEqual(configured.opencode.providers.benchmark, native);
  assert.equal(configured.opencode.agents.legalwork.model, "benchmark/fixture");
});
