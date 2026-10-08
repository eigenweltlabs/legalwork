import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainAssistant, isMainAssistant } from "./main-assistant.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { ScheduledTaskRunner } from "./scheduled-tasks/runner.js";
import type { ProjectField } from "@legalwork/types/workspace";
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
  expect(f.assistant.profile()).toEqual({ name: null, icon: "dot" });
  expect(await f.assistant.needsOnboarding()).toBe(true);
  await f.assistant.updateProfile({ name: "Momo", icon: "otter" });
  const reopened = await f.factory();
  expect(reopened.profile()).toEqual({ name: "Momo", icon: "otter" });
  await reopened.updateProfile({ name: "Momo", icon: "professional_owl" });
  expect((await f.factory()).profile()).toEqual({ name: "Momo", icon: "professional_owl" });
  expect(await reopened.needsOnboarding()).toBe(false);
  expect(await reopened.current()).toEqual(before);
  f.config.readOnly = true;
  await expect(reopened.updateProfile({ name: "Other", icon: "fox" })).rejects.toThrow("writable");
  expect(reopened.profile().name).toBe("Momo");
});

test("keeping the default completes onboarding across restarts, even with no user messages", async () => {
  const f = await fixture();
  await f.assistant.current();
  expect(await f.assistant.needsOnboarding()).toBe(true);
  await f.assistant.updateProfile({ name: null, icon: "dot" });
  expect(await (await f.factory()).needsOnboarding()).toBe(false);
});

test("the greeting is read on first open, while name and avatar choices survive restarts", async () => {
  const f = await fixture();
  const initial = await f.assistant.onboarding();
  expect(initial).toMatchObject({ needed: true, step: "name", greetingUnread: true, icon: "dot" });
  const day = await f.assistant.current();
  expect((await f.assistant.onboarding()).greetingUnread).toBe(true);
  await expect(f.assistant.answerOnboarding({ icon: "bird" })).rejects.toThrow("name first");
  await f.assistant.viewGreeting();
  const reopened = await f.factory();
  expect(await reopened.onboarding()).toMatchObject({ needed: true, step: "name", greetingUnread: false });
  await reopened.viewGreeting();
  const named = await reopened.answerOnboarding({ name: "Josi" });
  expect(named).toMatchObject({ needed: true, step: "avatar", name: "Josi", icon: "dot", sessionId: day.day.sessionId });
  expect(reopened.profile()).toEqual({ name: "Josi", icon: "dot" });
  expect(await reopened.answerOnboarding({ name: "Josi" })).toEqual(named);
  await expect(reopened.answerOnboarding({ name: "Different" })).rejects.toThrow("already been chosen");
  const resumed = await f.factory();
  expect(await resumed.onboarding()).toEqual(named);
  const complete = await resumed.answerOnboarding({ icon: "professional_owl" });
  expect(complete).toMatchObject({ needed: false, step: "complete", greetingUnread: false, name: "Josi", icon: "professional_owl" });
  expect(await resumed.answerOnboarding({ icon: "professional_owl" })).toEqual(complete);
  expect(await (await f.factory()).onboarding()).toEqual(complete);
  expect(resumed.profile()).toEqual({ name: "Josi", icon: "professional_owl" });
  expect(f.sessions).toHaveLength(1);
  f.config.readOnly = true;
  await expect(resumed.viewGreeting()).rejects.toThrow("writable");
  await expect(resumed.answerOnboarding({ name: "Other" })).rejects.toThrow("writable");
});

test("agent naming persists before UI appearance selection, and later renames preserve the icon", async () => {
  const f = await fixture();
  await f.assistant.viewGreeting();
  const named = await f.assistant.setName("Hannes");
  expect(named).toMatchObject({ needed: true, step: "avatar", name: "Hannes", agentNamed: true });
  const resumed = await f.factory();
  expect(await resumed.onboarding()).toEqual(named);
  await resumed.answerOnboarding({ icon: "bird" });
  expect(await resumed.setName("Johann")).toMatchObject({ needed: false, step: "complete", name: "Johann", icon: "bird", agentNamed: true });
  expect(resumed.profile()).toEqual({ name: "Johann", icon: "bird" });
});

test("users can keep the dot as their completed appearance", async () => {
  const f = await fixture();
  await f.assistant.answerOnboarding({ name: "Dot" });
  expect(await f.assistant.answerOnboarding({ icon: "dot" })).toMatchObject({ needed: false, step: "complete", icon: "dot" });
  expect((await f.factory()).profile()).toEqual({ name: "Dot", icon: "dot" });
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

test("assistant-created project schemas preserve custom defaults across restart and clear their values", async () => {
  const f = await fixture();
  const field: ProjectField = { id: "our_client", label: "Our client", type: "text", value: "Never copy a previous client" };
  f.assistant.updateProjectDefaults([field]);
  const resumed = await f.factory();
  expect(resumed.projectDefaults()).toEqual([{ ...field, value: null }]);
  resumed.updateProjectDefaults([]);
  expect((await f.factory()).projectDefaults()).toEqual([]);
  f.config.readOnly = true;
  expect(() => resumed.updateProjectDefaults([field])).toThrow("writable");
});
