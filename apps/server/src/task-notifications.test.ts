import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { arrivalNotification, runTaskReminders } from "./task-notifications.js";
import { localDayKey, TaskStore, taskAudience, taskStore, type RemoteTask, type TaskActor } from "./task-store.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function makeStore(): Promise<{ store: TaskStore; notes: () => Array<{ kind: string; task_id: string }> }> {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-task-notifications-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.sqlite");
  const store = await TaskStore.open(path, join(dir, "task-attachments"));
  const db = new Database(path);
  cleanups.push(() => db.close());
  const notes = () =>
    db.query("SELECT kind, task_id FROM task_notifications ORDER BY kind, task_id").all() as Array<{ kind: string; task_id: string }>;
  return { store, notes };
}

const ORG = "org_kanzlei";
const ADA: TaskActor = { userId: "user_ada", name: "Ada", email: "ada@kanzlei.test" };
const VIEWER = { userId: "user_ada", orgId: ORG };

/** A moment on a local calendar day of September 2026 (later days roll into October). */
const at = (day: number, hour = 9) => new Date(2026, 8, day, hour).getTime();
/** A date-only due date as the app stores it: local midnight. */
const dueOn = (day: number) => new Date(2026, 8, day).toISOString();

function remoteTask(overrides: Partial<RemoteTask> & { id: string }): RemoteTask {
  return {
    origin: "intake",
    title: "Frist Meier",
    description: "",
    status: "open",
    priority: 2,
    tags: [],
    dueDate: null,
    assigneeUserId: null,
    assigneeName: null,
    createdByUserId: null,
    endpointId: null,
    endpointName: null,
    submissionId: null,
    assignmentNote: null,
    workflowHubItemId: null,
    workflowVersion: null,
    cloudRunId: null,
    lastLocalRunAt: null,
    attachments: [],
    notes: [],
    submission: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("task notifications: due days", () => {
  test("a task is noted on its due day and once it is overdue, and each note is handed out once", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Klage einreichen", dueDate: dueOn(17) }, ADA, at(15));

    expect(store.recordDueNotifications(at(16))).toBe(0);
    expect(store.claimNotifications(VIEWER, at(16))).toEqual([]);

    expect(store.recordDueNotifications(at(17, 8))).toBe(1);
    expect(store.recordDueNotifications(at(17, 12))).toBe(0);
    expect(store.claimNotifications(VIEWER, at(17, 12))).toEqual([
      {
        id: expect.any(String),
        kind: "due_today",
        taskId: task.id,
        title: "Klage einreichen",
        origin: "desktop",
        dueDate: dueOn(17),
        audience: "mine",
        createdAt: new Date(at(17, 8)).toISOString(),
      },
    ]);
    expect(store.claimNotifications(VIEWER, at(17, 13))).toEqual([]);

    expect(store.recordDueNotifications(at(18))).toBe(1);
    expect(store.recordDueNotifications(at(19))).toBe(0);
    expect(store.claimNotifications(VIEWER, at(19)).map((note) => note.kind)).toEqual(["overdue"]);
  });

  test("a due day set, or a task reopened or restored, here is not announced; the days after are", async () => {
    const { store } = await makeStore();
    store.createTask({ title: "Heute", dueDate: dueOn(16) }, ADA, at(16));
    const later = store.createTask({ title: "Später" }, ADA, at(16));
    store.patchTask(later.id, { dueDate: dueOn(16) }, ADA, at(16, 10));
    const closed = store.createTask({ title: "Erledigt", dueDate: dueOn(20) }, ADA, at(10));
    store.patchTask(closed.id, { status: "done" }, ADA, at(11));

    expect(store.recordDueNotifications(at(16, 11))).toBe(0);
    expect(store.claimNotifications(VIEWER, at(16, 11))).toEqual([]);

    // Reopened the day after it was due: whoever reopened it knows.
    store.patchTask(closed.id, { status: "open" }, ADA, at(21));
    expect(store.recordDueNotifications(at(21, 10))).toBe(2);
    expect(
      store
        .claimNotifications(VIEWER, at(21, 10))
        .map((note) => `${note.title}: ${note.kind}`)
        .sort(),
    ).toEqual(["Heute: overdue", "Später: overdue"]);

    const trashed = store.createTask({ title: "Papierkorb", dueDate: dueOn(22) }, ADA, at(21));
    store.deleteTask(trashed.id, at(21));
    store.restoreTask(trashed.id, at(23));
    expect(store.recordDueNotifications(at(23, 10))).toBe(0);
  });

  test("a note still waiting is settled when the task is re-dated to the same day here", async () => {
    const { store } = await makeStore();
    const task = store.createTask({ title: "Wartet", dueDate: dueOn(17) }, ADA, at(15));
    expect(store.recordDueNotifications(at(17))).toBe(1);
    store.patchTask(task.id, { dueDate: dueOn(17) }, ADA, at(17, 10));
    expect(store.claimNotifications(VIEWER, at(17, 11))).toEqual([]);
  });

  test("days are compared on this machine's calendar", () => {
    expect(localDayKey(at(5, 0))).toBe("2026-09-05");
    expect(localDayKey(at(5, 23))).toBe("2026-09-05");
    expect(localDayKey(at(31))).toBe("2026-10-01");
  });
});

describe("task notifications: claiming", () => {
  test("drops what no longer applies, and says whose each task is", async () => {
    const { store } = await makeStore();
    const now = at(16);
    const pull = (id: string, overrides: Partial<RemoteTask> = {}, orgId = ORG) =>
      store.applyRemoteTask(remoteTask({ id, ...overrides }), orgId, now);

    const mine = pull("t-mine", { assigneeUserId: "user_ada", title: "Für Ada" });
    const theirs = pull("t-theirs", { assigneeUserId: "user_bob", title: "Für Bob" });
    const open = pull("t-open", { title: "Offen" });
    const done = pull("t-done");
    const deleted = pull("t-deleted");
    const redated = pull("t-redated", { dueDate: dueOn(16) });
    const reassigned = pull("t-reassigned", { assigneeUserId: "user_ada" });
    const foreign = pull("t-foreign", {}, "org_other");
    for (const task of [theirs, open, done, deleted, foreign]) store.recordNotification(task.id, "new", "", now);
    store.recordNotification(mine.id, "assigned", "2026-09-16T07:00:00.000Z", now);
    store.recordNotification(reassigned.id, "assigned", "2026-09-16T07:00:00.000Z", now);
    store.recordDueNotifications(now, [redated.id]);
    store.recordNotification("t-missing", "new", "", now);

    // Later pulls change what the notes are about.
    pull("t-done", { status: "done" });
    pull("t-deleted", { deletedAt: "2026-09-16T07:30:00.000Z" });
    pull("t-redated", { dueDate: dueOn(18) });
    pull("t-reassigned", { assigneeUserId: "user_bob" });

    const claimed = store.claimNotifications(VIEWER, now);
    expect(claimed.map((note) => [note.taskId, note.kind, note.audience]).sort()).toEqual([
      ["t-mine", "assigned", "mine"],
      ["t-open", "new", "unassigned"],
      ["t-theirs", "new", "others"],
    ]);
    expect(claimed.find((note) => note.taskId === "t-mine")?.title).toBe("Für Ada");
    // Dropped ones are settled too: nothing is left waiting.
    expect(store.claimNotifications(VIEWER, now)).toEqual([]);
  });

  test("whose a task is", () => {
    const task = (overrides: { origin?: "desktop" | "intake"; assigneeUserId?: string | null; createdByUserId?: string | null }) => ({
      origin: overrides.origin ?? "desktop",
      assigneeUserId: overrides.assigneeUserId ?? null,
      createdByUserId: overrides.createdByUserId ?? null,
    });
    expect(taskAudience(task({ assigneeUserId: "user_ada" }), "user_ada")).toBe("mine");
    expect(taskAudience(task({ assigneeUserId: "user_bob" }), "user_ada")).toBe("others");
    expect(taskAudience(task({ createdByUserId: "user_ada" }), "user_ada")).toBe("mine");
    expect(taskAudience(task({ createdByUserId: null }), "user_ada")).toBe("mine");
    expect(taskAudience(task({ createdByUserId: "user_bob" }), "user_ada")).toBe("unassigned");
    expect(taskAudience(task({ origin: "intake" }), "user_ada")).toBe("unassigned");
    // Without a firm, every unassigned task is the user's own.
    expect(taskAudience(task({ origin: "intake" }), null)).toBe("mine");
    expect(taskAudience(task({ assigneeUserId: "user_bob" }), null)).toBe("others");
  });
});

describe("task notifications: keeping", () => {
  test("delivered notes go a month on when they can no longer matter; a reminder's note stays while its task is open", async () => {
    const { store, notes } = await makeStore();
    const open = store.createTask({ title: "Offen", dueDate: dueOn(20) }, ADA, at(10));
    const closed = store.createTask({ title: "Zu", dueDate: dueOn(20) }, ADA, at(10));
    store.recordNotification(open.id, "new", "", at(11));
    store.recordDueNotifications(at(21));
    store.claimNotifications(VIEWER, at(21));
    store.patchTask(closed.id, { status: "done" }, ADA, at(22));

    store.pruneNotifications(at(40));
    expect(notes()).toHaveLength(3);

    store.pruneNotifications(at(52));
    expect(notes()).toEqual([{ kind: "overdue", task_id: open.id }]);
    // So the open task's reminder does not come again.
    expect(store.recordDueNotifications(at(53))).toBe(0);
  });

  test("a task that leaves this machine takes its notes along", async () => {
    const { store, notes } = await makeStore();
    const hidden = store.applyRemoteTask(remoteTask({ id: "t-hidden" }), ORG, at(16));
    const firms = store.applyRemoteTask(remoteTask({ id: "t-firm" }), ORG, at(16));
    const local = store.createTask({ title: "Nur hier" }, ADA, at(16));
    for (const task of [hidden, firms, local]) store.recordNotification(task.id, "new", "", at(16));

    await store.removeTask(hidden.id);
    await store.forgetFirm(ORG, at(17));

    expect(notes()).toEqual([{ kind: "new", task_id: local.id }]);
  });
});

describe("task notifications: the reminder check", () => {
  test("opens nothing where there is no runtime DB, and notes what is due where there is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "legalwork-task-reminders-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const original = process.env.LEGALWORK_RUNTIME_DB;
    cleanups.push(() => {
      if (original === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
      else process.env.LEGALWORK_RUNTIME_DB = original;
    });
    const path = join(dir, "nested", "runtime.sqlite");
    process.env.LEGALWORK_RUNTIME_DB = path;
    const config = { configPath: join(dir, "legalwork.json") } as ServerConfig;
    const state: { prunedDay: string | null } = { prunedDay: null };

    expect(await runTaskReminders(config, state, at(17))).toBe(0);
    expect(existsSync(join(dir, "nested"))).toBe(false);
    expect(state.prunedDay).toBeNull();

    const store = await taskStore(config);
    store.createTask({ title: "Fällig", dueDate: dueOn(17) }, ADA, at(15));
    expect(await runTaskReminders(config, state, at(17))).toBe(1);
    expect(state.prunedDay).toBe("2026-09-17");
    expect(await runTaskReminders(config, state, at(17, 10))).toBe(0);
  });
});

describe("task notifications: arrivals", () => {
  test("what a pulled task means for the member", async () => {
    const { store } = await makeStore();
    const pull = (id: string, overrides: Partial<RemoteTask> = {}) => store.applyRemoteTask(remoteTask({ id, ...overrides }), ORG, at(16));

    expect(arrivalNotification(null, pull("a"), "user_ada")).toBe("new");
    expect(arrivalNotification(null, pull("b", { assigneeUserId: "user_ada" }), "user_ada")).toBe("assigned");
    // Filed by the member elsewhere: not news.
    expect(arrivalNotification(null, pull("c", { createdByUserId: "user_ada", assigneeUserId: "user_ada" }), "user_ada")).toBeNull();
    expect(arrivalNotification(null, pull("d", { status: "done" }), "user_ada")).toBeNull();
    expect(arrivalNotification(null, pull("e", { deletedAt: "2026-09-16T07:00:00.000Z" }), "user_ada")).toBeNull();

    const bobs = pull("f", { assigneeUserId: "user_bob" });
    expect(arrivalNotification(bobs, pull("f", { assigneeUserId: "user_ada" }), "user_ada")).toBe("assigned");
    const adas = pull("g", { assigneeUserId: "user_ada" });
    expect(arrivalNotification(adas, pull("g", { assigneeUserId: "user_ada", title: "Umbenannt" }), "user_ada")).toBeNull();
    const known = pull("h");
    expect(arrivalNotification(known, pull("h", { title: "Geändert" }), "user_ada")).toBeNull();
  });
});
