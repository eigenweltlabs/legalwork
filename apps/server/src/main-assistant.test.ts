import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainAssistant, isMainAssistant } from "./main-assistant.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { ScheduledTaskRunner } from "./scheduled-tasks/runner.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "main-assistant-")); roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"), projectsDirectory: join(root, "projects"),
    workspaces: [], authorizedRoots: [], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0,
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const sessions: { id: string; title: string; directory: string; time: { archived?: number } }[] = [];
  let now = new Date(2026, 9, 7, 23, 59);
  const factory = async () => MainAssistant.open(config, join(root, "runtime.sqlite"), workspace => ({
    get: async id => sessions.find(session => session.id === id) ?? null,
    list: async () => sessions,
    create: async title => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const session = { id: `session-${sessions.length}`, title, directory: workspace.path, time: {} };
      sessions.push(session); return session;
    },
  }), () => {}, () => now);
  return { root, config, sessions, factory, assistant: await factory(), setTime: (date: Date) => { now = date; } };
}

test("concurrent callers share one persisted project and one session; midnight and reopen create independent days", async () => {
  const f = await fixture();
  const first = await Promise.all(Array.from({ length: 8 }, () => f.assistant.current()));
  expect(new Set(first.map(value => value.day.sessionId)).size).toBe(1);
  expect(f.config.workspaces).toHaveLength(1);
  expect(isMainAssistant(first[0].workspace)).toBe(true);
  expect(first[0].workspace.path).toBe(join(f.config.projectsDirectory!, "Assistant"));
  expect(JSON.parse(await readFile(f.config.configPath!, "utf8")).workspaces[0].preset).toBe("main-assistant");
  f.setTime(new Date(2026, 9, 8, 0, 0));
  const today = await f.assistant.current();
  expect(today.day.date).toBe("2026-10-08");
  expect(today.day.sessionId).not.toBe(first[0].day.sessionId);
  const reopened = await f.factory();
  expect(await reopened.current()).toEqual(today);
  f.setTime(new Date(2026, 9, 11, 9));
  const afterSleep = await reopened.current();
  expect(afterSleep.day.date).toBe("2026-10-11");
  expect(f.sessions).toHaveLength(3);
  expect(reopened.history(today.workspace.id, afterSleep.day.date, 1)).toEqual({ days: [today.day], nextBefore: "2026-10-08" });
  expect(reopened.history(today.workspace.id, "2026-10-08", 1)).toEqual({ days: [first[0].day], nextBefore: null });
});

test("recovery only adopts a live root session inside the assistant folder", async () => {
  const f = await fixture();
  const workspace = await f.assistant.workspace();
  f.sessions.push({ id: "foreign", title: "2026-10-07", directory: f.root, time: {} });
  f.sessions.push({ id: "archived", title: "2026-10-07", directory: workspace.path, time: { archived: 1 } });
  f.sessions.push({ id: "recovered", title: "2026-10-07", directory: workspace.path, time: {} });
  expect((await f.assistant.current()).day.sessionId).toBe("recovered");
  expect(f.sessions).toHaveLength(3);
  f.config.readOnly = true;
  await expect(f.assistant.current()).rejects.toThrow("writable");
});

test("assistant appearance persists across restart and never changes its project folder or day", async () => {
  const f = await fixture();
  const before = await f.assistant.current();
  expect(f.assistant.profile()).toEqual({ name: null, icon: "cat" });
  await f.assistant.updateProfile({ name: "Momo", icon: "otter" });
  const reopened = await f.factory();
  expect(reopened.profile()).toEqual({ name: "Momo", icon: "otter" });
  expect(await reopened.current()).toEqual(before);
  f.config.readOnly = true;
  await expect(reopened.updateProfile({ name: "Other", icon: "fox" })).rejects.toThrow("writable");
  expect(reopened.profile().name).toBe("Momo");
});

test("the device calendar date handles midnight and daylight-saving days in different zones", async () => {
  // Isolate TZ: changing it in Bun can leave Intl's default zone cached for other tests.
  for (const { zone, expected } of [
    { zone: "Europe/Berlin", expected: ["2026-10-08", "2026-10-25", "2026-10-25"] },
    { zone: "America/Los_Angeles", expected: ["2026-10-07", "2026-10-24", "2026-10-24"] },
  ]) {
    const child = Bun.spawn([process.execPath, "--eval", `import { assistantDate } from ${JSON.stringify(import.meta.dir + "/main-assistant.ts")}; console.log(JSON.stringify(["2026-10-07T22:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"].map(value => assistantDate(new Date(value)))));`], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual(expected);
  }
});

test("assistant schedules resolve the daily chat on each run and never bind yesterday's context", async () => {
  const f = await fixture();
  const first = await f.assistant.current();
  const store = await ScheduledTaskStore.open(join(f.root, "schedules.sqlite"));
  let clock = Date.parse("2026-10-07T10:00:00Z");
  const task = store.create(first.workspace.id, { title: "Review", prompt: "Check delegated work", sessionId: null, reuseChat: false, projectAccess: "all", pinSession: false,
    schedule: { kind: "interval", startAt: "2026-10-07T11:00:00Z", timeZone: "UTC", minutes: 1440 } }, clock);
  const deliveries: string[] = [];
  const runner = new ScheduledTaskRunner(store, {
    available: async () => true,
    resolveSession: async () => (await f.assistant.current()).day.sessionId,
    createSession: async () => { throw new Error("Must not create a per-task chat"); },
    send: async (_task, id) => { deliveries.push(id); },
  }, () => clock);
  clock += 3600000; await runner.tick();
  f.setTime(new Date(2026, 9, 8, 11)); clock += 86400000; await runner.tick();
  expect(deliveries).toEqual([first.day.sessionId, (await f.assistant.current()).day.sessionId]);
  expect(new Set(deliveries).size).toBe(2);
  expect(store.get(first.workspace.id, task.id).sessionId).toBeNull();
  expect(store.runs(task.id).every(run => run.status === "sent" && !run.pinSession)).toBe(true);
});
