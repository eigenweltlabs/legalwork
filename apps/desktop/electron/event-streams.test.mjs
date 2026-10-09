import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { createEventStreams } from "./event-streams.mjs";

class Owner extends EventEmitter {
  isDestroyed() { return false; }
}

test("multiple windows can stream while ordinary requests still complete; owners cannot read each other's streams", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: Frist geändert\n\n");
    } else response.end("ready");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const base = `http://127.0.0.1:${address.port}`;
  const bridge = createEventStreams();
  const windows = Array.from({ length: 8 }, () => new Owner());
  try {
    for (const owner of windows) {
      const metadata = await bridge.open(owner, "same-id", `${base}/events`, {});
      assert.equal(metadata.status, 200);
      assert.equal(new TextDecoder().decode(await bridge.read(owner, "same-id")), "data: Frist geändert\n\n");
    }
    assert.equal(await (await fetch(base, { signal: AbortSignal.timeout(2000) })).text(), "ready");
    await assert.rejects(bridge.read(new Owner(), "same-id"), /another window/);
    const pending = bridge.read(windows[0], "same-id");
    bridge.cancel(windows[0], "same-id");
    assert.equal(await pending, null);
    await assert.rejects(bridge.read(windows[0], "same-id"), /closed/);
  } finally {
    for (const owner of windows) owner.emit("destroyed");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("closing a window aborts a connection still waiting for headers", async () => {
  const owner = new Owner();
  const bridge = createEventStreams((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const opening = bridge.open(owner, "pending", "http://localhost/events", {});
  owner.emit("destroyed");
  await assert.rejects(opening);
  await assert.rejects(bridge.read(owner, "pending"), /closed/);
});

test("completed streams are released and unsupported protocols are rejected", async () => {
  const owner = new Owner();
  const bridge = createEventStreams(async () => new Response("done"));
  await assert.rejects(bridge.open(owner, "bad", "file:///etc/passwd", {}), /HTTP URL/);
  await bridge.open(owner, "complete", "http://localhost/events", {});
  assert.equal(new TextDecoder().decode(await bridge.read(owner, "complete")), "done");
  assert.equal(await bridge.read(owner, "complete"), null);
  await assert.rejects(bridge.read(owner, "complete"), /closed/);
});
