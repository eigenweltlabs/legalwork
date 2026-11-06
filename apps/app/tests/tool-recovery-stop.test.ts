import { expect, spyOn, test } from "bun:test";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { t } from "../src/i18n";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import {
  __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest,
  seedSessionState, snapshotKey, trackWorkspaceSessionSync, transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import type { UIMessage } from "ai";
import { projectMessage } from "@legalwork/types/opencode-view";

type Message = LegalworkSessionSnapshot["messages"][number];
function assistant(id: string, parentID = "prompt", aborted = true): Message {
  return { info: {
    id, parentID, sessionID: "chat", role: "assistant", time: { created: 2, completed: 3 },
    providerID: "test", modelID: "test", agent: "build", mode: "build", path: { cwd: "/project", root: "/project" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(aborted ? { error: { name: "MessageAbortedError", data: { message: "Aborted" } } } : {}),
  }, parts: [] };
}
function note(legacy = false): Message {
  return { info: {
    id: "reason", sessionID: "chat", role: "user", time: { created: 4 }, agent: "build", model: { providerID: "test", modelID: "test" },
  }, parts: [{
    id: "reason-part", messageID: "reason", sessionID: "chat", type: "text", synthetic: true,
    text: "Stopped because identical invalid calls to fixture continued for three assistant steps after correction guidance. Internal field details.",
    ...(legacy ? {} : { metadata: { legalworkStop: { reason: "repeated-invalid-tool-calls", messageID: "failed-call" } } }),
  }] };
}
function snapshot(messages: Message[]): LegalworkSessionSnapshot {
  return { session: { id: "chat", title: "Stop explanation", version: "1", time: { created: 1, updated: 5 } }, messages, todos: [], status: { type: "idle" } };
}
function texts(messages: UIMessage[]) {
  return messages.flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []));
}

test("reload explains automatic stops, hides internal guidance and preserves later manual stops", () => {
  for (const legacy of [false, true]) {
    const messages = snapshotToUIMessages(snapshot([
      assistant("failed-call", "prompt", false), assistant("aborted"), note(legacy), assistant("manual", "follow-up"),
    ]));
    expect(texts(messages)).toEqual([t("chat.stopped_invalid_tool_calls"), "Stopped"]);
    expect(messages.filter((message) => message.id.includes("aborted"))).toHaveLength(1);
    expect(texts(messages).join(" ")).not.toContain("Internal field details");
  }
});

test("a stop note only labels an abort belonging to the failed call's turn", () => {
  const messages = snapshotToUIMessages(snapshot([
    assistant("failed-call", "first-prompt", false), { ...note(), info: { ...note().info, id: "later-prompt" }, parts: [{ id: "user-text", messageID: "later-prompt", sessionID: "chat", type: "text", text: "Next task" }] }, assistant("unrelated-abort", "later-prompt"), note(),
  ]));
  expect(texts(messages)).toEqual(["Next task", "Stopped"]);
});

test("a delayed reason refreshes after the generic abort and reconciles to one explanation", () => {
  const input = { workspaceId: "stop-reason-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, "chat");
  const query = getReactQueryClient();
  const invalidations = spyOn(query, "invalidateQueries");
  try {
    const stopped = assistant("failed-call");
    stopped.parts.push({ id: "step", sessionID: "chat", messageID: "failed-call", type: "step-start" });
    seedSessionState(input.workspaceId, snapshot([stopped]));
    __applySessionSyncEventForTest(input, { type: "session.execution.interrupted", id: "abort", created: 3, durable: { aggregateID: "chat", seq: "1", version: 1 }, data: { sessionID: "chat" } });
    expect(texts(query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "chat")) ?? [])).toEqual(["Stopped"]);
    invalidations.mockClear();
    __applySessionSyncEventForTest(input, { type: "session.synthetic", id: "reason", created: 4, durable: { aggregateID: "chat", seq: "2", version: 1 }, data: { sessionID: "chat" } });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: snapshotKey(input.workspaceId, "chat"), exact: true });
    seedSessionState(input.workspaceId, snapshot([stopped, note()]));
    expect(texts(query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "chat")) ?? [])).toEqual([t("chat.stopped_invalid_tool_calls")]);
  } finally { invalidations.mockRestore(); release(); dispose(); query.clear(); }
});

test("native stop notes retain their structured reason while ordinary synthetic context stays hidden", () => {
  const native = { type: "synthetic", id: "reason", time: { created: 4 }, text: "Internal stop explanation", metadata: { legalworkStop: { reason: "repeated-invalid-tool-calls", messageID: "failed-call" } } };
  const projected = projectMessage("chat", native);
  expect(texts(snapshotToUIMessages(snapshot([assistant("failed-call", "prompt", false), ...projected])))).toEqual([t("chat.stopped_invalid_tool_calls")]);
  expect(projectMessage("chat", { ...native, metadata: {} })).toEqual([]);
});

test("native metadata explains a stop between steps without resuming or adding a user message", () => {
  const data = snapshot([assistant("failed-call", "prompt", false), assistant("later", "follow-up", false)]);
  data.session.metadata = { legalworkToolStops: { "failed-call": { reason: "repeated-invalid-tool-calls" } } };
  expect(texts(snapshotToUIMessages(data))).toEqual([t("chat.stopped_invalid_tool_calls")]);
});
