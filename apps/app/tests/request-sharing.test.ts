import { expect, test } from "bun:test";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

test("twenty concurrent identical reads share one transfer, each with an independent value", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() { calls++; await Bun.sleep(20); return Response.json({ ok: true, version: String(calls), uptimeMs: 0 }); } });
  const client = createLegalworkServerClient({ baseUrl: String(server.url), token: "owner" });
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => client.health()));
    expect(calls).toBe(1); results[0]!.version = "local mutation";
    expect(results[1]!.version).toBe("1");
    expect((await client.health()).version).toBe("2"); expect(calls).toBe(2);
  } finally { server.stop(true); }
});

test("credentials and mutations are never merged, and failed reads can retry", async () => {
  let calls = 0; let fail = true;
  const server = Bun.serve({ port: 0, async fetch(request) {
    calls++; await Bun.sleep(10);
    if (fail && request.method === "GET") return Response.json({ message: "offline" }, { status: 503 });
    return Response.json({ ok: true, version: "1", uptimeMs: 0 });
  } });
  const a = createLegalworkServerClient({ baseUrl: String(server.url), token: "a" });
  const b = createLegalworkServerClient({ baseUrl: String(server.url), token: "b" });
  try {
    await Promise.allSettled([a.health(), a.health(), b.health()]); expect(calls).toBe(2);
    fail = false; await a.health(); expect(calls).toBe(3);
    await Promise.all([a.runProjectSync(), a.runProjectSync()]); expect(calls).toBe(5);
  } finally { server.stop(true); }
});

test("one caller cancelling does not cancel an independent read", async () => {
  const server = Bun.serve({ port: 0, async fetch() { await Bun.sleep(30); return Response.json({ sessions: [] }); } });
  const client = createLegalworkServerClient({ baseUrl: String(server.url) });
  const controller = new AbortController();
  try {
    const cancelled = client.sessionInbox(controller.signal);
    const surviving = client.sessionInbox(); controller.abort(new Error("Left view"));
    await expect(cancelled).rejects.toThrow("Left view");
    expect((await surviving).sessions).toEqual([]);
  } finally { server.stop(true); }
});

test("older-server group reads honor caller cancellation too", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ items: [], state: { groups: [], assignments: {} } }) });
  const client = createLegalworkServerClient({ baseUrl: String(server.url) });
  const controller = new AbortController(); controller.abort(new Error("Left old server"));
  try {
    await expect(client.listSessionGroupEvents("ws", { signal: controller.signal })).rejects.toThrow("Left old server");
    await expect(client.getSessionGroups("ws", controller.signal)).rejects.toThrow("Left old server");
  } finally { server.stop(true); }
});

test("explicit read-only POST queries share only identical input and stay fresh after writes", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, async fetch() {
    calls++; await Bun.sleep(15); return Response.json({ revision: calls, documentIds: [] });
  } });
  const client = createLegalworkServerClient({ baseUrl: String(server.url) });
  try {
    await Promise.all(Array.from({ length: 10 }, () => client.queryReviewRows("ws", "review", {})));
    expect(calls).toBe(1);
    await Promise.all([client.queryReviewRows("ws", "review", { query: "one" }), client.queryReviewRows("ws", "review", { query: "two" })]);
    expect(calls).toBe(3);
    await Promise.all([client.runProjectSync(), client.runProjectSync()]);
    expect(calls).toBe(5);
    await client.queryReviewRows("ws", "review", {});
    expect(calls).toBe(6);
  } finally { server.stop(true); }
});

test("a mutation prevents a later read from joining an older snapshot", async () => {
  let reads = 0; let release: (() => void) | undefined;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method !== "GET") return Response.json({});
    const version = ++reads;
    if (version === 1) await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ ok: true, version: String(version), uptimeMs: 0 });
  } });
  const client = createLegalworkServerClient({ baseUrl: String(server.url) });
  try {
    const old = client.health();
    while (!release) await Bun.sleep(1);
    await client.runProjectSync();
    const fresh = await client.health(); expect(fresh.version).toBe("2");
    release(); expect((await old).version).toBe("1");
  } finally { release?.(); server.stop(true); }
});

test("a JSON deadline covers a stalled response body after headers", async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); } }), { headers: { "content-type": "application/json" } });
  } });
  const start = Date.now();
  try {
    await expect(createLegalworkServerClient({ baseUrl: String(server.url) }).health()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(4000);
  } finally { server.stop(true); }
}, 4500);

test("large JSON responses can keep making progress beyond the initial deadline", async () => {
  const server = Bun.serve({ port: 0, fetch() {
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true,'));
      await Bun.sleep(1700); controller.enqueue(new TextEncoder().encode('"version":"large",'));
      await Bun.sleep(1700); controller.enqueue(new TextEncoder().encode('"uptimeMs":0}')); controller.close();
    } }), { headers: { "content-type": "application/json" } });
  } });
  try { expect((await createLegalworkServerClient({ baseUrl: String(server.url) }).health()).version).toBe("large"); }
  finally { server.stop(true); }
}, 6000);
