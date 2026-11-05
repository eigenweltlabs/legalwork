import { afterEach, expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import type { SessionQueue } from "@legalwork/types/session-queue";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { permissionKey, questionKey } from "../src/react-app/domains/session/sync/interaction-state";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import { stopSubagentRun } from "../src/react-app/domains/session/surface/stop-subagent";

const workspaceId = "subagent-stop-test";
const sessionId = "child";
const workspaceRoot = "/wikis/Firm knowledge";
const queue: SessionQueue = { workspaceId, sessionId, revision: 2, paused: true, pauseReason: "stop", completedIds: [], entries: [] };

afterEach(() => {
  getReactQueryClient().clear();
  for (const id of [sessionId, "parent", "sibling"]) useSessionActivityStore.getState().removeSession(workspaceId, id);
  useComposerStateStore.getState().setQueuePaused(sessionId, false);
});

function fixture(options: { abort?: boolean; pauseFails?: boolean; abortFails?: boolean } = {}) {
  const calls: string[] = [];
  const serverClient: Pick<LegalworkServerClient, "baseUrl" | "updateSessionMessageQueue"> = {
    baseUrl: "https://queue.invalid",
    updateSessionMessageQueue: async (workspace, session, action) => {
      expect([workspace, session]).toEqual([workspaceId, sessionId]);
      expect(action).toEqual({ type: "pause", paused: true, reason: "stop" });
      calls.push("pause");
      if (options.pauseFails) throw new Error("Queue unavailable");
      return queue;
    },
  };
  const client = OpenCode.make({ baseUrl: "https://engine.invalid", fetch: async (request, init) => {
    const req = request instanceof Request ? request : new Request(request, init);
    const url = new URL(req.url);
    expect(req.method).toBe("POST");
    expect(url.pathname).toBe("/api/session/child/interrupt");
    // Native session operations resolve their saved location from the session ID.
    expect(url.searchParams.has("directory")).toBe(false);
    expect(useComposerStateStore.getState().pausedQueues[sessionId]).toBe(true);
    calls.push("abort");
    if (options.abortFails) throw new Error("Engine unavailable");
    return Response.json({ interrupted: options.abort ?? true });
  } });
  for (const id of [sessionId, "parent", "sibling"]) useSessionActivityStore.getState().setRunStatus(workspaceId, id, { type: "busy" });
  return { calls, stop: () => stopSubagentRun({ client, serverClient, workspaceId, sessionId, workspaceRoot }) };
}

test("stopping one child pauses its queue first, uses its directory and leaves other runs alone", async () => {
  const run = fixture();
  const activity = useSessionActivityStore.getState();
  activity.setWaitingRequest(workspaceId, sessionId, "permission", "request-1", true);
  await run.stop();
  expect(run.calls).toEqual(["pause", "abort"]);
  expect(activity.getStatus(workspaceId, sessionId)).toBe("idle");
  expect(activity.getStatus(workspaceId, "parent")).toBe("thinking");
  expect(activity.getStatus(workspaceId, "sibling")).toBe("thinking");
  expect(getReactQueryClient().getQueryData(permissionKey(workspaceId, sessionId))).toEqual([]);
  expect(getReactQueryClient().getQueryData(questionKey(workspaceId, sessionId))).toEqual([]);
});

test.each([{ abort: false }, { abortFails: true }])("a failed abort never reports the child idle: %j", async options => {
  const run = fixture(options);
  await expect(run.stop()).rejects.toThrow();
  expect(run.calls).toEqual(["pause", "abort"]);
  expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
  expect(useComposerStateStore.getState().pausedQueues[sessionId]).toBe(true);
});

test("a failed queue pause does not abort the child and risk restarting its queued work", async () => {
  const run = fixture({ pauseFails: true });
  await expect(run.stop()).rejects.toThrow("Queue unavailable");
  expect(run.calls).toEqual(["pause"]);
  expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
});
