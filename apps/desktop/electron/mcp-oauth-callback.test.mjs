import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { EventEmitter } from "node:events";
import { createMcpOAuthCallbackBroker, watchMcpOAuthOwner } from "./mcp-oauth-callback.mjs";

async function callbackUri() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${address.port}/mcp/oauth/callback`;
}

describe("MCP OAuth browser callback", () => {
  it("validates state before consuming a code and reports receipt without claiming connection", async () => {
    const broker = createMcpOAuthCallbackBroker();
    try {
      const listener = await broker.listen({ redirectUri: await callbackUri() });
      const waiting = broker.wait({ listenerId: listener.listenerId, state: "expected-state" });
      const invalid = await fetch(`${listener.redirectUri}?state=another-attempt&code=untrusted`);
      assert.equal(invalid.status, 400);
      const valid = await fetch(`${listener.redirectUri}?state=expected-state&code=authorized-code`);
      assert.equal(valid.status, 200);
      assert.equal(valid.headers.get("cache-control"), "no-store");
      const page = await valid.text();
      assert.match(page, /Authorization received/);
      assert.doesNotMatch(page, /successfully connected/i);
      assert.deepEqual(await waiting, { code: "authorized-code" });
      await assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "expected-state" }), /no longer active/);
    } finally {
      broker.close();
    }
  });

  it("delivers provider denial and releases the callback port", async () => {
    const broker = createMcpOAuthCallbackBroker();
    try {
      const listener = await broker.listen({ redirectUri: await callbackUri() });
      const rejected = assert.rejects(
        broker.wait({ listenerId: listener.listenerId, state: "expected-state" }),
        /User declined access/,
      );
      const response = await fetch(`${listener.redirectUri}?state=expected-state&error=access_denied&error_description=User%20declined%20access`);
      assert.equal(response.status, 200);
      await rejected;
      const next = await broker.listen({ redirectUri: listener.redirectUri });
      broker.cancel(next.listenerId);
    } finally {
      broker.close();
    }
  });

  it("cancels only the owning window's attempt and rejects its pending waiter", async () => {
    const broker = createMcpOAuthCallbackBroker();
    try {
      const listener = await broker.listen({ redirectUri: await callbackUri() }, 41);
      await assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "state" }, 99), /no longer active/);
      const rejected = assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "state" }, 41), /cancelled/);
      broker.cancel(listener.listenerId, 99);
      broker.cancelOwner(41);
      await rejected;
      const next = await broker.listen({ redirectUri: listener.redirectUri });
      broker.cancel(next.listenerId);
    } finally {
      broker.close();
    }
  });

  it("expires waiting attempts and prevents duplicate waiters", async () => {
    const broker = createMcpOAuthCallbackBroker({ timeoutMs: 25 });
    try {
      const listener = await broker.listen({ redirectUri: await callbackUri() });
      const rejected = assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "state" }), /timed out/);
      await assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "state" }), /already waiting/);
      await rejected;
    } finally {
      broker.close();
    }
  });

  it("releases callbacks on renderer reload, navigation, or crash while keeping same-document navigation", async () => {
    const broker = createMcpOAuthCallbackBroker();
    const contents = Object.assign(new EventEmitter(), { id: 41 });
    watchMcpOAuthOwner(contents, broker);
    const redirectUri = await callbackUri();
    try {
      for (const lifecycleEvent of ["did-start-navigation", "render-process-gone", "destroyed"]) {
        const listener = await broker.listen({ redirectUri }, contents.id);
        const rejected = assert.rejects(broker.wait({ listenerId: listener.listenerId, state: "state" }, contents.id), /cancelled/);
        contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
        contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
        // Neither subframe navigation nor pushState loses the active callback.
        await assert.rejects(broker.listen({ redirectUri }), /MCP_OAUTH_CALLBACK_IN_USE/);
        contents.emit(lifecycleEvent, { isMainFrame: true, isSameDocument: false });
        await rejected;
      }
      const replacement = await broker.listen({ redirectUri }, contents.id);
      broker.cancel(replacement.listenerId, contents.id);
    } finally {
      broker.close();
    }
  });

  it("cancels a listener still binding when its renderer reloads", async () => {
    const broker = createMcpOAuthCallbackBroker();
    const redirectUri = await callbackUri();
    try {
      const listening = broker.listen({ redirectUri }, 41);
      broker.cancelOwner(41);
      await assert.rejects(listening, /cancelled/);
      const replacement = await broker.listen({ redirectUri }, 41);
      broker.cancel(replacement.listenerId, 41);
    } finally {
      broker.close();
    }
  });

  it("rejects non-loopback redirects and reports occupied callback ports", async () => {
    const broker = createMcpOAuthCallbackBroker();
    try {
      for (const redirectUri of ["https://example.com/callback", "http://0.0.0.0/callback", "http://127.0.0.1/callback?state=bad"]) {
        await assert.rejects(broker.listen({ redirectUri }), /HTTP loopback/);
      }
      const listener = await broker.listen({ redirectUri: await callbackUri() });
      await assert.rejects(broker.listen({ redirectUri: listener.redirectUri }), /MCP_OAUTH_CALLBACK_IN_USE/);
    } finally {
      broker.close();
    }
  });
});
