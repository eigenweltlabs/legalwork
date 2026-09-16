import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import type { IntakeClient, IntakeTask, IntakeTaskPatch, IntakeTaskPullPage } from "./eigenwelt-intake.js";
import { ApiError } from "./errors.js";
import { taskStore, type TaskStore } from "./task-store.js";
import { runTaskSync, signOutOfFirmTasks, type TaskSyncPlatform } from "./task-sync.js";
import type { ServerConfig } from "./types.js";

const ORG = "org_kanzlei";
const ACCOUNT = { userId: "user_ada", userName: "Ada", userEmail: "ada@kanzlei.test", orgId: ORG, orgName: "Kanzlei" };
const ADA = { userId: "user_ada", name: "Ada", email: "ada@kanzlei.test" };

const originalRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const originalPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  process.env.EIGENWELT_PLATFORM_URL = "https://platform.test";
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (originalRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = originalRuntimeDb;
  if (originalPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = originalPlatformUrl;
});

/** A fresh runtime DB per test, holding both the connection and the tasks. */
async function makeConfig(): Promise<{ config: ServerConfig; store: TaskStore }> {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-task-sync-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const config = { configPath: join(dir, "legalwork.json") } as ServerConfig;
  return { config, store: await taskStore(config) };
}

async function connect(config: ServerConfig): Promise<void> {
  await writeEigenweltConnection(config, { platformToken: "tok_test", account: ACCOUNT });
}

type Call = { method: string; taskId?: string; body?: unknown };

function remoteTask(overrides: Partial<IntakeTask> & { id: string }): IntakeTask {
  return {
    origin: "desktop",
    endpointId: null,
    endpointName: null,
    submissionId: null,
    title: "Remote",
    description: "",
    status: "open",
    priority: 2,
    dueDate: null,
    assigneeUserId: null,
    assigneeName: null,
    createdByUserId: "user_ada",
    assignmentNote: null,
    workflowHubItemId: null,
    workflowVersion: null,
    cloudRunId: null,
    lastLocalRunAt: null,
    attachments: [],
    createdAt: "2026-09-16T08:00:00.000Z",
    updatedAt: "2026-09-16T08:00:00.000Z",
    deletedAt: null,
    ...overrides,
    tags: overrides.tags ?? [],
  };
}

/** A platform that records what it was asked and answers from a script. */
function fakePlatform(script: {
  pages?: IntakeTaskPullPage[];
  fail?: Partial<Record<keyof TaskSyncPlatform, unknown>>;
  members?: { userId: string; name: string | null; email: string | null; role: string }[];
} = {}) {
  const calls: Call[] = [];
  const clients: IntakeClient[] = [];
  const pages = [...(script.pages ?? [])];
  const failing = (method: keyof TaskSyncPlatform) => {
    const failure = script.fail?.[method];
    if (failure !== undefined) throw failure;
  };
  const platform: TaskSyncPlatform = {
    createTask: async (client, input) => {
      clients.push(client);
      calls.push({ method: "create", body: input });
      failing("createTask");
      return remoteTask({ id: input.id ?? "server-id", title: input.title, updatedAt: "2026-09-16T09:00:00.000Z" });
    },
    patchTask: async (client, taskId, patch: IntakeTaskPatch) => {
      clients.push(client);
      calls.push({ method: "patch", taskId, body: patch });
      failing("patchTask");
      return remoteTask({ id: taskId, updatedAt: "2026-09-16T09:01:00.000Z" });
    },
    deleteTask: async (_client, taskId) => {
      calls.push({ method: "delete", taskId });
      failing("deleteTask");
      return remoteTask({ id: taskId, deletedAt: "2026-09-16T09:02:00.000Z" });
    },
    restoreTask: async (_client, taskId) => {
      calls.push({ method: "restore", taskId });
      return remoteTask({ id: taskId });
    },
    uploadAttachment: async (_client, taskId, file) => {
      calls.push({ method: "upload", taskId, body: { id: file.id, filename: file.filename, size: file.bytes.byteLength } });
      failing("uploadAttachment");
      return { id: file.id, filename: file.filename, contentType: file.contentType, size: file.bytes.byteLength };
    },
    deleteAttachment: async (_client, taskId, attachmentId) => {
      calls.push({ method: "deleteAttachment", taskId, body: attachmentId });
    },
    pullTasks: async (_client, params) => {
      calls.push({ method: "pull", body: params });
      failing("pullTasks");
      return pages.shift() ?? { tasks: [], nextCursor: null, hidden: [] };
    },
    listMembers: async () => {
      calls.push({ method: "members" });
      return script.members ?? [];
    },
  };
  return { platform, calls, clients };
}

describe("task-sync", () => {
  test("does nothing while no firm is connected, and keeps the outbox", async () => {
    const { config, store } = await makeConfig();
    store.createTask({ title: "Offline" }, ADA);
    const { platform, calls } = fakePlatform();

    const result = await runTaskSync(config, { platform });
    expect(result).toMatchObject({ ran: false, orgId: null, pushed: 0 });
    expect(calls).toEqual([]);
    expect(store.outboxSize()).toBe(1);
  });

  test("pushes the outbox in order with the firm's token, then marks the task synced", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const task = store.createTask({ title: "Vollmacht", priority: 1 }, ADA, Date.parse("2026-09-16T07:00:00.000Z"));
    store.patchTask(task.id, { status: "in_progress", note: "Angerufen." }, ADA, Date.parse("2026-09-16T07:30:00.000Z"));
    await store.addAttachment(task.id, { filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1, 2]) }, { id: "11111111-1111-4111-8111-111111111111" });
    const { platform, calls, clients } = fakePlatform();

    const result = await runTaskSync(config, { platform });

    expect(result).toMatchObject({ ran: true, orgId: ORG, pushed: 4, failed: 0, error: null });
    expect(calls.map((call) => call.method)).toEqual(["create", "patch", "patch", "upload", "pull", "members"]);
    expect(calls[0]!.body).toMatchObject({
      id: task.id,
      title: "Vollmacht",
      priority: 1,
      createdAt: "2026-09-16T07:00:00.000Z",
    });
    expect(calls[1]!.body).toEqual({ status: "in_progress", changedAt: "2026-09-16T07:30:00.000Z" });
    expect(calls[2]!.body).toMatchObject({ note: "Angerufen.", noteSource: "member", noteCreatedAt: "2026-09-16T07:30:00.000Z" });
    expect(calls[3]!.body).toEqual({ id: "11111111-1111-4111-8111-111111111111", filename: "a.txt", size: 2 });
    expect(clients.every((client) => client.platformToken === "tok_test")).toBe(true);

    expect(store.outboxSize()).toBe(0);
    expect(store.getTask(task.id)?.sync).toMatchObject({ orgId: ORG, pending: false, error: null });
    expect(store.getSyncState(ORG).lastPushAt).not.toBeNull();
  });

  test("takes the platform's tasks with history and message, and forgets the hidden ones", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const gone = store.createTask({ title: "Weg" }, ADA);
    store.discardOutbox(gone.id);
    store.markSynced(gone.id, ORG, null);
    const { platform, calls } = fakePlatform({
      pages: [
        {
          tasks: [
            {
              ...remoteTask({ id: "22222222-2222-4222-8222-222222222222", origin: "intake", endpointId: "ep-1", endpointName: "Posteingang", title: "Frist", updatedAt: "2026-09-16T10:00:00.000Z" }),
              notes: [{ id: "n1", body: "Gelesen.", source: "member", authorUserId: "user_bob", authorName: "Bob", authorEmail: null, createdAt: "2026-09-16T09:30:00.000Z" }],
              submission: { rawPayload: { subject: "WG: Frist" } },
            },
          ],
          nextCursor: "page-2",
          hidden: [gone.id],
        },
        {
          tasks: [{ ...remoteTask({ id: "33333333-3333-4333-8333-333333333333", title: "Zweite Seite", updatedAt: "2026-09-16T10:05:00.000Z" }), notes: [], submission: null }],
          nextCursor: null,
          hidden: [],
        },
      ],
      members: [{ userId: "user_bob", name: "Bob", email: "bob@kanzlei.test", role: "org:member" }],
    });

    const result = await runTaskSync(config, { platform });

    expect(result).toMatchObject({ pulled: 2, hidden: 1, error: null });
    expect(store.getTask(gone.id)).toBeNull();
    const frist = store.getTask("22222222-2222-4222-8222-222222222222");
    expect(frist).toMatchObject({ origin: "intake", endpointName: "Posteingang", sync: { orgId: ORG, pending: false } });
    expect(store.listNotes(frist!.id).map((note) => note.body)).toEqual(["Gelesen."]);
    expect(store.getSubmission(frist!.id)).toEqual({ rawPayload: { subject: "WG: Frist" } });
    expect(store.listTasks({}, ORG).tasks).toHaveLength(2);
    expect(store.listMembers(ORG).map((member) => member.name)).toEqual(["Bob"]);

    // The second page was asked for with the platform's cursor, and the next
    // round starts just before the newest change seen.
    const pulls = calls.filter((call) => call.method === "pull");
    expect(pulls).toHaveLength(2);
    expect(pulls[0]!.body).toMatchObject({ deleted: "include", include: ["notes", "submission"], sort: "updated", order: "asc" });
    expect(pulls[1]!.body).toMatchObject({ cursor: "page-2" });
    expect(store.getSyncState(ORG).pullCursor).toBe("2026-09-16T10:04:59.999Z");

    const again = fakePlatform();
    await runTaskSync(config, { platform: again.platform });
    expect(again.calls.find((call) => call.method === "pull")?.body).toMatchObject({ updatedSince: "2026-09-16T10:04:59.999Z" });
  });

  test("keeps an op for retry when the platform is down, and stops the round", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const task = store.createTask({ title: "Später" }, ADA);
    const { platform, calls } = fakePlatform({ fail: { createTask: new ApiError(502, "intake_unreachable", "down") } });

    const result = await runTaskSync(config, { platform });

    expect(result).toMatchObject({ ran: true, pushed: 0, failed: 1, error: "down" });
    expect(calls.map((call) => call.method)).toEqual(["create"]);
    expect(store.outboxSize()).toBe(1);
    expect(store.getTask(task.id)?.sync).toMatchObject({ orgId: null, pending: true, error: "down" });
    expect(store.getSyncState(ORG).lastError).toBe("down");
  });

  test("drops a write the platform refused, but keeps the task's later ones going", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const task = store.createTask({ title: "Ok" }, ADA);
    store.discardOutbox(task.id);
    store.markSynced(task.id, ORG, null);
    store.patchTask(task.id, { assigneeUserId: "user_stranger" }, ADA);
    store.patchTask(task.id, { note: "Trotzdem." }, ADA);
    const { platform } = fakePlatform();
    let first = true;
    const refusing: TaskSyncPlatform = {
      ...platform,
      patchTask: async (client, taskId, patch) => {
        if (first) {
          first = false;
          throw new ApiError(400, "intake_invalid_request", "assignee is not a member of this firm");
        }
        return platform.patchTask(client, taskId, patch);
      },
    };

    const result = await runTaskSync(config, { platform: refusing });

    expect(result).toMatchObject({ pushed: 1, failed: 1, error: null });
    expect(store.outboxSize()).toBe(0);
    expect(store.getTask(task.id)?.sync.error).toBe("assignee is not a member of this firm");
  });

  test("a task the platform no longer shows loses its pending writes", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const task = store.createTask({ title: "Entzogen" }, ADA);
    store.discardOutbox(task.id);
    store.markSynced(task.id, ORG, null);
    store.patchTask(task.id, { status: "done" }, ADA);
    store.patchTask(task.id, { priority: 1 }, ADA);
    const { platform, calls } = fakePlatform({ fail: { patchTask: new ApiError(404, "intake_not_found", "no such task") } });

    await runTaskSync(config, { platform });

    expect(calls.filter((call) => call.method === "patch")).toHaveLength(1);
    expect(store.outboxSize()).toBe(0);
  });

  test("a task synced with another firm is left alone", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const task = store.createTask({ title: "Fremd" }, ADA);
    store.discardOutbox(task.id);
    store.markSynced(task.id, "org_other", null);
    store.patchTask(task.id, { status: "done" }, ADA);
    const { platform, calls } = fakePlatform();

    await runTaskSync(config, { platform });

    expect(calls.map((call) => call.method)).toEqual(["pull", "members"]);
    expect(store.outboxSize()).toBe(1);
  });

  test("concurrent callers share the round in flight", async () => {
    const { config } = await makeConfig();
    await connect(config);
    const { platform, calls } = fakePlatform();
    const [a, b] = await Promise.all([runTaskSync(config, { platform }), runTaskSync(config, { platform })]);
    expect(a).toBe(b);
    expect(calls.filter((call) => call.method === "pull")).toHaveLength(1);
  });
});

describe("task-sync: signing out", () => {
  test("pushes what it can, then removes the firm's tasks and keeps the never-synced one", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const pulled = store.applyRemoteTask(
      { ...remoteTask({ id: "44444444-4444-4444-8444-444444444444", origin: "intake" }), notes: [], submission: null },
      ORG,
    );
    store.patchTask(pulled.id, { status: "done" }, ADA);
    const filed = store.createTask({ title: "Filed here" }, ADA);
    const { platform, calls } = fakePlatform();

    const result = await signOutOfFirmTasks(config, { platform });

    expect(result).toEqual({ ok: true, removed: 2 });
    // The last round went out first: the status change and the filing.
    expect(calls.map((call) => call.method)).toEqual(["patch", "create", "pull", "members"]);
    expect(store.getTask(pulled.id)).toBeNull();
    // Filed here and pushed in that round — synced with the firm, so it went too.
    expect(store.getTask(filed.id)).toBeNull();
    expect(store.outboxSize()).toBe(0);
  });

  test("stops while changes could not be pushed, and signs out on force", async () => {
    const { config, store } = await makeConfig();
    await connect(config);
    const pulled = store.applyRemoteTask(
      { ...remoteTask({ id: "44444444-4444-4444-8444-444444444444" }), notes: [], submission: null },
      ORG,
    );
    store.patchTask(pulled.id, { status: "done" }, ADA);
    const { platform } = fakePlatform({ fail: { patchTask: new ApiError(502, "intake_unreachable", "down") } });

    expect(await signOutOfFirmTasks(config, { platform })).toEqual({ ok: false, pending: 1 });
    expect(store.getTask(pulled.id)).not.toBeNull();

    expect(await signOutOfFirmTasks(config, { platform, force: true })).toEqual({ ok: true, removed: 1 });
    expect(store.getTask(pulled.id)).toBeNull();
    expect(store.outboxSize()).toBe(0);
    // The pane can say a sign-out happened…
    expect(store.signedOutBefore()).toBe(true);
    // …until the next round with a firm, which clears the flag.
    await connect(config);
    await runTaskSync(config, { platform: fakePlatform().platform });
    expect(store.signedOutBefore()).toBe(false);
  });

  test("with no firm connected there is nothing to remove", async () => {
    const { config, store } = await makeConfig();
    store.createTask({ title: "Local" }, ADA);
    const { platform, calls } = fakePlatform();
    expect(await signOutOfFirmTasks(config, { platform })).toEqual({ ok: true, removed: 0 });
    expect(calls).toEqual([]);
    expect(store.listTasks().tasks).toHaveLength(1);
  });
});
