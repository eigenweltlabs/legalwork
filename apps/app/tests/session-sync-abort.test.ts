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
    expect(transcript?.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Stopped by you" }));
    expect(transcript?.at(-1)?.metadata).toMatchObject({ opencode: { stopped: true } });
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

test("abort and idle events leave other chats and another project's child streaming", () => {
  const projects = ["stop-project-a", "stop-project-b"].map(workspaceId => ({ workspaceId, baseUrl: "http://127.0.0.1:1", legalworkToken: "fixture" }));
  const disposers = projects.map(__createWorkspaceSessionSyncForTest);
  const runs = [
    { project: projects[0], id: "parent-a" }, { project: projects[0], id: "sibling-a" },
    { project: projects[1], id: "parent-b" }, { project: projects[1], id: "child-b" },
  ];
  const releases = runs.map(run => trackWorkspaceSessionSync(run.project, run.id));
  const query = getReactQueryClient(), activity = useSessionActivityStore.getState();
  try {
    for (const run of runs) __applySessionSyncEventForTest(run.project, {
      type: "session.status", properties: { sessionID: run.id, status: { type: "busy" } },
    });
    __applySessionSyncEventForTest(projects[0], { type: "session.error", properties: {
      sessionID: "parent-a", error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    } });
    __applySessionSyncEventForTest(projects[0], { type: "session.idle", properties: { sessionID: "parent-a" } });
    expect(activity.getStatus(projects[0].workspaceId, "parent-a")).toBe("idle");
    for (const run of runs.slice(1)) {
      expect(query.getQueryData(statusKey(run.project.workspaceId, run.id))).toEqual({ type: "busy" });
      expect(useComposerStateStore.getState().pausedQueues[run.id]).not.toBe(true);
      __applySessionSyncEventForTest(run.project, { type: "message.part.updated", properties: { part: {
        id: `${run.id}-part`, messageID: `${run.id}-message`, sessionID: run.id, type: "text", text: "Still working after another chat stopped.",
      } } });
      const transcript = query.getQueryData<UIMessage[]>(transcriptKey(run.project.workspaceId, run.id));
      expect(transcript?.at(-1)?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Still working after another chat stopped." }));
      expect(["thinking", "responding"]).toContain(activity.getStatus(run.project.workspaceId, run.id));
    }
  } finally {
    releases.forEach(release => release()); disposers.forEach(dispose => dispose());
    for (const run of runs) {
      activity.removeSession(run.project.workspaceId, run.id);
      useComposerStateStore.getState().setQueuePaused(run.id, false);
    }
    query.clear();
  }
});
