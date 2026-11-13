import { afterEach, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { LegalworkSessionSnapshot } from "../src/app/lib/legalwork-server";
import { projectMessage, projectSession } from "../src/app/lib/opencode-view";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { applySessionRevert, seedSessionState, snapshotKey, transcriptKey } from "../src/react-app/domains/session/sync/session-sync";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

const workspaceId = "history-undo-probe";
const session = projectSession({ id: "ses_undo_probe", title: "Synthetic undo", projectID: "project", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } });
function snapshot(start: number, count: number): LegalworkSessionSnapshot {
  return { session, status: { type: "idle" }, todos: [], historyPage: { count, olderCursor: "older" },
    messages: Array.from({ length: count }, (_, index) => projectMessage(session.id, {
      id: `msg_${start + index}`, type: "user", text: `Synthetic message ${start + index}`, time: { created: start + index },
    })).flat() };
}
afterEach(() => getReactQueryClient().clear());

test("undoing an unloaded message clears stale tail caches before refetch", () => {
  const query = getReactQueryClient(), tail = snapshot(281, 140);
  seedSessionState(workspaceId, tail);
  query.setQueryData(snapshotKey(workspaceId, session.id), tail);
  applySessionRevert(workspaceId, { ...session, revert: { messageID: "msg_101", files: [] } });
  expect(query.getQueryData(transcriptKey(workspaceId, session.id))).toEqual([]);
  expect(query.getQueryData<LegalworkSessionSnapshot>(snapshotKey(workspaceId, session.id))?.messages).toEqual([]);
});

test.each([100, 0])("an authoritative undone snapshot cannot resurrect the former live tail (%s messages remain)", count => {
  const query = getReactQueryClient();
  seedSessionState(workspaceId, snapshot(281, 140));
  const beforeUndo = snapshot(1, count);
  beforeUndo.session = { ...session, revert: { messageID: `msg_${count + 1}`, files: [] } };
  seedSessionState(workspaceId, beforeUndo);
  expect(query.getQueryData<UIMessage[]>(transcriptKey(workspaceId, session.id))).toEqual(snapshotToUIMessages(beforeUndo));
});
