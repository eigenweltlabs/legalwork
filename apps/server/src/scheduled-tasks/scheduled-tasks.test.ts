import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduledTaskInput, TaskSchedule } from "@legalwork/types/scheduled-tasks";
import { nextOccurrence } from "./schedule.js";
import { ScheduledTaskStore } from "./store.js";
import { ScheduledTaskRunner, type ScheduledExecutor } from "./runner.js";

const now = Date.parse("2026-10-06T10:00:00Z");
const schedule: TaskSchedule = { kind: "once", startAt: "2026-10-06T13:00:00", timeZone: "Europe/Berlin" };
const input: ScheduledTaskInput = { title: "Matter brief", prompt: "Summarize open work.", schedule, projectAccess: "project", sessionId: "chat", reuseChat: false, pinSession: true, model: null };
const open = async () => {
  const path = join(await mkdtemp(join(tmpdir(), "scheduled-test-")), "runtime.sqlite");
  return { store: await ScheduledTaskStore.open(path), path };
};
const recurring = (rrule: string, startAt = "2026-10-06T09:00:00"): TaskSchedule => ({ kind: "rrule", rrule, startAt, timeZone: "Europe/Berlin" });

describe("local task recurrence", () => {
  test("one-time wall time and offset are resolved exactly, never early", () => {
    expect(nextOccurrence(schedule, now)).toBe("2026-10-06T11:00:00.000Z");
    expect(nextOccurrence(schedule, Date.parse("2026-10-06T11:00:00Z"))).toBeNull();
    expect(nextOccurrence({ ...schedule, startAt: "2026-10-06T13:00:00+02:00" }, now)).toBe("2026-10-06T11:00:00.000Z");
  });
  test("intervals retain their anchor and coalesce downtime", () => {
    const interval: TaskSchedule = { ...schedule, kind: "interval", minutes: 15 };
    expect(nextOccurrence(interval, Date.parse("2026-10-07T11:09:00Z"))).toBe("2026-10-07T11:15:00.000Z");
  });
  test("daily wall clock stays at 9 through Berlin daylight-saving changes", () => {
    expect(nextOccurrence(recurring("FREQ=DAILY"), Date.parse("2026-10-24T07:00:00Z"))).toBe("2026-10-25T08:00:00.000Z");
    expect(nextOccurrence(recurring("FREQ=DAILY", "2026-03-27T09:00:00"), Date.parse("2026-03-28T08:00:00Z"))).toBe("2026-03-29T07:00:00.000Z");
  });
  test("weekdays, weekly intervals and negative monthly ordinals", () => {
    expect(nextOccurrence(recurring("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), Date.parse("2026-10-09T07:00:00Z"))).toBe("2026-10-12T07:00:00.000Z");
    expect(nextOccurrence(recurring("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR"), now)).toBe("2026-10-09T07:00:00.000Z");
    expect(nextOccurrence(recurring("FREQ=MONTHLY;BYDAY=-1FR"), now)).toBe("2026-10-30T08:00:00.000Z");
    expect(nextOccurrence(recurring("FREQ=MONTHLY;BYMONTHDAY=-1"), now)).toBe("2026-10-31T08:00:00.000Z");
  });
  test("COUNT and UTC UNTIL end a recurrence", () => {
    expect(nextOccurrence(recurring("FREQ=DAILY;COUNT=1"), now)).toBeNull();
    expect(nextOccurrence(recurring("FREQ=DAILY;UNTIL=20261007T070000Z"), now)).toBe("2026-10-07T07:00:00.000Z");
    expect(nextOccurrence(recurring("FREQ=DAILY;UNTIL=20261007T065959Z"), now)).toBeNull();
  });
  test("skips missing and ambiguous recurring wall times", () => {
    expect(nextOccurrence(recurring("FREQ=DAILY", "2026-03-28T02:30:00"), Date.parse("2026-03-28T01:30:00Z"))).toBe("2026-03-30T00:30:00.000Z");
    expect(nextOccurrence(recurring("FREQ=DAILY", "2026-10-24T02:30:00"), Date.parse("2026-10-24T00:30:00Z"))).toBe("2026-10-26T01:30:00.000Z");
    expect(nextOccurrence(recurring("FREQ=DAILY;COUNT=2", "2026-03-28T02:30:00"), Date.parse("2026-03-28T01:30:00Z"))).toBe("2026-03-30T00:30:00.000Z");
    expect(() => nextOccurrence({ ...schedule, startAt: "2026-10-25T02:30:00" }, now)).toThrow("ambiguous");
  });
  test("invalid, impossible and unsupported rules fail promptly", () => {
    for (const rule of ["FREQ=SECONDLY", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;BYHOUR=24", "FREQ=DAILY;BYDAY=XX", "FREQ=DAILY;BOGUS=2", "FREQ=DAILY;COUNT=1;UNTIL=20261007T000000Z", "FREQ=DAILY;UNTIL=20260230T000000Z", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", "FREQ=DAILY;INTERVAL=7;BYDAY=MO"]) {
      expect(() => nextOccurrence(recurring(rule), now)).toThrow();
    }
    expect(() => nextOccurrence({ ...schedule, timeZone: "Berlin" }, now)).toThrow("time zone");
  });
});

describe("persistent scheduled task execution", () => {
  const restartCases: { name: string; schedule: TaskSchedule; reopenedAt: string; nextRunAt: string | null }[] = [
    { name: "one-time task five minutes late", schedule, reopenedAt: "2026-10-06T11:05:00Z", nextRunAt: null },
    { name: "interval task five minutes late", schedule: { ...schedule, kind: "interval", minutes: 15 }, reopenedAt: "2026-10-06T11:05:00Z", nextRunAt: "2026-10-06T11:15:00.000Z" },
    { name: "daily task five minutes late", schedule: recurring("FREQ=DAILY", schedule.startAt), reopenedAt: "2026-10-06T11:05:00Z", nextRunAt: "2026-10-07T11:00:00.000Z" },
    { name: "daily task after several missed days", schedule: recurring("FREQ=DAILY", schedule.startAt), reopenedAt: "2026-10-09T11:05:00Z", nextRunAt: "2026-10-10T11:00:00.000Z" },
    { name: "final calendar occurrence five minutes late", schedule: recurring("FREQ=DAILY;COUNT=1", schedule.startAt), reopenedAt: "2026-10-06T11:05:00Z", nextRunAt: null },
  ];
  test.each(restartCases)("startup catches up $name exactly once", async ({ schedule, reopenedAt, nextRunAt }) => {
    const { store, path } = await open();
    const task = store.create("project", { ...input, schedule, sessionId: null }, now);
    const paused = store.create("project", { ...input, schedule }, now);
    store.update("project", paused.id, paused.revision, { status: "paused" }, now);
    let created = 0, sent = 0;
    const executor: ScheduledExecutor = {
      available: async () => true,
      createSession: async () => `new-${++created}`,
      send: async () => { sent++; },
    };
    // No runner existed while the app was closed. Reopen the persisted database,
    // then use the real startup entry point, without manually polling the runner.
    for (let restart = 0; restart < 2; restart++) {
      const reopened = await ScheduledTaskStore.open(path);
      const runner = new ScheduledTaskRunner(reopened, executor, () => Date.parse(reopenedAt));
      const stop = runner.start();
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sent).toBe(1);
        expect(created).toBe(1);
        expect(reopened.runs(task.id)).toHaveLength(1);
        expect(reopened.runs(task.id)[0]).toMatchObject({ dueAt: task.nextRunAt, startedAt: new Date(reopenedAt).toISOString(), status: "sent", sessionId: "new-1" });
        expect(reopened.get("project", task.id)).toMatchObject({ nextRunAt, status: nextRunAt ? "active" : "completed" });
        expect(reopened.runs(paused.id)).toHaveLength(0);
        expect(reopened.get("project", paused.id).status).toBe("paused");
      } finally { stop(); }
    }
  });
  test("startup keeps an overdue task pending until the engine becomes available", async () => {
    const { store, path } = await open();
    const task = store.create("project", input, now);
    const reopened = await ScheduledTaskStore.open(path);
    let ready = false, sent = 0, time = Date.parse("2026-10-06T11:05:00Z");
    const runner = new ScheduledTaskRunner(reopened, {
      available: async () => { if (!ready) throw new Error("Engine is starting"); return true; },
      createSession: async () => "new",
      send: async () => { sent++; },
    }, () => time);
    const stop = runner.start();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sent).toBe(0);
      expect(reopened.runs(task.id)).toHaveLength(0);
      expect(reopened.get("project", task.id)).toEqual(task);
      ready = true; time += 15000;
      await runner.tick();
      await runner.tick();
      expect(sent).toBe(1);
      expect(reopened.runs(task.id)[0]).toMatchObject({ dueAt: task.nextRunAt, startedAt: "2026-10-06T11:05:15.000Z", status: "sent" });
      expect(reopened.get("project", task.id).status).toBe("completed");
    } finally { stop(); }
  });
  test("persists edits, rejects stale revisions and cross-project access", async () => {
    const { store, path } = await open(), task = store.create("project", input, now);
    store.update("project", task.id, 1, { title: "Updated" }, now);
    const reopened = await ScheduledTaskStore.open(path);
    expect(reopened.get("project", task.id).title).toBe("Updated");
    expect(() => store.update("project", task.id, 1, { title: "Stale" }, now)).toThrow("changed");
    expect(() => store.get("other", task.id)).toThrow("not found");
    expect(() => store.remove("other", task.id, 2)).toThrow("not found");
  });
  test("two connections cannot claim the same due task; restart never replays it", async () => {
    const { store, path } = await open(), other = await ScheduledTaskStore.open(path), task = store.create("project", input, now);
    expect(store.claim(task, now)).toBeNull();
    expect(store.claim(task, now + 3600000)?.dueAt).toBe("2026-10-06T11:00:00.000Z");
    expect(other.claim(task, now + 3600000)).toBeNull();
    expect(other.get("project", task.id).status).toBe("completed");
    expect(other.runs(task.id)[0].status).toBe("dispatching");
  });
  test("pause prevents a pending claim; resume skips missed repeats", async () => {
    const { store } = await open(), task = store.create("project", { ...input, schedule: { ...schedule, kind: "interval", minutes: 60 } }, now);
    const paused = store.update("project", task.id, 1, { status: "paused" }, now);
    expect(store.claim(task, now + 7200000)).toBeNull();
    const resumed = store.update("project", task.id, paused.revision, { status: "active" }, now + 7200000);
    expect(resumed.nextRunAt).toBe("2026-10-06T13:00:00.000Z");
  });
  test("busy chats defer; missed runs coalesce; new chats are created only when due", async () => {
    const { store } = await open(); let busy = true, time = now, created = 0, sent = 0;
    const task = store.create("project", { ...input, sessionId: null, schedule: { ...schedule, kind: "interval", minutes: 15 } }, now);
    const runner = new ScheduledTaskRunner(store, { available: async () => !busy, createSession: async () => `new-${++created}`, send: async () => { sent++; } }, () => time);
    await runner.tick(); expect(created).toBe(0);
    time += 86400000; await runner.tick(); expect(sent).toBe(0);
    busy = false; await Promise.all([runner.tick(), runner.tick()]); expect(sent).toBe(1); expect(created).toBe(1);
    await runner.tick(); expect(sent).toBe(1);
    expect(store.runs(task.id)[0].sessionId).toBe("new-1");
    expect(store.runs(task.id)[0].status).toBe("sent");
  });
  test.each([true, false])("chat reuse=%s survives restart and partial edits", async reuseChat => {
    const { store, path } = await open();
    const task = store.create("project", { ...input, sessionId: null, reuseChat, schedule: { ...schedule, kind: "interval", minutes: 15 } }, now);
    let created = 0;
    const destinations: string[] = [];
    const executor: ScheduledExecutor = { available: async () => true, createSession: async () => `new-${++created}`, send: async (_task, sessionId) => { destinations.push(sessionId); } };
    const runner = new ScheduledTaskRunner(store, executor, () => now + 3600000);
    await runner.tick();
    const current = store.get("project", task.id);
    expect(current.sessionId).toBe(reuseChat ? "new-1" : null);
    // A dialog opened after the claim must not overwrite a newly bound chat.
    if (reuseChat) expect(() => store.update("project", task.id, 2, { title: "Stale" }, now)).toThrow("changed");
    store.update("project", task.id, current.revision, { title: "Updated" }, now);
    const reopened = await ScheduledTaskStore.open(path);
    expect(reopened.get("project", task.id).reuseChat).toBe(reuseChat);
    await new ScheduledTaskRunner(reopened, executor, () => now + 4500000).tick();
    expect(destinations).toEqual(reuseChat ? ["new-1", "new-1"] : ["new-1", "new-2"]);
    expect(created).toBe(reuseChat ? 1 : 2);
    // Switching to a fresh chat every run clears the durable destination.
    const latest = reopened.get("project", task.id);
    reopened.update("project", task.id, latest.revision, { reuseChat: false, sessionId: null }, now);
    await new ScheduledTaskRunner(reopened, executor, () => now + 5400000).tick();
    expect(destinations[2]).toBe(`new-${created}`);
    expect(created).toBe(reuseChat ? 2 : 3);
  });
  test("failure after binding a reusable chat pauses and retains its destination", async () => {
    const { store } = await open();
    const task = store.create("project", { ...input, sessionId: null, reuseChat: true }, now);
    await new ScheduledTaskRunner(store, { available: async () => true, createSession: async () => "first-chat", send: async () => { throw new Error("Offline"); } }, () => now + 3600000).tick();
    expect(store.get("project", task.id)).toMatchObject({ status: "paused", sessionId: "first-chat" });
    expect(store.runs(task.id)[0]).toMatchObject({ status: "failed", sessionId: "first-chat" });
  });
  test("failed delivery pauses without retry; unrelated tasks still run", async () => {
    const { store } = await open(), task = store.create("project", input, now);
    const other = store.create("project", { ...input, sessionId: "other" }, now);
    let sends = 0;
    const executor: ScheduledExecutor = { available: async () => true, createSession: async () => "new", send: async task => { sends++; if (task.sessionId === "chat") throw new Error("Offline during delivery"); } };
    const runner = new ScheduledTaskRunner(store, executor, () => now + 3600000);
    await runner.tick(); await runner.tick();
    expect(sends).toBe(2); expect(store.get("project", task.id).status).toBe("paused");
    expect(store.runs(task.id)[0].error).toBe("Offline during delivery");
    expect(store.runs(other.id)[0].status).toBe("sent");
  });
  test("pausing during chat creation cancels dispatch and preserves the edit", async () => {
    const { store } = await open();
    const task = store.create("project", { ...input, sessionId: null, reuseChat: true }, now); let sent = false;
    const runner = new ScheduledTaskRunner(store, {
      available: async () => true,
      createSession: async () => { store.update("project", task.id, 2, { status: "paused", projectAccess: "all" }, now); return "new"; },
      send: async () => { sent = true; },
    }, () => now + 3600000);
    await runner.tick(); expect(sent).toBe(false);
    expect(store.get("project", task.id).projectAccess).toBe("all");
    expect(store.get("project", task.id).sessionId).toBeNull();
    expect(store.runs(task.id)[0]).toMatchObject({ projectAccess: "project", status: "failed" });
  });
  test("pausing while availability is checked invalidates the snapshot", async () => {
    const { store } = await open(), task = store.create("project", input, now); let sent = false;
    const runner = new ScheduledTaskRunner(store, { available: async () => { store.update("project", task.id, 1, { status: "paused" }, now); return true; }, createSession: async () => "new", send: async () => { sent = true; } }, () => now + 3600000);
    await runner.tick(); expect(sent).toBe(false); expect(store.runs(task.id)).toHaveLength(0);
  });
});

describe("scheduled chat inbox", () => {
  test.each([true, false])("pin=%s records the actual destination and persists after restart and task removal", async pinSession => {
    const { path } = await open();
    let changes = 0;
    const store = await ScheduledTaskStore.open(path, () => { changes++; });
    const task = store.create("project", { ...input, sessionId: null, pinSession }, now);
    const updated = store.update("project", task.id, task.revision, { title: "Updated" }, now);
    expect(updated.pinSession).toBe(pinSession);
    await new ScheduledTaskRunner(store, { available: async () => true, createSession: async () => "actual-destination", send: async () => {} }, () => now + 3600000).tick();
    const [run] = store.runs(task.id);
    expect(changes).toBe(1);
    expect(run.pinSession).toBe(pinSession);
    expect(store.sessionActivity()).toEqual([{ workspaceId: "project", sessionId: "actual-destination", assistantAt: 0, updatedAt: now + 3600000, automation: { runId: run.id, at: now + 3600000, pinRunId: pinSession ? run.id : null } }]);
    const reopened = await ScheduledTaskStore.open(path);
    reopened.remove("project", task.id, reopened.get("project", task.id).revision);
    expect(reopened.sessionActivity()).toEqual(store.sessionActivity());
  });
  test("omitted pin setting defaults on, a disabled later run preserves the last pin marker", async () => {
    const { store } = await open();
    const { pinSession: _pinSession, ...legacy } = input;
    const task = store.create("project", { ...legacy, schedule: { ...schedule, kind: "interval", minutes: 15 } }, now);
    expect(task.pinSession).toBe(true);
    const executor: ScheduledExecutor = { available: async () => true, createSession: async () => "unused", send: async () => {} };
    await new ScheduledTaskRunner(store, executor, () => now + 3600000).tick();
    const first = store.sessionActivity()[0];
    const latest = store.get("project", task.id);
    store.update("project", task.id, latest.revision, { pinSession: false }, now + 3600000);
    await new ScheduledTaskRunner(store, executor, () => now + 4500000).tick();
    expect(store.sessionActivity()[0].automation?.pinRunId).toBe(first.automation?.pinRunId);
    expect(store.sessionActivity()[0].automation?.runId).not.toBe(first.automation?.runId);
  });
  test("failed delivery never adds a pin or announces successful activity", async () => {
    const { path } = await open(); let changes = 0;
    const store = await ScheduledTaskStore.open(path, () => { changes++; });
    store.create("project", input, now);
    await new ScheduledTaskRunner(store, { available: async () => true, createSession: async () => "unused", send: async () => { throw new Error("offline"); } }, () => now + 3600000).tick();
    expect(store.sessionActivity()).toEqual([]);
    expect(changes).toBe(0);
  });
});
