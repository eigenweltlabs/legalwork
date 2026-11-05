import { afterEach, expect, test } from "bun:test";
import { createClient, getClientContext } from "../src/app/lib/opencode";
import { sendSessionPrompt } from "../src/app/lib/system-reminder";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function eventServer() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let connections = 0;
  const calls: Array<{ path: string; auth: string | null; host: string | null }> = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push({ path, auth: request.headers.get("authorization"), host: request.headers.get("x-legalwork-host-token") });
    if (path.endsWith("/api/event")) {
      connections++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.add(controller);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", id: "connected", data: {} })}\n\n`));
          request.signal.addEventListener("abort", () => { streams.delete(controller); controller.close(); }, { once: true });
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/prompt")) return Response.json({ data: { id: "receipt", sessionID: "test", type: "user", time: { created: 1 }, payload: { text: "Test" }, delivery: "queue" } });
    return new Response(null, { status: 204 });
  } });
  cleanups.push(() => server.stop(true));
  return { baseUrl: server.url.origin, calls, connections: () => connections,
    emit: () => { for (const stream of streams) stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", id: "next", data: {} })}\n\n`)); },
  };
}

test("open chat clients share a native event connection and leave room for task submission", async () => {
  const fixture = eventServer();
  const subscribers = Array.from({ length: 8 }, () => {
    const client = createClient(fixture.baseUrl, "/project", { token: "office-test", mode: "legalwork" });
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    return { client, controller, iterator: client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]() };
  });
  const events = await Promise.all(subscribers.map(subscriber => subscriber.iterator.next()));
  expect(events.every(event => event.value?.type === "server.connected")).toBe(true);
  expect(fixture.connections()).toBe(1);
  const receipt = await sendSessionPrompt(subscribers[0].client, { sessionID: "test", model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Test" }] });
  expect(receipt.id).toBe("receipt");
  subscribers[0].controller.abort();
  expect((await subscribers[0].iterator.next()).done).toBe(true);
  fixture.emit();
  expect((await subscribers[1].iterator.next()).value?.id).toBe("next");
  expect(fixture.connections()).toBe(1);
  for (const subscriber of subscribers) subscriber.controller.abort();
  expect((await subscribers[1].iterator.next()).done).toBe(true);
  const restarted = subscribers[0].client.event.subscribe()[Symbol.asyncIterator]();
  cleanups.push(() => { void restarted.return?.(); });
  expect((await restarted.next()).value?.id).toBe("connected");
  expect(fixture.connections()).toBe(2);
});

test("sharing preserves project context, endpoint and credential boundaries", async () => {
  const fixture = eventServer();
  const auth = { token: "member", hostToken: "owner", mode: "legalwork" };
  const client = createClient(fixture.baseUrl, "/first", auth);
  const variants = [
    createClient(fixture.baseUrl, "/second", auth),
    createClient(`${fixture.baseUrl}/workspace/other/opencode`, "/first", auth),
    createClient(fixture.baseUrl, "/first", { ...auth, token: "other" }),
    createClient(fixture.baseUrl, "/first", { ...auth, hostToken: "other-owner" }),
    createClient(fixture.baseUrl, "/first", { username: "user", password: "secret", mode: "basic" }),
  ];
  for (const variant of variants) expect(variant).not.toBe(client);
  expect(getClientContext(client)?.directory).toBe("/first");
  expect(getClientContext(variants[0])?.directory).toBe("/second");
  await Promise.all([client, ...variants].map(item => item.session.update({ sessionID: "test", archived: false })));
  expect(fixture.calls.map(call => [call.auth, call.host])).toContainEqual(["Bearer member", "owner"]);
  expect(fixture.calls.map(call => [call.auth, call.host])).toContainEqual(["Bearer other", "owner"]);
  expect(fixture.calls.map(call => [call.auth, call.host])).toContainEqual(["Bearer member", "other-owner"]);
  expect(fixture.calls.map(call => [call.auth, call.host])).toContainEqual([`Basic ${btoa("user:secret")}`, null]);
});
