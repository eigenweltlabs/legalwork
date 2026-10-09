import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionV2Request, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client";
import { createClient } from "../src/app/lib/opencode";
import type { PendingPermission, PendingQuestion } from "../src/app/types";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  createInteractionSnapshot, interactionRequestKey, interactionSessionIds, interactionSessionsKey,
  permissionKey, questionKey, refreshWorkspaceInteractions, replyToPermission, replyToQuestion,
  seedInteractionSession, seedPermissionState, seedQuestionState, type InteractionSessions,
} from "../src/react-app/domains/session/sync/interaction-state";
import {
  __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, __disposeWorkspaceSessionSyncForTest,
  acknowledgeInteraction, ensureWorkspaceSessionSync, trackWorkspaceSessionSync,
} from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { upsertRuntimeSession } from "../src/react-app/shell/route-workspaces";

const workspaceId = "subagent-tests";
const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1", legalworkToken: "fixture" };
const queryClient = getReactQueryClient();
const permission = (id = "approval", sessionID = "child"): PermissionRequest => ({
  id, sessionID, permission: "bash", patterns: ["echo example"], metadata: {}, always: [],
});
const v2Permission = (id = "approval-v2", sessionID = "child"): PermissionV2Request => ({
  id, sessionID, action: "file.read", resources: ["/outside/example.txt"], metadata: {}, save: [],
});
const question = (id = "question", sessionID = "child"): QuestionRequest => ({
  id, sessionID, questions: [{ header: "Choice", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }],
});
const session = (id: string, parentID?: string): Session => ({
  id, parentID, title: `Chat ${id}`, slug: id, projectID: "project", directory: "/fixture",
  version: "1", time: { created: 1, updated: 2 },
});
const pendingPermissions = (id = "child") => queryClient.getQueryData<PendingPermission[]>(permissionKey(workspaceId, id)) ?? [];
const pendingQuestions = (id = "child") => queryClient.getQueryData<PendingQuestion[]>(questionKey(workspaceId, id)) ?? [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  queryClient.clear();
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
});

function testSync() {
  cleanups.push(__createWorkspaceSessionSyncForTest(syncInput));
  cleanups.push(trackWorkspaceSessionSync(syncInput, "parent"));
  return (type: string, properties: unknown) => __applySessionSyncEventForTest(syncInput, { type, properties });
}

async function waitUntil(check: () => boolean, timeout = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for interaction state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function testClient(handler?: (request: Request) => Response | Promise<Response> | undefined) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const response = handler?.(request);
      if (response !== undefined) return await response;
      if (request.method === "POST") {
        calls.push({ path, body: await request.json() });
        return path.startsWith("/api/") ? new Response(null, { status: 204 }) : Response.json(true);
      }
      if (path.startsWith("/session/")) {
        const id = path.slice("/session/".length);
        return Response.json(session(id, id === "child" ? "parent" : undefined));
      }
      if (path === "/permission" || path === "/question") return Response.json([]);
      if (path === "/api/permission/request" || path === "/api/question/request") return Response.json({ data: [], location: {} });
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { client: createClient(server.url.toString().replace(/\/$/, "")), calls, server };
}

describe("subagent request scope", () => {
  test("keeps requests from unopened children for both permission protocols and question protocols", () => {
    const emit = testSync();
    emit("permission.asked", permission());
    emit("permission.v2.asked", v2Permission());
    emit("question.asked", question());
    emit("question.v2.asked", question("question-v2"));
    expect(pendingPermissions().map((item) => item.protocol)).toEqual(["legacy", "v2"]);
    expect(pendingQuestions().map((item) => item.protocol)).toEqual(["legacy", "v2"]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
  });

  test("discovers descendants live, forwards new-child metadata, and isolates unrelated chats", () => {
    const emit = testSync();
    const updates: string[] = [];
    cleanups.push(ensureWorkspaceSessionSync({ ...syncInput, onSessionUpdated: (update) => updates.push(update.sessionId) }));
    for (const info of [session("parent"), session("child", "parent"), session("grandchild", "child"), session("other")]) {
      emit("session.created", { info });
    }
    const sessions = queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))!;
    expect(interactionSessionIds("parent", sessions)).toEqual(["parent", "child", "grandchild"]);
    expect(interactionSessionIds("child", sessions)).toEqual(["child", "grandchild"]);
    expect(interactionSessionIds("other", sessions)).toEqual(["other"]);
    expect(updates).toEqual(["parent", "child", "grandchild", "other"]);
    expect(queryClient.getQueryData(interactionSessionsKey("another-workspace"))).toBeUndefined();
  });

  test("stores an early approval until the child creation event establishes its ancestry", () => {
    const emit = testSync();
    emit("permission.asked", permission());
    expect(pendingPermissions()).toHaveLength(1);
    expect(interactionSessionIds("parent", {})).toEqual(["parent"]);
    emit("session.created", { info: session("child", "parent") });
    expect(interactionSessionIds("parent", queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))!))
      .toEqual(["parent", "child"]);
    expect(pendingPermissions()).toHaveLength(1);
  });

  test("handles cyclic ancestry without including unrelated sessions", () => {
    const sessions = { a: session("a", "b"), b: session("b", "a"), other: session("other") };
    expect(interactionSessionIds("a", sessions)).toEqual(["a", "b"]);
    expect(interactionSessionIds(null, sessions)).toEqual([]);
  });

  test("replies in another chat remove only the owner's request and clear waiting state", () => {
    const emit = testSync();
    emit("permission.asked", permission("parent-approval", "parent"));
    emit("permission.v2.asked", v2Permission());
    emit("permission.v2.replied", { sessionID: "child", requestID: "approval-v2", reply: "reject" });
    expect(pendingPermissions()).toEqual([]);
    expect(pendingPermissions("parent")).toHaveLength(1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("idle");
    emit("question.v2.asked", question());
    emit("question.v2.rejected", { sessionID: "child", requestID: "question" });
    expect(pendingQuestions()).toEqual([]);
  });

  test("deleting a child removes its nested requests and keeps unrelated approvals", () => {
    const emit = testSync();
    emit("session.created", { info: session("child", "parent") });
    emit("session.created", { info: session("grandchild", "child") });
    emit("permission.asked", permission());
    emit("question.asked", question("nested-question", "grandchild"));
    emit("permission.asked", permission("other-approval", "other"));
    emit("session.deleted", { info: { id: "child" } });
    emit("permission.asked", permission("late"));
    emit("session.updated", { info: session("child", "parent") });
    expect(pendingPermissions()).toEqual([]);
    expect(pendingQuestions("grandchild")).toEqual([]);
    expect(pendingPermissions("other")).toHaveLength(1);
    expect(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.child).toBeUndefined();
  });

  test("new child sessions enter the sidebar immediately and subsequent updates replace them", () => {
    const child = session("child", "parent");
    const list = upsertRuntimeSession([session("parent")], { sessionId: child.id, info: child });
    expect(list.map((item) => item.id)).toEqual(["parent", "child"]);
    expect(upsertRuntimeSession(list, { sessionId: child.id, info: { title: "Renamed" } })[1]?.title).toBe("Renamed");
    expect(upsertRuntimeSession(list, { sessionId: "unknown", info: { title: "Partial" } })).toBe(list);
  });
});

describe("recovery and reply routing", () => {
  test("recovers unopened child approvals and questions and resolves missing ancestors", async () => {
    const { client } = testClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/permission") return Response.json([permission()]);
      if (path === "/api/question/request") return Response.json({ data: [question()], location: {} });
    });
    const updates: string[] = [];
    await refreshWorkspaceInteractions({ client, workspaceId, snapshot: createInteractionSnapshot(), isCurrent: () => true,
      onSessionUpdated: (update) => updates.push(update.sessionId) });
    expect(pendingPermissions()).toHaveLength(1);
    expect(pendingQuestions()[0]?.protocol).toBe("v2");
    expect(new Set(updates)).toEqual(new Set(["child", "parent"]));
    expect(interactionSessionIds("parent", queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))!))
      .toEqual(["parent", "child"]);
  });

  test("a failed API version does not erase its requests when another version refreshes", async () => {
    seedPermissionState(workspaceId, "child", [permission("stale"), v2Permission()]);
    const { client } = testClient((request) => {
      if (new URL(request.url).pathname === "/api/permission/request") return new Response(null, { status: 503 });
    });
    await refreshWorkspaceInteractions({ client, workspaceId, snapshot: createInteractionSnapshot(), isCurrent: () => true, onSessionUpdated: () => {} });
    expect(pendingPermissions().map((item) => item.id)).toEqual(["approval-v2"]);
  });

  test("late snapshots cannot restore answered requests or drop newly arrived requests", () => {
    const snapshot = createInteractionSnapshot();
    seedPermissionState(workspaceId, "child", [permission()]);
    acknowledgeInteraction(workspaceId, "child", "approval", "permission");
    snapshot.permissions.set(interactionRequestKey("child", "approval"), false);
    seedPermissionState(workspaceId, "child", [permission("new")]);
    snapshot.permissions.set(interactionRequestKey("child", "new"), true);
    seedPermissionState(workspaceId, "child", [permission()], { snapshot, protocol: "legacy" });
    expect(pendingPermissions().map((item) => item.id)).toEqual(["new"]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
    snapshot.questions.set(interactionRequestKey("child", "question"), false);
    seedQuestionState(workspaceId, "child", [question()], { snapshot });
    expect(pendingQuestions()).toEqual([]);
  });

  test("cancelled recovery does not write stale workspace state", async () => {
    const { client } = testClient((request) => {
      if (new URL(request.url).pathname === "/permission") return Response.json([permission()]);
    });
    await refreshWorkspaceInteractions({ client, workspaceId, snapshot: createInteractionSnapshot(), isCurrent: () => false, onSessionUpdated: () => {} });
    expect(pendingPermissions()).toEqual([]);
    expect(queryClient.getQueryData(interactionSessionsKey(workspaceId))).toBeUndefined();
  });

  test("a delayed lineage lookup cannot restore a deleted child", async () => {
    let finishLookup: (response: Response) => void = () => {};
    let lookupStarted = false;
    const { client } = testClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/permission") return Response.json([permission()]);
      if (path === "/session/child") {
        lookupStarted = true;
        return new Promise<Response>((resolve) => { finishLookup = resolve; });
      }
    });
    const snapshot = createInteractionSnapshot();
    const updates: string[] = [];
    const recovery = refreshWorkspaceInteractions({ client, workspaceId, snapshot, isCurrent: () => true,
      onSessionUpdated: (update) => updates.push(update.sessionId) });
    await waitUntil(() => lookupStarted);
    snapshot.deletedSessions.add("child");
    finishLookup(Response.json(session("child", "parent")));
    await recovery;
    expect(updates).toEqual([]);
    expect(queryClient.getQueryData(interactionSessionsKey(workspaceId))).toBeUndefined();
  });

  test("live stream replies and new asks win over an in-flight snapshot", async () => {
    let finishSnapshot: (response: Response) => void = () => {};
    let snapshotStarted = false;
    let snapshotReturned = false;
    let emit = (_type: string, _properties: unknown) => {};
    const { server } = testClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/permission") {
        snapshotStarted = true;
        return new Promise<Response>((resolve) => { finishSnapshot = (response) => { snapshotReturned = true; resolve(response); }; });
      }
      if (path !== "/event") return;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        emit = (type, properties) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
        emit("server.connected", {});
      } }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const input = { workspaceId, baseUrl: server.url.toString().replace(/\/$/, ""), legalworkToken: "fixture" };
    cleanups.push(() => __disposeWorkspaceSessionSyncForTest(input));
    ensureWorkspaceSessionSync(input);
    await waitUntil(() => snapshotStarted);
    emit("permission.asked", permission("answered"));
    emit("permission.asked", permission("live"));
    emit("permission.replied", { sessionID: "child", requestID: "answered", reply: "once" });
    await waitUntil(() => pendingPermissions().length === 1 && pendingPermissions()[0]?.id === "live");
    finishSnapshot(Response.json([permission("answered"), permission("snapshot-only")]));
    await waitUntil(() => snapshotReturned && pendingPermissions().some((item) => item.id === "snapshot-only"));
    expect(new Set(pendingPermissions().map((item) => item.id))).toEqual(new Set(["live", "snapshot-only"]));
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
  });

  test("child permission and question responses reach their original protocol endpoints", async () => {
    seedPermissionState(workspaceId, "child", [permission(), v2Permission()]);
    seedQuestionState(workspaceId, "child", [question()], { protocol: "v2" });
    const { client, calls } = testClient();
    await replyToPermission(client, pendingPermissions().find((item) => item.protocol === "legacy")!, "once", "/fixture");
    await replyToPermission(client, pendingPermissions().find((item) => item.protocol === "v2")!, "reject", "/fixture");
    await replyToQuestion(client, pendingQuestions()[0]!, [["Yes"]], "/fixture");
    expect(calls).toEqual([
      { path: "/permission/approval/reply", body: { reply: "once" } },
      { path: "/api/session/child/permission/approval-v2/reply", body: { reply: "reject" } },
      { path: "/api/session/child/question/question/reply", body: { answers: [["Yes"]] } },
    ]);
  });

  test("failed replies leave the pending approval available for retry", async () => {
    seedPermissionState(workspaceId, "child", [v2Permission()]);
    const { client } = testClient((request) => {
      if (request.method === "POST") return new Response("Unavailable", { status: 503 });
    });
    await expect(replyToPermission(client, pendingPermissions()[0]!, "once", "/fixture")).rejects.toBeDefined();
    expect(pendingPermissions()).toHaveLength(1);
  });

  test("the workspace stream recovers child approvals on initial connection and reconnection", async () => {
    let connections = 0;
    const { server } = testClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/permission") return Response.json([permission(connections > 1 ? "after-reconnect" : "initial")]);
      if (path !== "/event") return;
      connections++;
      if (connections === 1) return new Response('data: {"type":"server.connected","properties":{}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    });
    const input = { workspaceId, baseUrl: server.url.toString().replace(/\/$/, ""), legalworkToken: "fixture" };
    cleanups.push(() => __disposeWorkspaceSessionSyncForTest(input));
    ensureWorkspaceSessionSync(input);
    await waitUntil(() => pendingPermissions().some((item) => item.id === "initial"));
    await waitUntil(() => pendingPermissions().some((item) => item.id === "after-reconnect"));
    expect(pendingPermissions().map((item) => item.id)).toEqual(["after-reconnect"]);
    expect(connections).toBeGreaterThanOrEqual(2);
  });
});
