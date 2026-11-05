import { afterEach, describe, expect, test } from "bun:test";
import type { PermissionRequest, PermissionRequest as PermissionV2Request, FormInfo as QuestionRequest, SessionInfo } from "@opencode/client";
import { projectSession } from "../src/app/lib/opencode-view";
import { createClient } from "../src/app/lib/opencode";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { PendingPermission, PendingQuestion } from "../src/app/types";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  createInteractionSnapshot, interactionRequestKey, interactionSessionIds, interactionSessionsKey,
  permissionKey, questionKey, refreshWorkspaceInteractions, replyToPermission, replyToQuestion,
  seedInteractionSession, seedPermissionState, seedQuestionState, type InteractionSessions,
} from "../src/react-app/domains/session/sync/interaction-state";
import {
  __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest, __disposeWorkspaceSessionSyncForTest,
  acknowledgeInteraction, ensureWorkspaceSessionSync, trackWorkspaceSessionSync, seedHostApprovalState,
} from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { chatPanelTab, usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { upsertRuntimeSession } from "../src/react-app/shell/route-workspaces";

const workspaceId = "subagent-tests";
const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1", legalworkToken: "fixture" };
const queryClient = getReactQueryClient();
const permission = (id = "approval", sessionID = "child"): PermissionRequest => ({
  id, sessionID, action: "bash", resources: ["echo example"], metadata: {}, save: [],
});
const v2Permission = (id = "approval-v2", sessionID = "child"): PermissionV2Request => ({
  id, sessionID, action: "file.read", resources: ["/outside/example.txt"], metadata: {}, save: [],
});
const question = (id = "question", sessionID = "child"): QuestionRequest => ({
  id, sessionID, title: "Choice", fields: [{key:"choice",type:"string",title:"Continue?",options:[{value:"Yes",label:"Yes",description:"Continue"}]}],
});
const nativeSession = (id: string, parentID?: string): SessionInfo => ({
  id, parentID, title: `Chat ${id}`, projectID: "project", location:{directory:"/fixture"},
  time: { created: 1, updated: 2 },cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},
});
const session = (id:string,parentID?:string)=>projectSession(nativeSession(id,parentID));
const pendingPermissions = (id = "child") => queryClient.getQueryData<PendingPermission[]>(permissionKey(workspaceId, id)) ?? [];
const pendingQuestions = (id = "child") => queryClient.getQueryData<PendingQuestion[]>(questionKey(workspaceId, id)) ?? [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  queryClient.clear();
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
});

function testSync() {
  const {client}=testClient();
  cleanups.push(__createWorkspaceSessionSyncForTest(syncInput,client));
  cleanups.push(trackWorkspaceSessionSync(syncInput, "parent"));
  return (type: string, data: unknown) => __applySessionSyncEventForTest(syncInput, { type, data });
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
      if (path.startsWith("/api/session/")) {
        const id = path.slice("/api/session/".length);
        return Response.json({data:nativeSession(id,id === "child" ? "parent" : id === "grandchild" ? "child":undefined)});
      }
      if(path === "/api/permission/request" || path === "/api/form") return Response.json({data:[]});
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { client: createClient(server.url.toString().replace(/\/$/, "")), calls, server };
}

describe("subagent request scope", () => {
  test("keeps native permissions and forms from unopened children", () => {
    const emit = testSync();
    emit("permission.asked", permission());
    emit("permission.asked", v2Permission());
    emit("form.created", {form:question()});
    emit("form.created", {form:question("question-v2")});
    expect(pendingPermissions().map((item) => item.protocol)).toEqual(["v2", "v2"]);
    expect(pendingQuestions().map((item) => item.protocol)).toEqual(["v2", "v2"]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
  });

  test("discovers descendants live, forwards new-child metadata, and isolates unrelated chats", async () => {
    const emit = testSync();
    const updates: string[] = [];
    cleanups.push(ensureWorkspaceSessionSync({ ...syncInput, onSessionUpdated: (update) => updates.push(update.sessionId) }));
    for (const info of [session("parent"), session("child", "parent"), session("grandchild", "child"), session("other")]) {
      emit("session.created", {sessionID:info.id});
    }
    await waitUntil(()=>Boolean(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.grandchild));
    const sessions = queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))!;
    expect(interactionSessionIds("parent", sessions)).toEqual(["parent", "child", "grandchild"]);
    expect(interactionSessionIds("child", sessions)).toEqual(["child", "grandchild"]);
    expect(interactionSessionIds("other", sessions)).toEqual(["other"]);
    expect(new Set(updates)).toEqual(new Set(["parent", "child", "grandchild", "other"]));
    expect(queryClient.getQueryData(interactionSessionsKey("another-workspace"))).toBeUndefined();
  });

  test("stores an early approval until the child creation event establishes its ancestry", async () => {
    const emit = testSync();
    emit("permission.asked", permission());
    expect(pendingPermissions()).toHaveLength(1);
    expect(interactionSessionIds("parent", {})).toEqual(["parent"]);
    emit("session.created", {sessionID:"child"});
    await waitUntil(()=>Boolean(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.child));
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
    emit("permission.asked", v2Permission());
    emit("permission.replied", { sessionID: "child", requestID: "approval-v2", reply: "reject" });
    expect(pendingPermissions()).toEqual([]);
    expect(pendingPermissions("parent")).toHaveLength(1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("idle");
    emit("form.created", {form:question()});
    emit("form.cancelled", { sessionID: "child", id: "question" });
    expect(pendingQuestions()).toEqual([]);
  });

  test("deleting a child removes its nested requests and keeps unrelated approvals", async () => {
    const emit = testSync();
    const previousPanels = usePanelTabStore.getState().sessions;
    cleanups.push(() => usePanelTabStore.setState({ sessions: previousPanels }));
    const scope = `workspace:${workspaceId}`;
    for (const id of ["child", "grandchild", "other"]) {
      usePanelTabStore.getState().openTab(scope, chatPanelTab(id, id));
    }
    usePanelTabStore.getState().openTab(scope, {
      id: "contract", type: "artifact", label: "Contract", value: "contract.docx", preview: "word",
    });
    emit("session.created", {sessionID:"child"});
    emit("session.created", {sessionID:"grandchild"});
    emit("permission.asked", permission());
    emit("form.created", {form:question("nested-question", "grandchild")});
    emit("permission.asked", permission("other-approval", "other"));
    await waitUntil(()=>Boolean(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.grandchild));
    emit("session.deleted", {sessionID:"child"});
    emit("permission.asked", permission("late"));
    emit("session.renamed", {sessionID:"child",title:"Late rename"});
    expect(pendingPermissions()).toEqual([]);
    expect(pendingQuestions("grandchild")).toEqual([]);
    expect(pendingPermissions("other")).toHaveLength(1);
    expect(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.child).toBeUndefined();
    expect(usePanelTabStore.getState().sessions[scope]?.tabs.map((tab) => tab.id)).toEqual(["chat:other", "contract"]);
  });

  test("review worker creation and updates never enter the chat navigation list", () => {
    const visible = [session("parent")];
    const worker = { ...session("review"), title: "Review: Governing law", metadata: { legalworkReviewWorker: true } };
    expect(upsertRuntimeSession(visible, { sessionId: worker.id, info: worker })).toBe(visible);
    expect(upsertRuntimeSession(visible, { sessionId: worker.id, info: { ...worker, title: "Renamed result" } })).toBe(visible);
    const ordinary = { ...session("ordinary"), title: worker.title };
    expect(upsertRuntimeSession(visible, { sessionId: ordinary.id, info: ordinary }).map(item => item.id)).toEqual(["parent", "ordinary"]);
  });

  test("new child sessions enter runtime navigation data immediately and subsequent updates replace them", () => {
    const child = session("child", "parent");
    const list = upsertRuntimeSession([session("parent")], { sessionId: child.id, info: child });
    expect(list.map((item) => item.id)).toEqual(["parent", "child"]);
    expect(upsertRuntimeSession(list, { sessionId: child.id, info: { title: "Renamed" } })[1]?.title).toBe("Renamed");
    expect(upsertRuntimeSession(list, { sessionId: "unknown", info: { title: "Partial" } })).toBe(list);
  });
});

describe("recovery and reply routing", () => {
  test("sandbox child requests survive engine recovery and reply with their host authority and owning chat", async () => {
    const { client, calls, server } = testClient();
    const hostClient = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture", hostToken: "host-fixture" });
    seedPermissionState(workspaceId, "parent", [permission("parent-request", "parent")]);
    seedHostApprovalState(workspaceId, [{ id: "sandbox-request", workspaceId, sessionID: "child",
      action: "sandbox.webfetch", paths: [], summary: "Read a public source", createdAt: 1, actor: { type: "host" } }]);
    await refreshWorkspaceInteractions({ client, workspaceId, snapshot: createInteractionSnapshot(), isCurrent: () => true, onSessionUpdated: () => {} });
    const request = pendingPermissions()[0]!;
    expect(request.protocol).toBe("host");
    await expect(replyToPermission(client, request, "once", "/fixture")).rejects.toThrow();
    await expect(replyToPermission(client, request, "always", "/fixture", hostClient)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await replyToPermission(client, request, "once", "/fixture", hostClient);
    expect(calls).toEqual([{ path: "/approvals/sandbox-request", body: { reply: "allow", workspaceId, sessionID: "child" } }]);
    acknowledgeInteraction(workspaceId, "child", request.id, "permission");
    expect(pendingPermissions()).toEqual([]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("idle");
  });

  test("a sandbox request resolves an unopened child's parent for the existing chat queue", async () => {
    const { server } = testClient((request) => {
      if (new URL(request.url).pathname !== "/api/event") return;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      } }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const input = { workspaceId, baseUrl: server.url.origin, legalworkToken: "fixture" };
    cleanups.push(() => __disposeWorkspaceSessionSyncForTest(input));
    ensureWorkspaceSessionSync(input);
    seedHostApprovalState(workspaceId, [{ id: "sandbox-child", workspaceId, sessionID: "child", action: "sandbox.webfetch",
      paths: [], summary: "Read a public source", createdAt: 1, actor: { type: "host" } }]);
    await waitUntil(() => Boolean(queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))?.parent));
    expect(interactionSessionIds("parent", queryClient.getQueryData<InteractionSessions>(interactionSessionsKey(workspaceId))!)).toEqual(["parent", "child"]);
    expect(pendingPermissions().map((item) => item.id)).toEqual(["host:sandbox-child"]);
  });

  test("recovers unopened child approvals and questions and resolves missing ancestors", async () => {
    const { client } = testClient((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/permission/request") return Response.json({data:[permission()]});
      if (path === "/api/form") return Response.json({ data: [question()], location: {} });
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

  test("a failed permission refresh preserves pending native requests while forms refresh", async () => {
    seedPermissionState(workspaceId, "child", [permission("stale"), v2Permission()]);
    const { client } = testClient((request) => {
      if (new URL(request.url).pathname === "/api/permission/request") return new Response(null, { status: 503 });
    });
    await refreshWorkspaceInteractions({ client, workspaceId, snapshot: createInteractionSnapshot(), isCurrent: () => true, onSessionUpdated: () => {} });
    expect(new Set(pendingPermissions().map((item) => item.id))).toEqual(new Set(["stale", "approval-v2"]));
  });

  test("late snapshots cannot restore answered requests or drop newly arrived requests", () => {
    const snapshot = createInteractionSnapshot();
    seedPermissionState(workspaceId, "child", [permission()]);
    acknowledgeInteraction(workspaceId, "child", "approval", "permission");
    snapshot.permissions.set(interactionRequestKey("child", "approval"), false);
    seedPermissionState(workspaceId, "child", [permission("new")]);
    snapshot.permissions.set(interactionRequestKey("child", "new"), true);
    seedPermissionState(workspaceId, "child", [permission()], { snapshot, protocol: "v2" });
    expect(pendingPermissions().map((item) => item.id)).toEqual(["new"]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
    snapshot.questions.set(interactionRequestKey("child", "question"), false);
    seedQuestionState(workspaceId, "child", [question()], { snapshot });
    expect(pendingQuestions()).toEqual([]);
  });

  test("cancelled recovery does not write stale workspace state", async () => {
    const { client } = testClient((request) => {
      if (new URL(request.url).pathname === "/api/permission/request") return Response.json({data:[permission()]});
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
      if (path === "/api/permission/request") return Response.json({data:[permission()]});
      if (path === "/api/session/child") {
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
    finishLookup(Response.json({data:nativeSession("child","parent")}));
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
      if (path === "/api/permission/request") {
        snapshotStarted = true;
        return new Promise<Response>((resolve) => { finishSnapshot = (response) => { snapshotReturned = true; resolve(response); }; });
      }
      if (path !== "/api/event") return;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        emit = (type, properties) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id:"event",created:Date.now(),type,data:properties })}\n\n`));
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
    finishSnapshot(Response.json({data:[permission("answered"), permission("snapshot-only")]}));
    await waitUntil(() => snapshotReturned && pendingPermissions().some((item) => item.id === "snapshot-only"));
    expect(new Set(pendingPermissions().map((item) => item.id))).toEqual(new Set(["live", "snapshot-only"]));
    expect(useSessionActivityStore.getState().getStatus(workspaceId, "child")).toBe("waiting");
  });

  test("child permission and form responses reach their owning native endpoints", async () => {
    seedPermissionState(workspaceId, "child", [permission(), v2Permission()]);
    seedQuestionState(workspaceId, "child", [question()], { protocol: "v2" });
    const { client, calls } = testClient();
    await replyToPermission(client, pendingPermissions().find((item) => item.id === "approval")!, "once", "/fixture");
    await replyToPermission(client, pendingPermissions().find((item) => item.id === "approval-v2")!, "reject", "/fixture");
    await replyToQuestion(client, pendingQuestions()[0]!, [["Yes"]], "/fixture");
    expect(calls).toEqual([
      { path: "/api/session/child/permission/approval/reply", body: { decision: "once" } },
      { path: "/api/session/child/permission/approval-v2/reply", body: { decision: "reject" } },
      { path: "/api/session/child/form/question/reply", body: { answer:{choice:"Yes"} } },
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
      if (path === "/api/permission/request") return Response.json({data:[permission(connections > 1 ? "after-reconnect" : "initial")]});
      if (path !== "/api/event") return;
      connections++;
      if (connections === 1) return new Response('data: {"type":"server.connected","data":{}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
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
