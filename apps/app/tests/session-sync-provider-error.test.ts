import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { eigenweltSignInExpiredMessage } from "../src/react-app/domains/session/sync/eigenwelt-provider-error";
import { describeOpencodeSessionError } from "../src/react-app/domains/session/sync/usechat-adapter";
import { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, trackWorkspaceSessionSync, transcriptKey, snapshotKey } from "../src/react-app/domains/session/sync/session-sync";

const error = { type: "provider.auth", message: "Authentication Error, Invalid proxy server token passed.", status: 401 };

test("live errors use this execution's provider before its message has been fetched", () => {
  const input = { workspaceId: "provider-errors", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" }, sessionID = "test-chat";
  const dispose = __createWorkspaceSessionSyncForTest(input), release = trackWorkspaceSessionSync(input, sessionID);
  const cache = getReactQueryClient(), activity = useSessionActivityStore.getState();
  try {
    for (const providerID of ["tensorx-custom", "eigenwelt", undefined]) {
      // The previous reply used another provider; snapshot fetching may lag SSE.
      cache.setQueryData(snapshotKey(input.workspaceId, sessionID), { messages: [{ info: { role: "assistant", providerID: providerID === "eigenwelt" ? "tensorx-custom" : "eigenwelt" } }] });
      __applySessionSyncEventForTest(input, { type: "session.execution.started", id: "start", created: 1, data: { sessionID } });
      if (providerID) __applySessionSyncEventForTest(input, { type: "session.step.started", id: "step", created: 2, data: { sessionID, assistantMessageID: "reply", agent: "legalwork", model: { providerID, id: "test" }, started: 2 } });
      __applySessionSyncEventForTest(input, { type: "session.execution.failed", id: "failure", created: 3, data: { sessionID, error } });
      const expected = describeOpencodeSessionError(error, "Session failed", providerID);
      expect(activity.getSessionError(input.workspaceId, sessionID)).toBe(expected);
      expect(cache.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, sessionID))?.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: expected }));
      if (providerID !== "eigenwelt") expect(expected).not.toContain(eigenweltSignInExpiredMessage());
    }
  } finally { release(); dispose(); activity.removeSession(input.workspaceId, sessionID); cache.clear(); }
});
