import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStream, eventStreamErrorEvidence } from "./event-stream.mjs";
import { captureEvents } from "./electron-runner.mjs";

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/events`;
}

test("retains exact large UTF-8 SSE bytes, request authentication and a real quiet interval", async t => {
  const bytes = Buffer.from(`data: ${JSON.stringify({ text: "é漢🦉".repeat(150000) })}\n\n`);
  let observed;
  const url = await fixture(t, async (req, res) => {
    observed = { authorization: req.headers.authorization, encoding: req.headers["accept-encoding"] };
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.write(bytes.subarray(0, 13));
    await delay(120);
    res.end(bytes.subarray(13));
  });
  const controller = new AbortController();
  const started = performance.now();
  const stream = await openEventStream(url, { headers: { authorization: "Bearer fixture-only" }, signal: controller.signal });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.ok(bytes.length > 1024 * 1024);
  assert.ok(performance.now() - started >= 100);
  assert.deepEqual(observed, { authorization: "Bearer fixture-only", encoding: "identity" });
  assert.equal(stream.complete, true);
});

test("actual AbortSignal stops a quiet stream and an already-aborted request", async t => {
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
  });
  const controller = new AbortController();
  const stream = await openEventStream(url, { signal: controller.signal });
  const reading = (async () => { for await (const _chunk of stream) { /* Keep observing until owned cancellation. */ } })();
  await delay(20);
  controller.abort();
  await assert.rejects(reading, /aborted|abort|reset/i);
  await assert.rejects(openEventStream(url, { signal: controller.signal }), error => error.code === "ABORT_ERR");
});

test("premature transport loss rejects rather than silently completing or reconnecting", async t => {
  let requests = 0;
  const url = await fixture(t, (_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {}\n\n");
    setTimeout(() => res.socket.destroy(), 20);
  });
  const stream = await openEventStream(url, { signal: new AbortController().signal });
  await assert.rejects(async () => { for await (const _chunk of stream) { /* Retain any bytes before failure. */ } }, /aborted|premature|reset/i);
  assert.equal(stream.complete, false);
  assert.equal(requests, 1);
});

test("rejects redirects, bad status, non-SSE and encoded responses without following them", async t => {
  for (const [status, headers, code] of [
    [302, { location: "/other" }, "EVENT_STREAM_HTTP_STATUS"],
    [401, {}, "EVENT_STREAM_HTTP_STATUS"],
    [200, { "content-type": "text/html" }, "EVENT_STREAM_CONTENT_TYPE"],
    [200, { "content-type": "text/event-stream", "content-encoding": "gzip" }, "EVENT_STREAM_CONTENT_ENCODING"],
  ]) {
    let requests = 0;
    const url = await fixture(t, (_req, res) => { requests++; res.writeHead(status, headers); res.end("fixture"); });
    await assert.rejects(openEventStream(url, { signal: new AbortController().signal }), error => error.code === code);
    assert.equal(requests, 1);
  }
});

test("rejects unbound endpoints and missing cancellation before network access", () => {
  const fixtureURL = new URL("http://127.0.0.1:123/events");
  fixtureURL.username = "x"; fixtureURL.password = "y";
  for (const url of ["https://127.0.0.1:123/events", "http://localhost:123/events", "http://example.com/events", fixtureURL.href, "http://127.0.0.1:123/events#other"]) {
    assert.throws(() => openEventStream(url, { signal: new AbortController().signal }), error => error.code === "EVENT_STREAM_ENDPOINT");
  }
  assert.throws(() => openEventStream("http://127.0.0.1:123/events", {}), error => error.code === "EVENT_STREAM_SIGNAL");
});

test("private diagnostics retain nested native cause codes and stacks without request headers", () => {
  const cause = Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT", request: { headers: { authorization: "must-not-copy" } } });
  const error = new TypeError("terminated", { cause });
  const evidence = eventStreamErrorEvidence(error);
  assert.equal(evidence.cause.code, "UND_ERR_BODY_TIMEOUT");
  assert.equal(evidence.stack, error.stack);
  assert.equal(evidence.cause.stack, cause.stack);
  assert.ok(!JSON.stringify(evidence).includes("must-not-copy"));
  cause.cause = error;
  assert.equal(eventStreamErrorEvidence(error).cause.cause.circular, true);
});

test("runner preserves exact bytes across split UTF-8, records cancellation and parses a real permission reply", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lw-event-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frame = Buffer.from(`data: ${JSON.stringify({ type: "permission.replied", properties: { sessionID: "owned-session", requestID: "owned-request", reply: "reject", text: "é漢🦉".repeat(150000) } })}\n\n`);
  let sent;
  const delivered = new Promise(resolve => { sent = resolve; });
  const url = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const split = frame.indexOf(Buffer.from("é")) + 1;
    res.write(frame.subarray(0, split));
    await delay(20);
    res.write(frame.subarray(split));
    sent();
  });
  const controller = new AbortController();
  const events = await captureEvents({ base: new URL(url).origin, workspace: { id: "owned" }, token: "fixture-only" }, directory, controller, { eventPath: "/event" });
  await delivered;
  while (!events.permissionReplies().length) { events.check(); await delay(10); }
  controller.abort();
  await events.done;
  events.check();
  assert.deepEqual(await readFile(join(directory, "engine-events.sse")), frame);
  assert.equal(events.permissionReplies()[0].reply, "reject");
  const state = JSON.parse(await readFile(join(directory, "engine-event-stream-lifecycle.json")));
  assert.equal(state.aborted, true);
  assert.equal(state.bytes, frame.length);
  assert.equal(state.bodyIdleTimeoutMs, null);
  assert.equal(state.error, null);
  assert.ok(state.lastChunkAt);
});

test("runner retains full error diagnostics and exact last-byte timing on unrequested disconnect", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lw-event-disconnect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("data: {}\n\n");
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(bytes);
    setTimeout(() => res.socket.destroy(), 25);
  });
  const controller = new AbortController();
  const events = await captureEvents({ base: new URL(url).origin, workspace: { id: "owned" }, token: "fixture-only" }, directory, controller, { eventPath: "/event" });
  await events.done;
  assert.throws(events.check, /aborted|premature|reset/i);
  assert.deepEqual(await readFile(join(directory, "engine-events.sse")), bytes);
  const state = JSON.parse(await readFile(join(directory, "engine-event-stream-lifecycle.json")));
  assert.equal(state.aborted, false);
  assert.equal(state.responseComplete, false);
  assert.ok(state.error.code);
  assert.ok(state.error.stack);
  assert.ok(state.quietMsBeforeFinish >= 0);
});

test("runner rejects a graceful server-ended stream and malformed frames as incomplete", async t => {
  for (const body of ["data: {}\n\n", "data: not-json\n\n"]) {
    const directory = await mkdtemp(join(tmpdir(), "lw-event-ended-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const url = await fixture(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(body); });
    const events = await captureEvents({ base: new URL(url).origin, workspace: { id: "owned" }, token: "fixture-only" }, directory, new AbortController(), { eventPath: "/event" });
    await events.done;
    assert.throws(events.check, /disconnected|Malformed/);
    assert.equal((await readFile(join(directory, "engine-events.sse"))).toString(), body);
  }
});

test("runner persists opening failure cause and closes its files without leaking credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "lw-event-open-failed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await fixture(t, (_req, res) => { res.writeHead(401, { "content-type": "text/plain" }); res.end("fixture rejection"); });
  await assert.rejects(captureEvents({ base: new URL(url).origin, workspace: { id: "owned" }, token: "must-not-appear-in-diagnostics" }, directory, new AbortController(), { eventPath: "/event" }), error => error.code === "EVENT_STREAM_HTTP_STATUS");
  const raw = await readFile(join(directory, "engine-event-stream-lifecycle.json"), "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.error.code, "EVENT_STREAM_HTTP_STATUS");
  assert.ok(state.error.stack);
  assert.equal(state.bytes, 0);
  assert.ok(!raw.includes("must-not-appear-in-diagnostics"));
});
