import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiError } from "./errors.js";
import { TaskStore, type RemoteTask, type TaskActor } from "./task-store.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeStore(): Promise<{ store: TaskStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-tasks-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = await TaskStore.open(join(dir, "runtime.sqlite"), join(dir, "task-attachments"));
  return { store, dir };
}

const ADA: TaskActor = { userId: "user_ada", name: "Ada", email: "ada@kanzlei.test" };
const ANON: TaskActor = { userId: null, name: null, email: null };

function remoteTask(overrides: Partial<RemoteTask> = {}): RemoteTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    origin: "intake",
    title: "Fristverlängerung Meier",
    description: "Bis Freitag.",
    status: "open",
    priority: 1,
    dueDate: "2026-09-18T22:00:00.000Z",
    assigneeUserId: "user_ada",
    assigneeName: "Ada",
    createdByUserId: null,
    endpointId: "ep-1",
    endpointName: "Posteingang",
    submissionId: "sub-1",
    assignmentNote: "Aktenzeichen passt zu Ada.",
    workflowHubItemId: null,
    workflowVersion: null,
    cloudRunId: null,
    lastLocalRunAt: null,
    attachments: [{ id: "att-1", filename: "Klage.pdf", contentType: "application/pdf", size: 10 }],
    notes: [
      {
        id: "note-1",
        body: "Rückruf erledigt.",
        source: "member",
        authorUserId: "user_bob",
        authorName: "Bob",
        authorEmail: null,
        createdAt: "2026-09-02T09:00:00.000Z",
      },
    ],
    submission: { rawPayload: { subject: "WG: Frist" } },
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("task-store: local tasks", () => {
  test("creates a desktop task, lists it, and records the create for the push", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "  Vollmacht einholen  ", description: "Für Meier." }, ADA, 1_000);

    expect(task.origin).toBe("desktop");
    expect(task.title).toBe("Vollmacht einholen");
    expect(task.status).toBe("open");
    expect(task.priority).toBe(2);
    expect(task.createdByUserId).toBe("user_ada");
    expect(task.createdAt).toBe(new Date(1_000).toISOString());
    expect(task.sync).toEqual({ orgId: null, syncedAt: null, pending: true, error: null });

    expect(store.listTasks().tasks.map((row) => row.id)).toEqual([task.id]);
    expect(store.listOutbox().map((entry) => entry.op.kind)).toEqual(["create"]);
  });

  test("remembers the agent session a task was filed from; a pulled task has none", async () => {
    const { store } = await makeStore();
    const filed = store.createTask({ title: "Vom Agenten", createdInSession: { sessionId: "ses_1", workspaceId: "ws-1" } }, ADA, 1_000);
    const created = { sessionId: "ses_1", workspaceId: "ws-1", kind: "created" as const, workflowName: null, startedAt: "1970-01-01T00:00:01.000Z" };
    expect(filed.createdSession).toEqual(created);
    expect(filed.sessions).toEqual([created]);
    const byHand = store.createTask({ title: "Von Hand" }, ADA);
    expect(byHand.createdSession).toBeNull();
    expect(byHand.sessions).toEqual([]);
    expect(store.applyRemoteTask(remoteTask(), "org_a").createdSession).toBeNull();
    // A pull of the filed task keeps the link: the platform never knew it.
    store.discardOutbox(filed.id);
    expect(store.applyRemoteTask(remoteTask({ id: filed.id, origin: "desktop" }), "org_a").createdSession).toEqual(created);
    // …and so does a sign-out: the link names only ids, so it stays behind
    // and is back when the task is pulled again after the next sign-in.
    await store.forgetFirm("org_a");
    expect(store.getTask(filed.id)).toBeNull();
    expect(store.applyRemoteTask(remoteTask({ id: filed.id, origin: "desktop" }), "org_a").createdSession).toEqual(created);
  });

  test("carries the first cut's one-link-per-task table over as filing sessions", async () => {
    const { store, dir } = await makeStore();
    const task = store.createTask({ title: "Vom Agenten" }, ADA, 1_000);
    const raw = new Database(join(dir, "runtime.sqlite"));
    raw.exec("CREATE TABLE task_session_links (task_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL)");
    raw.run("INSERT INTO task_session_links VALUES (?, ?, ?)", [task.id, "ses_old", "ws-1"]);
    raw.close();
    const reopened = await TaskStore.open(join(dir, "runtime.sqlite"), join(dir, "task-attachments"));
    expect(reopened.getTask(task.id)?.sessions).toEqual([
      { sessionId: "ses_old", workspaceId: "ws-1", kind: "created", workflowName: null, startedAt: "1970-01-01T00:00:01.000Z" },
    ]);
    const check = new Database(join(dir, "runtime.sqlite"));
    expect(check.query("SELECT name FROM sqlite_master WHERE name = 'task_session_links'").all()).toEqual([]);
    check.close();
  });

  test("ties the sessions started from a task to it, newest first, on this machine only", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Vom Agenten", createdInSession: { sessionId: "ses_1", workspaceId: "ws-1" } }, ADA, 1_000);
    store.recordTaskSession(task.id, { sessionId: "ses_2", workspaceId: "ws-2", kind: "workflow", workflowName: "Akte anlegen" }, 2_000);
    const linked = store.recordTaskSession(task.id, { sessionId: "ses_3", workspaceId: "ws-2", kind: "session" }, 3_000);
    expect(linked.sessions.map((link) => [link.sessionId, link.kind, link.workflowName])).toEqual([
      ["ses_3", "session", null],
      ["ses_2", "workflow", "Akte anlegen"],
      ["ses_1", "created", null],
    ]);
    expect(linked.sessions[0]?.startedAt).toBe("1970-01-01T00:00:03.000Z");
    expect(linked.createdSession?.sessionId).toBe("ses_1");
    // The same session again is the same link, not a second row.
    store.recordTaskSession(task.id, { sessionId: "ses_2", workspaceId: "ws-2", kind: "workflow", workflowName: "Akte anlegen" }, 4_000);
    expect(store.getTask(task.id)?.sessions).toHaveLength(3);
    // Linking is not a change of the task: nothing goes to the platform.
    expect(store.listOutbox().filter((entry) => entry.taskId === task.id)).toHaveLength(1);
    expect(() => store.recordTaskSession("missing", { sessionId: "ses_9", workspaceId: "ws-2", kind: "session" })).toThrow(ApiError);
    // The links outlive a sign-out, like the filing session does.
    store.discardOutbox(task.id);
    store.applyRemoteTask(remoteTask({ id: task.id, origin: "desktop" }), "org_a");
    await store.forgetFirm("org_a");
    expect(store.applyRemoteTask(remoteTask({ id: task.id, origin: "desktop" }), "org_a").sessions).toHaveLength(3);
  });

  test("refuses an empty title and never writes a row for it", async () => {
    const { store } = await makeStore();
    expect(() => store.createTask({ title: "   " }, ANON)).toThrow(ApiError);
    expect(store.listTasks().tasks).toHaveLength(0);
    expect(store.outboxSize()).toBe(0);
  });

  test("a retried create with the same id is the same task", async () => {
    const { store } = await makeStore();
    const first = store.createTask({ id: "same-id", title: "Once" }, ANON, 1_000);
    const second = store.createTask({ id: "same-id", title: "Twice" }, ANON, 2_000);
    expect(second).toEqual(first);
    expect(store.outboxSize()).toBe(1);
  });

  test("patches only the fields sent and queues exactly those", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Akte anlegen" }, ADA, 1_000);
    const updated = store.patchTask(task.id, { status: "in_progress", priority: 1, dueDate: "2026-09-20T22:00:00.000Z" }, ADA, 2_000);

    expect(updated.status).toBe("in_progress");
    expect(updated.priority).toBe(1);
    expect(updated.dueDate).toBe("2026-09-20T22:00:00.000Z");
    expect(updated.title).toBe("Akte anlegen");
    expect(updated.updatedAt).toBe(new Date(2_000).toISOString());

    const ops = store.listOutbox().map((entry) => entry.op);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toEqual({
      kind: "patch",
      fields: { status: "in_progress", priority: 1, dueDate: "2026-09-20T22:00:00.000Z" },
      changedAt: new Date(2_000).toISOString(),
    });
  });

  test("an empty patch is refused", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Akte anlegen" }, ANON);
    expect(() => store.patchTask(task.id, {}, ANON)).toThrow(ApiError);
  });

  test("a note is appended to the history with its author, and is never edited", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Akte anlegen" }, ADA, 1_000);
    store.patchTask(task.id, { note: " Mandant angerufen. " }, ADA, 2_000);
    store.patchTask(task.id, { note: "Entwurf liegt vor.", noteSource: "agent" }, ADA, 3_000);

    const notes = store.listNotes(task.id);
    expect(notes.map((note) => [note.body, note.source, note.authorName])).toEqual([
      ["Mandant angerufen.", "member", "Ada"],
      ["Entwurf liegt vor.", "agent", "Ada"],
    ]);
    expect(store.getTask(task.id)?.updatedAt).toBe(new Date(3_000).toISOString());
    expect(store.listOutbox().map((entry) => entry.op.kind)).toEqual(["create", "note", "note"]);
  });

  test("refuses an empty or oversized note", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Akte anlegen" }, ANON);
    expect(() => store.patchTask(task.id, { note: "  " }, ANON)).toThrow(ApiError);
    expect(() => store.patchTask(task.id, { note: "x".repeat(4_001) }, ANON)).toThrow(ApiError);
    expect(store.listNotes(task.id)).toHaveLength(0);
  });

  test("soft-deletes into the trash and restores from it", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Versehentlich" }, ANON, 1_000);
    const deleted = store.deleteTask(task.id, 2_000);
    expect(deleted.deletedAt).toBe(new Date(2_000).toISOString());

    expect(store.listTasks().tasks).toHaveLength(0);
    expect(store.listTasks({ deleted: "only" }).tasks.map((row) => row.id)).toEqual([task.id]);
    expect(store.listTasks({ deleted: "include" }).tasks).toHaveLength(1);

    const restored = store.restoreTask(task.id, 3_000);
    expect(restored.deletedAt).toBeNull();
    expect(store.listTasks().tasks).toHaveLength(1);
    expect(store.listOutbox().map((entry) => entry.op.kind)).toEqual(["create", "delete", "restore"]);
  });

  test("a missing task is a 404, not a crash", async () => {
    const { store } = await makeStore();
    expect(store.getTask("nope")).toBeNull();
    expect(() => store.patchTask("nope", { status: "done" }, ANON)).toThrow(ApiError);
    expect(() => store.deleteTask("nope")).toThrow(ApiError);
  });
});

describe("task-store: listing", () => {
  test("filters by status and assignee, and sorts priority Urgent first with None last", async () => {
    const { store } = await makeStore();
    const none = store.createTask({ title: "none", priority: 0 }, ANON, 1_000);
    const low = store.createTask({ title: "low", priority: 4, assigneeUserId: "user_bob" }, ANON, 2_000);
    const urgent = store.createTask({ title: "urgent", priority: 1, assigneeUserId: "user_ada" }, ANON, 3_000);
    store.patchTask(low.id, { status: "done" }, ANON, 4_000);

    expect(store.listTasks({ sort: "priority" }).tasks.map((row) => row.title)).toEqual(["urgent", "low", "none"]);
    expect(store.listTasks({ status: "done" }).tasks.map((row) => row.id)).toEqual([low.id]);
    expect(store.listTasks({ assignee: "user_ada" }).tasks.map((row) => row.id)).toEqual([urgent.id]);
    // Newest first by default.
    expect(store.listTasks().tasks.map((row) => row.id)).toEqual([urgent.id, low.id, none.id]);
  });

  test("pages with the cursor without repeating or skipping", async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 5; index += 1) store.createTask({ title: `t${index}` }, ANON, 1_000 + index);

    const first = store.listTasks({ limit: 2 });
    expect(first.tasks.map((row) => row.title)).toEqual(["t4", "t3"]);
    expect(first.nextCursor).toBe(first.tasks[1]!.id);

    const second = store.listTasks({ limit: 2, cursor: first.nextCursor! });
    expect(second.tasks.map((row) => row.title)).toEqual(["t2", "t1"]);

    const third = store.listTasks({ limit: 2, cursor: second.nextCursor! });
    expect(third.tasks.map((row) => row.title)).toEqual(["t0"]);
    expect(third.nextCursor).toBeNull();

    // An unknown cursor is an empty page, not an error.
    expect(store.listTasks({ limit: 2, cursor: "gone" }).tasks).toEqual([]);
  });

  test("shows another firm's intake tasks only while that firm is connected", async () => {
    const { store } = await makeStore();
    store.applyRemoteTask(remoteTask({ id: "a-task" }), "org_a");
    store.applyRemoteTask(remoteTask({ id: "b-task" }), "org_b");
    const local = store.createTask({ title: "mine" }, ANON);

    expect(store.listTasks({}, "org_a").tasks.map((row) => row.id).sort()).toEqual(["a-task", local.id].sort());
    expect(store.listTasks({}, null).tasks).toHaveLength(3);
  });
});

describe("task-store: attachments", () => {
  test("stores the bytes as a file, lists the attachment, and queues the upload", async () => {
    const { store, dir } = await makeStore();
    const task = store.createTask({ title: "Mit Anhang" }, ANON, 1_000);
    const bytes = new TextEncoder().encode("%PDF-1.4 fake");
    const updated = await store.addAttachment(task.id, { filename: "Entwurf.pdf", contentType: "application/pdf", bytes }, { id: "att-local", now: 2_000 });

    expect(updated.attachments).toEqual([
      { id: "att-local", filename: "Entwurf.pdf", contentType: "application/pdf", size: bytes.byteLength, cached: true },
    ]);
    const onDisk = await readFile(join(dir, "task-attachments", task.id, "att-local"));
    expect(new TextDecoder().decode(onDisk)).toBe("%PDF-1.4 fake");
    expect(new TextDecoder().decode((await store.readAttachment(task.id, "att-local"))!)).toBe("%PDF-1.4 fake");
    expect(store.listOutbox().map((entry) => entry.op)).toContainEqual({ kind: "attachment_add", attachmentId: "att-local" });
  });

  test("deleting an attachment that never reached the platform withdraws its upload instead of queueing a delete", async () => {
    const { store, dir } = await makeStore();
    const task = store.createTask({ title: "Mit Anhang" }, ANON);
    await store.addAttachment(task.id, { filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1]) }, { id: "att-1" });
    const after = await store.deleteAttachment(task.id, "att-1");

    expect(after.attachments).toEqual([]);
    expect(store.listOutbox().map((entry) => entry.op.kind)).toEqual(["create"]);
    await expect(stat(join(dir, "task-attachments", task.id, "att-1"))).rejects.toThrow();
  });

  test("deleting a synced attachment queues the delete for the platform", async () => {
    const { store } = await makeStore();
    store.applyRemoteTask(remoteTask(), "org_a");
    await store.deleteAttachment(remoteTask().id, "att-1");
    expect(store.listOutbox().map((entry) => entry.op)).toEqual([{ kind: "attachment_delete", attachmentId: "att-1" }]);
  });

  test("an intake attachment is not cached until its bytes arrive", async () => {
    const { store } = await makeStore();
    const task = store.applyRemoteTask(remoteTask(), "org_a");
    expect(task.attachments[0]!.cached).toBe(false);
    expect(await store.readAttachment(task.id, "att-1")).toBeNull();

    await store.cacheAttachment(task.id, "att-1", new Uint8Array([1, 2, 3]));
    expect(store.getAttachment(task.id, "att-1")).toMatchObject({ cached: true, size: 3 });
    expect(await store.readAttachment(task.id, "att-1")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("task-store: taking the platform's version", () => {
  test("mirrors an intake task with its notes, attachments and submission", async () => {
    const { store } = await makeStore();
    const task = store.applyRemoteTask(remoteTask(), "org_a", 5_000);

    expect(task.origin).toBe("intake");
    expect(task.endpointName).toBe("Posteingang");
    expect(task.assignmentNote).toBe("Aktenzeichen passt zu Ada.");
    expect(task.sync).toEqual({ orgId: "org_a", syncedAt: new Date(5_000).toISOString(), pending: false, error: null });
    expect(store.listNotes(task.id).map((note) => note.id)).toEqual(["note-1"]);
    expect(store.getSubmission(task.id)).toEqual({ rawPayload: { subject: "WG: Frist" } });
    expect(store.listEndpoints()).toEqual([{ id: "ep-1", name: "Posteingang" }]);
    expect(store.outboxSize()).toBe(0);
  });

  test("keeps a field whose local change is still waiting to be pushed, and follows the platform elsewhere", async () => {
    const { store } = await makeStore();
    store.applyRemoteTask(remoteTask(), "org_a");
    store.patchTask(remoteTask().id, { status: "done" }, ADA, 2_000);

    const merged = store.applyRemoteTask(
      remoteTask({ status: "in_progress", priority: 3, title: "Umbenannt", updatedAt: "2026-09-03T09:00:00.000Z" }),
      "org_a",
    );
    expect(merged.status).toBe("done");
    expect(merged.priority).toBe(3);
    expect(merged.title).toBe("Umbenannt");
    expect(merged.sync.pending).toBe(true);
  });

  test("drops an attachment the platform no longer has, but never one still waiting to upload", async () => {
    const { store } = await makeStore();
    const id = remoteTask().id;
    store.applyRemoteTask(remoteTask(), "org_a");
    await store.addAttachment(id, { filename: "neu.txt", contentType: "text/plain", bytes: new Uint8Array([1]) }, { id: "att-new" });

    const merged = store.applyRemoteTask(remoteTask({ attachments: [] }), "org_a");
    expect(merged.attachments.map((attachment) => attachment.id)).toEqual(["att-new"]);
  });

  test("a pending local delete survives the pull; a platform delete lands in the trash", async () => {
    const { store } = await makeStore();
    const id = remoteTask().id;
    store.applyRemoteTask(remoteTask(), "org_a");
    store.deleteTask(id, 2_000);
    expect(store.applyRemoteTask(remoteTask({ updatedAt: "2026-09-03T09:00:00.000Z" }), "org_a").deletedAt).not.toBeNull();

    store.completeOutbox(store.listOutbox()[0]!.seq);
    const remoteDeleted = store.applyRemoteTask(remoteTask({ deletedAt: "2026-09-04T09:00:00.000Z" }), "org_a");
    expect(remoteDeleted.deletedAt).toBe("2026-09-04T09:00:00.000Z");
    expect(store.listTasks().tasks).toHaveLength(0);
  });

  test("removeTask forgets the task, its notes, attachments, files and pending writes", async () => {
    const { store, dir } = await makeStore();
    const id = remoteTask().id;
    store.applyRemoteTask(remoteTask(), "org_a");
    await store.cacheAttachment(id, "att-1", new Uint8Array([1]));
    store.patchTask(id, { status: "done" }, ANON);

    await store.removeTask(id);
    expect(store.getTask(id)).toBeNull();
    expect(store.listNotes(id)).toEqual([]);
    expect(store.outboxSize()).toBe(0);
    await expect(stat(join(dir, "task-attachments", id))).rejects.toThrow();
  });
});

describe("task-store: outbox and sync state", () => {
  test("completes, fails and discards pending writes", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "a" }, ANON);
    store.patchTask(task.id, { status: "done" }, ANON);
    const [create, patch] = store.listOutbox();

    store.failOutbox(create!.seq, "offline");
    expect(store.listOutbox()[0]).toMatchObject({ attempts: 1, lastError: "offline" });
    expect(store.getTask(task.id)?.sync.error).toBe("offline");

    store.completeOutbox(create!.seq);
    expect(store.listOutbox().map((entry) => entry.seq)).toEqual([patch!.seq]);

    store.discardOutbox(task.id);
    expect(store.outboxSize()).toBe(0);
    expect(store.getTask(task.id)?.sync.pending).toBe(false);
  });

  test("markSynced records the firm and clears the error", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "a" }, ANON);
    store.setSyncError(task.id, "boom");
    expect(store.getTask(task.id)?.sync.error).toBe("boom");
    store.markSynced(task.id, "org_a", "2026-09-05T00:00:00.000Z", 9_000);
    store.discardOutbox(task.id);
    expect(store.getTask(task.id)?.sync).toEqual({ orgId: "org_a", syncedAt: new Date(9_000).toISOString(), pending: false, error: null });
  });

  test("keeps a pull cursor per firm", async () => {
    const { store } = await makeStore();
    expect(store.getSyncState("org_a")).toEqual({ orgId: "org_a", pullCursor: null, lastPullAt: null, lastPushAt: null, lastError: null });
    store.setSyncState({ ...store.getSyncState("org_a"), pullCursor: "2026-09-05T00:00:00.000Z", lastPullAt: 1, lastPushAt: 2 });
    expect(store.getSyncState("org_a").pullCursor).toBe("2026-09-05T00:00:00.000Z");
    expect(store.getSyncState("org_b").pullCursor).toBeNull();
  });

  test("the member list names assignees, even ones chosen before it arrived", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "a", assigneeUserId: "user_bob" }, ANON);
    expect(store.getTask(task.id)?.assigneeName).toBeNull();

    store.replaceMembers("org_a", [{ userId: "user_bob", name: "Bob", email: "bob@kanzlei.test", role: "org:member" }]);
    expect(store.getTask(task.id)?.assigneeName).toBe("Bob");
    expect(store.listMembers("org_a")).toHaveLength(1);
    expect(store.listMembers(null)).toEqual([]);

    const reassigned = store.patchTask(task.id, { assigneeUserId: "user_bob" }, ANON);
    expect(reassigned.assigneeName).toBe("Bob");
  });
});

describe("task-store: signing out of a firm", () => {
  test("counts the pending writes that would go to the firm — never another firm's", async () => {
    const { store } = await makeStore();
    const mine = store.createTask({ title: "mine, never synced" }, ANON);
    store.patchTask(mine.id, { status: "done" }, ANON);
    const theirs = store.createTask({ title: "synced elsewhere" }, ANON);
    store.discardOutbox(theirs.id);
    store.markSynced(theirs.id, "org_other", null);
    store.patchTask(theirs.id, { status: "done" }, ANON);
    store.applyRemoteTask(remoteTask(), "org_a");
    store.patchTask(remoteTask().id, { priority: 1 }, ANON);

    expect(store.pendingFor("org_a")).toBe(3);
    expect(store.pendingFor("org_other")).toBe(3);
  });

  test("forgets everything synced with the firm, files included, and keeps what never synced", async () => {
    const { store, dir } = await makeStore();
    const pulled = store.applyRemoteTask(remoteTask(), "org_a");
    await store.cacheAttachment(pulled.id, "att-1", new Uint8Array([1]));
    const pushed = store.createTask({ title: "filed here, pushed" }, ADA);
    store.discardOutbox(pushed.id);
    store.markSynced(pushed.id, "org_a", null);
    store.patchTask(pushed.id, { note: "pending" }, ADA);
    const local = store.createTask({ title: "never synced" }, ADA);
    const other = store.applyRemoteTask(remoteTask({ id: "other-firm" }), "org_b");
    store.replaceMembers("org_a", [{ userId: "user_bob", name: "Bob", email: null, role: "org:member" }]);
    store.setSyncState({ ...store.getSyncState("org_a"), pullCursor: "2026-09-16T00:00:00.000Z", lastPullAt: 1, lastPushAt: 1 });

    expect(await store.forgetFirm("org_a", 9_000)).toEqual({ tasks: 2 });

    expect(store.getTask(pulled.id)).toBeNull();
    expect(store.getTask(pushed.id)).toBeNull();
    expect(store.listNotes(pushed.id)).toEqual([]);
    await expect(stat(join(dir, "task-attachments", pulled.id))).rejects.toThrow();
    expect(store.listTasks({}, null).tasks.map((row) => row.id).sort()).toEqual([local.id, other.id].sort());
    expect(store.outboxSize()).toBe(1); // the local task's own create
    expect(store.listMembers("org_a")).toEqual([]);
    // The cursor is gone (the next sign-in pulls everything again). All that
    // stays is that a sign-out happened — nothing about the firm or the count.
    expect(store.getSyncState("org_a").pullCursor).toBeNull();
    expect(store.signedOutBefore()).toBe(true);
  });

  test("the sign-out flag is set by the wipe and cleared by the next sync", async () => {
    const { store } = await makeStore();
    expect(store.signedOutBefore()).toBe(false);
    await store.forgetFirm("org_a", 5_000);
    expect(store.signedOutBefore()).toBe(true);
    store.clearSignedOut();
    expect(store.signedOutBefore()).toBe(false);
  });
});
