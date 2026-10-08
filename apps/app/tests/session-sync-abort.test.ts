import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { markEigenweltBudgetStop } from "../src/app/lib/eigenwelt-budget";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import {
  __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync, transcriptKey, statusKey,
} from "../src/react-app/domains/session/sync/session-sync";

test("a late abort event clears the red status, keeps the transcript and pauses queued work", () => {
  const input = { workspaceId: "abort-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const sessionId = "aborted-chat";
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, sessionId);
  const query = getReactQueryClient();
  const activity = useSessionActivityStore.getState();
  try {
    for (const prior of ["busy", "idle"]) {
      activity.setRunStatus(input.workspaceId, sessionId, { type: prior });
      activity.setError(input.workspaceId, sessionId, "Old aborted status");
      __applySessionSyncEventForTest(input, {
        type: "session.error", properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      });
      expect(activity.getStatus(input.workspaceId, sessionId)).toBe("idle");
      expect(activity.getSessionError(input.workspaceId, sessionId)).toBeNull();
      expect(query.getQueryData(statusKey(input.workspaceId, sessionId))).toEqual({ type: "idle" });
      expect(useComposerStateStore.getState().pausedQueues[sessionId]).toBe(true);
    }
    const transcript = query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionId));
    expect(transcript?.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Aborted" }));
    __applySessionSyncEventForTest(input, { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } });
    expect(activity.getStatus(input.workspaceId, sessionId)).toBe("idle");
  } finally { release(); dispose(); activity.removeSession(input.workspaceId, sessionId); query.clear(); }
});

test("provider failures and budget-triggered aborts retain their recovery error", () => {
  const input = { workspaceId: "failure-project", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const sessionId = "failed-chat";
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const activity = useSessionActivityStore.getState();
  try {
    __applySessionSyncEventForTest(input, { type: "session.error", properties: { sessionID: sessionId, error: { name: "APIError", data: { message: "Provider unavailable" } } } });
    expect(activity.getStatus(input.workspaceId, sessionId)).toBe("error");
    markEigenweltBudgetStop(sessionId, Date.now(), "Budget exhausted");
    __applySessionSyncEventForTest(input, { type: "session.error", properties: { sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    expect(activity.getStatus(input.workspaceId, sessionId)).toBe("error");
    expect(activity.getSessionError(input.workspaceId, sessionId)).toBe("Budget exhausted");
  } finally { dispose(); activity.removeSession(input.workspaceId, sessionId); getReactQueryClient().clear(); }
});
