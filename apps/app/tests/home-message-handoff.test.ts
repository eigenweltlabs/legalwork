import { afterEach, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { createHomeMessage } from "../src/react-app/domains/session/home/home-message";
import { submitHomeMessage, type PendingHomeMessage } from "../src/react-app/domains/session/home/home-submission";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, seedSessionState, seedSubmittedMessage, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

afterEach(() => getReactQueryClient().clear());

test("the first message survives an empty snapshot and an assistant arriving before its user event", () => {
  const input = { workspaceId: "home-handoff", baseUrl: "http://localhost:1234", legalworkToken: "test" };
  const sessionId = "home-session";
  const message = createHomeMessage();
  const user: UIMessage = {
    id: message.id, role: "user", metadata: { opencode: { created: message.created } },
    parts: [{ type: "text", text: "hi", providerMetadata: { opencode: { partId: message.partId } } }],
  };
  const snapshot: LegalworkSessionSnapshot = {
    session: { id: sessionId, slug: "home", projectID: "project", directory: "/project", title: "Greeting", version: "1", time: { created: message.created, updated: message.created } },
    status: { type: "idle" }, todos: [], messages: [],
  };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, sessionId);
  const cache = getReactQueryClient();
  const rendered = () => deriveRenderedSessionMessages({
    snapshot,
    transcriptState: cache.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId)),
  });
  try {
    seedSubmittedMessage(input.workspaceId, sessionId, user);
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered()).toEqual([user]);

    __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: {
      id: "msg_reply", sessionID: sessionId, role: "assistant", time: { created: message.created + 1 },
    } } });
    __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: {
      id: "prt_reply", messageID: "msg_reply", sessionID: sessionId, type: "text", text: "Hello.",
    } } });
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);
    snapshot.messages = [{
      info: {
        id: "msg_reply", sessionID: sessionId, role: "assistant", parentID: message.id,
        time: { created: message.created + 1 }, modelID: "test", providerID: "test", mode: "build", agent: "build",
        path: { cwd: "/project", root: "/project" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{ id: "prt_reply", messageID: "msg_reply", sessionID: sessionId, type: "text", text: "Hello." }],
    }];
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);

    // The engine echoes the supplied IDs; it must replace the cached message,
    // not add another bubble or repeat the text part.
    __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: {
      id: message.id, sessionID: sessionId, role: "user", time: { created: message.created },
    } } });
    __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: {
      id: message.partId, messageID: message.id, sessionID: sessionId, type: "text", text: "hi",
    } } });
    snapshot.messages = [{
      info: { id: message.id, sessionID: sessionId, role: "user", time: { created: message.created }, agent: "build", model: { providerID: "test", modelID: "test" } },
      parts: [{ id: message.partId, messageID: message.id, sessionID: sessionId, type: "text", text: "hi" }],
    }];
    seedSessionState(input.workspaceId, snapshot);
    expect(rendered().map(item => item.role)).toEqual(["user", "assistant"]);
    expect(rendered()[0].parts).toHaveLength(1);
    expect(rendered()[0].parts[0]).toMatchObject({ type: "text", text: "hi" });
  } finally { release(); cleanup(); }
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
