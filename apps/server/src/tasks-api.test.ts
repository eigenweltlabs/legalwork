import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import {
  connectedTaskOrgId,
  parseDueDate,
  parseTaskCreate,
  parseTaskListParams,
  parseTaskPatch,
  parseTaskSessionLink,
  taskActorOf,
} from "./tasks-api.js";

const ACCOUNT = { userId: "user_ada", userName: "Ada", userEmail: "ada@kanzlei.test", orgId: "org_1", orgName: "Kanzlei" };

describe("tasks-api: who is acting", () => {
  test("a signed-in member is the actor and their firm the sync target", () => {
    const connection = {
      entitlements: null,
      account: ACCOUNT,
      platformURL: null,
      platformToken: "tok",
      refreshToken: null,
      platformTokenExpiresAt: null,
    };
    expect(taskActorOf(connection)).toEqual({ userId: "user_ada", name: "Ada", email: "ada@kanzlei.test" });
    expect(connectedTaskOrgId(connection)).toBe("org_1");
  });

  test("signed out: anonymous, and no firm to sync with — even with a remembered account", () => {
    const connection = {
      entitlements: null,
      account: ACCOUNT,
      platformURL: null,
      platformToken: null,
      refreshToken: null,
      platformTokenExpiresAt: null,
    };
    expect(connectedTaskOrgId(connection)).toBeNull();
    expect(taskActorOf({ ...connection, account: null })).toEqual({ userId: null, name: null, email: null });
  });
});

describe("tasks-api: list params", () => {
  test("parses the filters, clamps the page size and refuses nonsense", () => {
    expect(
      parseTaskListParams(new URLSearchParams("assignee=user_1&assignee=user_2&status=done&status=open&endpointId=ep_1&endpointId=ep_2&tag=Project%20Alpha&tag=Urgent&sort=updated&order=desc&limit=10&cursor=c1&deleted=only")),
    ).toEqual({
      assignees: ["user_1", "user_2"],
      statuses: ["done", "open"],
      endpointIds: ["ep_1", "ep_2"],
      tags: ["Project Alpha", "Urgent"],
      sort: "updated",
      order: "desc",
      limit: 10,
      cursor: "c1",
      deleted: "only",
    });
    expect(parseTaskListParams(new URLSearchParams("limit=5000")).limit).toBe(200);
    expect(parseTaskListParams(new URLSearchParams())).toEqual({});
    for (const bad of ["status=archived", "status=open&status=archived", "sort=name", "order=up", "limit=0", "limit=x", "deleted=yes"]) {
      expect(() => parseTaskListParams(new URLSearchParams(bad))).toThrow(ApiError);
    }
  });
});

describe("tasks-api: create and patch bodies", () => {
  test("a create needs only a title; the rest is optional and validated", () => {
    expect(parseTaskCreate({ title: " Neu ", priority: 1, assigneeUserId: null })).toEqual({
      title: "Neu",
      priority: 1,
      assigneeUserId: null,
    });
    expect(parseTaskCreate({ title: "Neu", id: "11111111-1111-4111-8111-111111111111" }).id).toBe("11111111-1111-4111-8111-111111111111");
    expect(() => parseTaskCreate({})).toThrow(ApiError);
    expect(() => parseTaskCreate({ title: "Neu", id: "not-a-uuid" })).toThrow(ApiError);
    // The filing session is kept with the workspace the request came through.
    expect(parseTaskCreate({ title: "Neu", sessionId: " ses_1 " }, "ws-1").createdInSession).toEqual({ sessionId: "ses_1", workspaceId: "ws-1" });
    expect(parseTaskCreate({ title: "Neu", sessionId: "ses_1" }).createdInSession).toBeUndefined();
    expect(() => parseTaskCreate({ title: "Neu", sessionId: "" }, "ws-1")).toThrow(ApiError);
    expect(() => parseTaskCreate({ title: "Neu", priority: 9 })).toThrow(ApiError);
    expect(() => parseTaskCreate({ title: "Neu", description: 1 })).toThrow(ApiError);
    expect(parseTaskCreate({ title: "Neu", tags: [" Project ", "project"] }).tags).toEqual(["Project"]);
  });

  test("a session started from a task names the session, its folder and how it was started", () => {
    expect(parseTaskSessionLink({ sessionId: " ses_2 ", workspaceId: "ws-2", kind: "workflow", workflowName: " Akte anlegen " })).toEqual({
      sessionId: "ses_2",
      workspaceId: "ws-2",
      kind: "workflow",
      workflowName: "Akte anlegen",
    });
    expect(parseTaskSessionLink({ sessionId: "ses_3", workspaceId: "ws-2", kind: "session" })).toEqual({
      sessionId: "ses_3",
      workspaceId: "ws-2",
      kind: "session",
      workflowName: null,
    });
    expect(() => parseTaskSessionLink({ sessionId: "", workspaceId: "ws-2", kind: "session" })).toThrow(ApiError);
    expect(() => parseTaskSessionLink({ sessionId: "ses_3", workspaceId: "", kind: "session" })).toThrow(ApiError);
    // Only the app can start a run or a session; the filing kind is the create route's.
    expect(() => parseTaskSessionLink({ sessionId: "ses_3", workspaceId: "ws-2", kind: "created" })).toThrow(ApiError);
    expect(() => parseTaskSessionLink({ sessionId: "ses_3", workspaceId: "ws-2", kind: "workflow", workflowName: 1 })).toThrow(ApiError);
  });

  test("a patch applies only the keys sent, trims the title and refuses an empty one", () => {
    expect(parseTaskPatch({ title: " Umbenannt ", status: "done", priority: 3, assigneeUserId: "  " })).toEqual({
      title: "Umbenannt",
      status: "done",
      priority: 3,
      assigneeUserId: null,
    });
    expect(parseTaskPatch({ lastLocalRunAt: null })).toEqual({ lastLocalRunAt: null });
    expect(parseTaskPatch({ lastLocalRunAt: "2026-09-16T10:00:00Z" })).toEqual({ lastLocalRunAt: "2026-09-16T10:00:00.000Z" });
    expect(() => parseTaskPatch({})).toThrow(ApiError);
    expect(() => parseTaskPatch({ title: "   " })).toThrow(ApiError);
    expect(() => parseTaskPatch({ status: "archived" })).toThrow(ApiError);
    expect(() => parseTaskPatch({ lastLocalRunAt: "yesterday" })).toThrow(ApiError);
  });

  test("a note is trimmed, capped and carries its source only alongside it", () => {
    expect(parseTaskPatch({ note: "  Entwurf erstellt.  ", noteSource: "agent" })).toEqual({
      note: "Entwurf erstellt.",
      noteSource: "agent",
    });
    expect(parseTaskPatch({ status: "done", noteSource: "agent" })).toEqual({ status: "done" });
    expect(() => parseTaskPatch({ note: "   " })).toThrow(ApiError);
    expect(() => parseTaskPatch({ note: "x".repeat(4_001) })).toThrow(ApiError);
    expect(() => parseTaskPatch({ note: "ok", noteSource: "system" })).toThrow(ApiError);
  });

  test("a due date is a calendar day at local midnight, a timestamp, or null", () => {
    const day = parseDueDate("2026-09-18");
    expect(day).toBe(new Date(2026, 8, 18).toISOString());
    expect(parseDueDate("2026-09-18T09:30:00Z")).toBe("2026-09-18T09:30:00.000Z");
    expect(parseDueDate(null)).toBeNull();
    expect(() => parseDueDate("2026-02-30")).toThrow(ApiError);
    expect(() => parseDueDate("next week")).toThrow(ApiError);
    expect(() => parseDueDate(5)).toThrow(ApiError);
    expect(parseTaskPatch({ dueDate: null })).toEqual({ dueDate: null });
  });
});
