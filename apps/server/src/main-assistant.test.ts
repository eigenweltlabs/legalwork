import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainAssistant, isMainAssistant } from "./main-assistant.js";
import type { ProjectField } from "@legalwork/types/workspace";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
let previousDatabase: string | undefined;
beforeEach(() => { previousDatabase = process.env.OPENCODE_DB; });
afterEach(async () => {
  if (previousDatabase === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = previousDatabase;
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "main-assistant-")); roots.push(root);
  process.env.OPENCODE_DB = join(root, "engine.sqlite");
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

test("saved Assistant identity survives restart without contacting the engine or creating a day", async () => {
  const f = await fixture();
  expect(f.assistant.savedDay()).toBeNull();
  const yesterday = await f.assistant.current();
  f.config.readOnly = true;
  const reopened = await MainAssistant.open(f.config, join(f.root, "runtime.sqlite"), () => {
    throw new Error("Browsing saved history must not contact the engine");
  }, undefined, () => new Date(2026, 9, 8, 9));
  expect(reopened.savedDay()).toEqual(yesterday.day);
  expect(f.sessions).toHaveLength(1);
  expect(reopened.history(yesterday.workspace.id).days).toEqual([yesterday.day]);
});

test("assistant appearance persists across restart and never changes its project folder or day", async () => {
  const f = await fixture();
  const before = await f.assistant.current();
  expect(f.assistant.profile()).toEqual({ name: null, icon: "flower" });
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
  await f.assistant.updateProfile({ name: null, icon: "flower" });
  expect(await (await f.factory()).needsOnboarding()).toBe(false);
});

test("the greeting is read on first open, while name and avatar choices survive restarts", async () => {
  const f = await fixture();
  const initial = await f.assistant.onboarding();
  expect(initial).toMatchObject({ needed: true, step: "name", greetingUnread: true, icon: "flower" });
  const day = await f.assistant.current();
  expect((await f.assistant.onboarding()).greetingUnread).toBe(true);
  await expect(f.assistant.answerOnboarding({ icon: "bird" })).rejects.toThrow("name first");
  await f.assistant.viewGreeting();
  const reopened = await f.factory();
  expect(await reopened.onboarding()).toMatchObject({ needed: true, step: "name", greetingUnread: false });
  await reopened.viewGreeting();
  const named = await reopened.answerOnboarding({ name: "Josi" });
  expect(named).toMatchObject({ needed: true, step: "avatar", name: "Josi", icon: "flower", sessionId: day.day.sessionId });
  expect(reopened.profile()).toEqual({ name: "Josi", icon: "flower" });
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

test("users can choose the flower as their completed appearance", async () => {
  const f = await fixture();
  await f.assistant.answerOnboarding({ name: "My assistant" });
  expect(await f.assistant.answerOnboarding({ icon: "flower" })).toMatchObject({ needed: false, step: "complete", icon: "flower" });
  expect((await f.factory()).profile()).toEqual({ name: "My assistant", icon: "flower" });
});

test("renaming an existing profile without an onboarding row returns its actual saved name and icon", async () => {
  const f = await fixture();
  await f.assistant.updateProfile({ name: "Maya", icon: "bird" });
  expect(await f.assistant.setName("Momo")).toMatchObject({ needed: false, step: "complete", name: "Momo", icon: "bird" });
  expect(await (await f.factory()).onboarding()).toMatchObject({ name: "Momo", icon: "bird" });
});

test("legacy dot profiles remain valid without changing custom names or restarting onboarding", async () => {
  const f = await fixture();
  await f.assistant.answerOnboarding({ name: "Johannes" });
  await f.assistant.answerOnboarding({ icon: "dot" });
  const resumed = await f.factory();
  expect(resumed.profile()).toEqual({ name: "Johannes", icon: "dot" });
  expect(await resumed.needsOnboarding()).toBe(false);
  await resumed.updateProfile({ name: "Johannes", icon: "flower" });
  expect((await f.factory()).profile()).toEqual({ name: "Johannes", icon: "flower" });
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

test("Assistant preferences persist independently of appearance and keep daily history", async () => {
  const f = await fixture();
  expect(f.assistant.settings()).toEqual({ systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "all", projectIds: [] } });
  const current = await f.assistant.current();
  const prompt = "Write clear German replies.\n".repeat(600);
  const resource = { id: "skill-one", kind: "skill", name: "Research", description: "Find evidence", reference: "/library/research/SKILL.md", projectId: null, projectName: null } satisfies import("@legalwork/types/main-assistant").AssistantResource;
  const saved = f.assistant.updateSettings({ browserModel: { providerID: "openai", modelID: "gpt-6.1-terra" }, systemPromptAddition: prompt, resourceIds: [resource.id, resource.id], projectAccess: { mode: "include", projectIds: ["a", "a"] } }, [resource]);
  expect(saved.resourceIds).toEqual([resource.id]);
  expect(saved.projectAccess.projectIds).toEqual(["a"]);
  const reopened = await f.factory();
  expect(reopened.settings()).toEqual(saved);
  expect(reopened.settings().browserModel).toEqual({ providerID: "openai", modelID: "gpt-6.1-terra" });
  expect(reopened.resourceMetadata()).toEqual([resource]);
  expect((await reopened.current()).day).toEqual(current.day);
  expect(reopened.profile()).toEqual({ name: null, icon: "flower" });
  expect(reopened.settings().systemPromptAddition).toBe(prompt);
  f.config.readOnly = true;
  expect(() => reopened.updateSettings(saved)).toThrow("writable");
});

test("all four project access modes keep the Assistant workspace and handle future projects", async () => {
  const f = await fixture();
  const workspace = await f.assistant.workspace();
  const cases: Array<[string, boolean[]]> = [
    ["all", [true, true, true]], ["none", [false, false, false]],
    ["include", [true, false, false]], ["exclude", [false, true, true]],
  ];
  for (const [mode, expected] of cases) {
    f.assistant.updateSettings({ systemPromptAddition: "", resourceIds: [], projectAccess: { mode, projectIds: ["a"] } });
    expect(["a", "b", "future"].map(id => f.assistant.canAccessProject(id))).toEqual(expected);
    expect(f.assistant.canAccessProject(workspace.id)).toBe(true);
    if (!expected[0]) expect(() => f.assistant.assertProjectAccess("a")).toThrow("allowed projects");
  }
});
