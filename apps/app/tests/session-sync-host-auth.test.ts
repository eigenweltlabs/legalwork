import { afterEach, expect, test } from "bun:test";
import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { UIMessage } from "ai";
import { projectSession } from "../src/app/lib/opencode-view";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __disposeWorkspaceSessionSyncForTest, ensureWorkspaceSessionSync,
  snapshotKey, trackWorkspaceSessionSync, transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  getReactQueryClient().clear();
});
const session: SessionInfo = {
  id: "wiki-chat", title: "Wiki", projectID: "wiki", location: { directory: "/private/wiki" },
  time: { created: 1, updated: 4 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const messages: SessionMessageInfo[] = [
  { id: "user", type: "user", time: { created: 2 }, text: "Can you read the wiki?" },
  { id: "assistant", type: "assistant", time: { created: 3, completed: 4 },
    model: { providerID: "fixture", id: "model" }, agent: "legalwork", cost: 0, tokens: session.tokens,
    content: [{ type: "text", text: "Yes, I can read the wiki." }] },
];
async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for live wiki synchronization");
}
function fixture() {
  const calls: Array<{ path: string; token: string | null; host: string | null }> = [];
  const streams = new Set<{ host: string | null; controller: ReadableStreamDefaultController<Uint8Array> }>();
  const encoder = new TextEncoder();
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const host = request.headers.get("x-legalwork-host-token");
    calls.push({ path, token: request.headers.get("authorization"), host });
    if (path.endsWith("/api/event")) {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        const stream = { host, controller }; streams.add(stream);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "connected", type: "server.connected", data: {} })}\n\n`));
        request.signal.addEventListener("abort", () => { streams.delete(stream); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (host !== "wiki-owner") return new Response(null, { status: 404 });
    const message = messages.find(message => path.endsWith(`/message/${message.id}`));
    if (message) return Response.json({ data: message });
    if (path.endsWith(`/api/session/${session.id}`)) return Response.json({ data: session });
    return Response.json({ data: [] });
  } });
  cleanups.push(() => server.stop(true));
  const input = {
    workspaceId: "wiki-auth", baseUrl: `${server.url.origin}/workspace/wiki-auth/opencode`,
    legalworkToken: "member", legalworkHostToken: "wiki-owner",
  };
  const connect = (authority = input) => {
    ensureWorkspaceSessionSync(authority);
    cleanups.push(() => __disposeWorkspaceSessionSyncForTest(authority));
  };
  return { input, calls, connect, emit(type: string, data: object) {
    const frame = encoder.encode(`data: ${JSON.stringify({ id: type, type, data })}\n\n`);
    // As on the server, a member-only stream must not expose a private wiki.
    for (const stream of streams) if (stream.host === "wiki-owner") stream.controller.enqueue(frame);
  } };
}

test("private wiki user messages and assistant replies arrive live with the host's authority", async () => {
  const f = fixture();
  const query = getReactQueryClient();
  query.setQueryData(snapshotKey(f.input.workspaceId, session.id), {
    session: projectSession(session), messages: [], todos: [], status: { type: "idle" },
  });
  f.connect();
  trackWorkspaceSessionSync(f.input, session.id);
  await waitUntil(() => f.calls.some(call => call.path.endsWith("/api/event")));
  expect(f.calls.find(call => call.path.endsWith("/api/event"))).toMatchObject({ token: "Bearer member", host: "wiki-owner" });
  f.emit("session.inbox.delivered", { sessionID: session.id, inboxID: "user" });
  f.emit("session.step.ended", { sessionID: session.id, assistantMessageID: "assistant" });
  const transcript = () => query.getQueryData<UIMessage[]>(transcriptKey(f.input.workspaceId, session.id)) ?? [];
  await waitUntil(() => transcript().length === 2);
  expect(transcript().map(message => [message.role, message.parts.find(part => part.type === "text")?.text])).toEqual([
    ["user", "Can you read the wiki?"], ["assistant", "Yes, I can read the wiki."],
  ]);
  expect(f.calls.filter(call => call.path.includes("/message/"))).toHaveLength(2);
  expect(f.calls.every(call => call.host === "wiki-owner")).toBe(true);
});

test("host changes and member-only connections never reuse another authority's sync", async () => {
  const f = fixture();
  f.connect();
  f.connect({ ...f.input, legalworkHostToken: "different-owner" });
  f.connect({ ...f.input, legalworkHostToken: "" });
  await waitUntil(() => f.calls.filter(call => call.path.endsWith("/api/event")).length === 3);
  expect(f.calls.filter(call => call.path.endsWith("/api/event")).map(call => call.host).sort()).toEqual([
    null, "different-owner", "wiki-owner",
  ].sort());
});
