import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureMorningBriefing, hasBriefingSessionThreshold, MORNING_BRIEFING_KEY } from "./assistant-briefing.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { nextOccurrence } from "./scheduled-tasks/schedule.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

function configFor(root: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", workspaces: [], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
}

test("briefing eligibility starts at six root chats, across projects, without counting empty daily chats or inaccessible projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-briefing-count-"));
  const prior = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(root, "engine.sqlite");
  const db = new Database(process.env.OPENCODE_DB);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  const config = configFor(root);
  config.workspaces = ["one", "two", "assistant", "denied", "remote"].map(id => ({ id, name: id, path: join(root, id), preset: id === "assistant" ? "main-assistant" : "starter", workspaceType: id === "remote" ? "remote" : "local" }));
  const accessible = async (id: string) => {
    if (id === "denied") throw new Error("Access ended");
    const workspace = config.workspaces.find(item => item.id === id);
    if (!workspace) throw new Error("Missing");
    return workspace;
  };
  const add = (id: string, project: string, parent: string | null = null) => db.query("INSERT INTO session VALUES (?, ?, ?)").run(id, join(root, project), parent);
  try {
    for (let i = 0; i < 5; i++) add(`chat-${i}`, i % 2 ? "one" : "two");
    for (let i = 0; i < 8; i++) { add(`empty-day-${i}`, "assistant"); add(`denied-${i}`, "denied"); add(`remote-${i}`, "remote"); add(`child-${i}`, "one", "chat-1"); }
    expect(await hasBriefingSessionThreshold(config, accessible)).toBe(false);
    db.query("INSERT INTO message VALUES (?, ?, ?)").run("user-message", "empty-day-0", JSON.stringify({ role: "user" }));
    expect(await hasBriefingSessionThreshold(config, accessible)).toBe(true);
  } finally {
    db.close();
    if (prior === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("briefing setup is once per profile, atomic across callers, and respects deletion, edits and pause across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-briefing-once-"));
  const path = join(root, "runtime.sqlite");
  const store = await ScheduledTaskStore.open(path);
  const config = configFor(root);
  const workspace: WorkspaceInfo = { id: "assistant", name: "Assistant", path: join(root, "assistant"), preset: "main-assistant", workspaceType: "local" };
  let createdWorkspace = 0;
  const assistant = { workspace: async () => { createdWorkspace++; return workspace; } };
  const now = Date.parse("2026-10-07T14:00:00Z");
  const setup = (target = store, eligible = true) => ensureMorningBriefing(config, target, assistant, async () => eligible, now, "Europe/Berlin");
  try {
    expect(await setup(store, false)).toBeNull();
    expect(createdWorkspace).toBe(0);
    config.readOnly = true;
    expect(await setup()).toBeNull();
    config.readOnly = false;
    const other = await ScheduledTaskStore.open(path);
    await Promise.all([setup(), setup(other), setup()]);
    expect(store.list()).toHaveLength(1);
    const task = store.list()[0];
    expect(task).toMatchObject({ title: "Morning briefing", workspaceId: "assistant", projectAccess: "all", sessionId: null, pinSession: false, reuseChat: false, status: "active", nextRunAt: "2026-10-08T04:00:00.000Z" });
    expect(task.schedule).toMatchObject({ kind: "rrule", rrule: "FREQ=DAILY", timeZone: "Europe/Berlin", startAt: "2026-10-07T06:00:00" });
    expect(nextOccurrence(task.schedule, Date.parse("2026-10-24T04:00:00Z"))).toBe("2026-10-25T05:00:00.000Z");
    const edited = store.update(workspace.id, task.id, task.revision, { title: "My briefing", status: "paused" }, now);
    const reopened = await ScheduledTaskStore.open(path);
    expect(await setup(reopened)).toBeNull();
    expect(reopened.get(workspace.id, task.id)).toMatchObject({ title: "My briefing", status: "paused" });
    reopened.remove(workspace.id, task.id, edited.revision);
    expect(await setup(await ScheduledTaskStore.open(path))).toBeNull();
    expect(store.list()).toEqual([]);
    expect(store.hasDefault(MORNING_BRIEFING_KEY)).toBe(true);
    expect(() => store.createDefault("invalid", workspace.id, {}, now)).toThrow();
    expect(store.hasDefault("invalid")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("default prompt migration preserves timing, pause, custom instructions and deleted tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-briefing-upgrade-"));
  const store = await ScheduledTaskStore.open(join(root, "runtime.sqlite"));
  const now = Date.parse("2026-10-07T14:00:00Z");
  const oldPrompt = "Original preset";
  const oldHash = createHash("sha256").update(oldPrompt).digest("hex");
  const input = { title: "My briefing", prompt: oldPrompt, schedule: { kind: "rrule", startAt: "2026-10-08T06:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=DAILY" }, projectAccess: "all", sessionId: null };
  try {
    const task = store.createDefault(MORNING_BRIEFING_KEY, "assistant", input, now);
    if (!task) throw new Error("Missing fixture");
    const paused = store.update("assistant", task.id, task.revision, { status: "paused" }, now);
    const upgraded = store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, oldHash, "Use direct tools", now + 1000);
    expect(upgraded).toEqual({ ...paused, prompt: "Use direct tools", revision: paused.revision + 1, updatedAt: new Date(now + 1000).toISOString() });
    expect(store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, oldHash, "Use direct tools", now + 2000)).toBeNull();
    if (!upgraded) throw new Error("Missing upgrade");
    const edited = store.update("assistant", task.id, upgraded.revision, { prompt: "My instructions" }, now);
    expect(store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, oldHash, "Use direct tools", now)).toBeNull();
    expect(store.get("assistant", task.id)).toEqual(edited);
    store.remove("assistant", task.id, edited.revision);
    expect(store.migrateDefaultPrompt(MORNING_BRIEFING_KEY, oldHash, "Use direct tools", now)).toBeNull();
    expect(store.hasDefault(MORNING_BRIEFING_KEY)).toBe(true);
    expect(store.list()).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
