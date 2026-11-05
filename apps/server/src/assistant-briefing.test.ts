import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateMorningBriefing, MORNING_BRIEFING_KEY } from "./assistant-briefing.js";
import { ScheduledTaskStore } from "./scheduled-tasks/store.js";
import { nextOccurrence } from "./scheduled-tasks/schedule.js";
import type { ServerConfig } from "./types.js";

function configFor(root: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", workspaces: [], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
}

test("startup never creates a briefing, while explicit creation stays idempotent and editable", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-briefing-opt-in-"));
  const path = join(root, "runtime.sqlite"), store = await ScheduledTaskStore.open(path), config = configFor(root);
  const now = Date.parse("2026-10-07T14:00:00Z");
  const input = { title: "Morning briefing", prompt: "Brief me", schedule: { kind: "rrule", startAt: "2026-10-08T08:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" }, projectAccess: "all", sessionId: null };
  try {
    for (let i = 0; i < 8; i++) migrateMorningBriefing(config, store, now);
    expect(store.list()).toEqual([]);
    const task = store.createDefault(MORNING_BRIEFING_KEY, "assistant", input, now);
    if (!task) throw new Error("Missing task");
    expect(store.createDefault(MORNING_BRIEFING_KEY, "assistant", input, now)).toBeNull();
    expect(nextOccurrence(task.schedule, Date.parse("2026-10-23T07:00:00Z"))).toBe("2026-10-26T07:00:00.000Z");
    const paused = store.update("assistant", task.id, task.revision, { status: "paused", title: "My daily notes", prompt: "Custom instructions" }, now);
    const reopened = await ScheduledTaskStore.open(path);
    migrateMorningBriefing(config, reopened, now);
    expect(reopened.defaultTask(MORNING_BRIEFING_KEY)).toEqual(paused);
    reopened.remove("assistant", task.id, paused.revision);
    migrateMorningBriefing(config, reopened, now);
    expect(reopened.list()).toEqual([]);
    expect(reopened.hasDefault(MORNING_BRIEFING_KEY)).toBe(true);
    expect(reopened.createDefault(MORNING_BRIEFING_KEY, "assistant", input, now)).toBeNull();
    expect(reopened.createDefault(MORNING_BRIEFING_KEY, "assistant", input, now, { replaceDeleted: true, wikiScope: "owner" })).toMatchObject({ wikiScope: "owner" });
    expect(reopened.list()).toHaveLength(1);
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
