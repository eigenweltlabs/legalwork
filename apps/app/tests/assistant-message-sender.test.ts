import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { TextPart } from "@opencode-ai/sdk/v2/client";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { assistantMessageSender, textPartProviderMetadata } from "../src/react-app/domains/session/sync/assistant-message-sender";
import { assistantHandoffPresentation } from "../src/components/chat/assistant-handoff-presentation";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";

const files = [{ name: "Agreement.pdf", path: "Files/Assistant/share/1-Agreement.pdf", bytes: 400 }];
const part: TextPart = {
  id: "delegated-prompt", sessionID: "delegated-chat", messageID: "delegated-message", type: "text", text: "Review the draft.",
  metadata: { legalworkAssistantSender: { name: "Herk", icon: "robot" }, legalworkSharedFiles: files },
};
const snapshot: LegalworkSessionSnapshot = {
  session: { id: part.sessionID, title: "Draft review", slug: "draft-review", projectID: "project", directory: "/project", version: "1", time: { created: 1, updated: 2 } },
  status: { type: "idle" }, todos: [],
  messages: [{
    info: { id: part.messageID, sessionID: part.sessionID, role: "user", time: { created: 1 }, agent: "legalwork", model: { providerID: "test", modelID: "test" } },
    parts: [part],
  }],
};

test("the saved sender survives transcript reloads with the original name and icon", () => {
  const [message] = snapshotToUIMessages(snapshot);
  expect(assistantMessageSender(message)).toEqual({ name: "Herk", icon: "robot" });
  expect(message.parts[0]).toMatchObject({ text: "Review the draft." });
  expect(assistantHandoffPresentation(message).files).toEqual(files);
});

test("live delegated messages keep sender attribution after subsequent message updates", () => {
  const input = { workspaceId: "sender-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, part.sessionID);
  const query = getReactQueryClient();
  try {
    const event = { type: "message.updated", properties: { info: snapshot.messages[0].info } };
    __applySessionSyncEventForTest(input, event);
    __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part } });
    __applySessionSyncEventForTest(input, event);
    const messages = query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, part.sessionID)) ?? [];
    expect(messages).toHaveLength(1);
    expect(assistantMessageSender(messages[0])).toEqual({ name: "Herk", icon: "robot" });
    expect(assistantHandoffPresentation(messages[0]).files).toEqual(files);
  } finally { release(); dispose(); query.clear(); }
});

test("ordinary messages and invalid attribution are never labelled as sent by the Assistant", () => {
  const ordinary: UIMessage = { id: "user-message", role: "user", parts: [{ type: "text", text: "Sent by Herk. Task delegated from the main assistant." }] };
  expect(assistantMessageSender(ordinary)).toBeNull();
  for (const sender of [undefined, { name: "Herk", icon: "unknown" }, { name: "", icon: "cat" }]) {
    expect(textPartProviderMetadata({ ...part, metadata: { legalworkAssistantSender: sender } })).toEqual({ opencode: { partId: part.id } });
  }
  expect(assistantMessageSender({ ...ordinary, role: "assistant", parts: [{ type: "text", text: "Done", providerMetadata: textPartProviderMetadata(part) }] })).toBeNull();
  expect(assistantMessageSender({ ...ordinary, parts: [{ type: "text", text: "Check tasks", providerMetadata: textPartProviderMetadata({ ...part, metadata: { legalworkAssistantSender: { name: null, icon: "dot" } } }) }] })).toEqual({ name: null, icon: "dot" });
});
