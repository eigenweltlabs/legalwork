import { afterEach, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { projectMessages, projectSession } from "../src/app/lib/opencode-view";
import { createClient } from "../src/app/lib/opencode";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { createHomeMessage } from "../src/react-app/domains/session/home/home-message";
import { submitHomeMessage, type PendingHomeMessage } from "../src/react-app/domains/session/home/home-submission";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, seedSessionState, seedSubmittedMessage, snapshotKey, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

afterEach(() => getReactQueryClient().clear());

test("the first message survives an empty snapshot and an assistant arriving before its user event", async () => {
  const sessionId = "home-session";
  const message = createHomeMessage();
  const nativeUser: SessionMessageInfo = { id: message.id, type: "user", text: "hi", time: { created: message.created } };
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return Response.json({ data: nativeUser });
  } });
  const input = { workspaceId: "home-handoff", baseUrl: server.url.origin, legalworkToken: "test" };
  const user: UIMessage = {
    id: message.id, role: "user", metadata: { opencode: { created: message.created } },
    parts: [{ type: "text", text: "hi", providerMetadata: { opencode: { partId: message.partId } } }],
  };
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const snapshot: LegalworkSessionSnapshot = {
    session: projectSession({ id: sessionId, projectID: "project", location: { directory: "/project" }, title: "Greeting", cost: 0, tokens, time: { created: message.created, updated: message.created } }),
    status: { type: "idle" }, todos: [], messages: [],
  };
  const cleanup = __createWorkspaceSessionSyncForTest(input, createClient(server.url.origin));
  const release = trackWorkspaceSessionSync(input, sessionId);
  const cache = getReactQueryClient();
  const rendered = () => deriveRenderedSessionMessages({ snapshot, transcriptState: cache.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId)) });
  const emit = (event: OpenCodeEvent) => __applySessionSyncEventForTest(input, event);
  const common = { id: "event", created: message.created + 1, location: { directory: "/project" }, durable: { aggregateID: sessionId, seq: 1, version: 1 } };
  try {
    cache.setQueryData(snapshotKey(input.workspaceId, sessionId), snapshot);
    seedSubmittedMessage(input.workspaceId, sessionId, user);
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered()).toEqual([user]);
    emit({ ...common, type: "session.step.started", data: { sessionID: sessionId, assistantMessageID: "msg_reply", agent: "build", model: { providerID: "test", id: "test" }, started: message.created + 1 } });
    emit({ ...common, type: "session.text.started", data: { sessionID: sessionId, assistantMessageID: "msg_reply", ordinal: 0 } });
    emit({ ...common, type: "session.text.ended", data: { sessionID: sessionId, assistantMessageID: "msg_reply", ordinal: 0, text: "Hello." } });
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);
    snapshot.messages = projectMessages(sessionId, [{ id: "msg_reply", type: "assistant", agent: "build", model: { providerID: "test", id: "test" }, time: { created: message.created + 1 }, tokens, cost: 0, content: [{ type: "text", text: "Hello." }] }]);
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);

    // Native inbox delivery identifies the supplied message; the subsequent
    // authoritative flat message read replaces the optimistic text once.
    let unsubscribe = () => {};
    const echoed = new Promise<void>(resolve => {
      unsubscribe = cache.getQueryCache().subscribe(() => {
        const messages = rendered();
        if (messages[0]?.parts.some(part => part.type === "text" && part.providerMetadata?.opencode?.partId === `${message.id}:text`)) resolve();
      });
    });
    try {
      emit({ ...common, type: "session.inbox.delivered", data: { sessionID: sessionId, inboxID: message.id } });
      await echoed;
    } finally { unsubscribe(); }
    snapshot.messages = projectMessages(sessionId, [nativeUser]);
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);
    expect(rendered()[0].parts).toHaveLength(1);
    expect(rendered()[0].parts[0]).toMatchObject({ type: "text", text: "hi" });
    expect(requests).toEqual([`/api/session/${sessionId}/message/${message.id}`]);
  } finally { release(); cleanup(); server.stop(true); }
});

test("retry keeps the request message and part IDs while accepting edited text", async () => {
  const pending: PendingHomeMessage = { sessionId: null, uploads: new Map() };
  const ids: string[] = [];
  const partIds: string[] = [];
  const texts: string[] = [];
  const input = {
    workspaceId: "project", text: "hi", files: [], pending,
    client: { writeWorkspaceBinaryFile: async () => { throw new Error("No upload expected"); } },
    createSession: async () => ({ id: "session" }),
    sendPrompt: async (_session: string, text: string, _context: string, message: ReturnType<typeof createHomeMessage>) => {
      ids.push(message.id); partIds.push(message.partId); texts.push(text);
      if (ids.length === 1) throw new Error("Send unavailable");
    },
  };
  await expect(submitHomeMessage(input)).rejects.toThrow("Send unavailable");
  await submitHomeMessage({ ...input, text: "hello" });
  expect(ids[0]).toMatch(/^msg_[a-f0-9]{26}$/);
  expect(ids[0]).toBe(ids[1]);
  expect(partIds[0]).toBe(partIds[1]);
  expect(texts).toEqual(["hi", "hello"]);
});
