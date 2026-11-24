import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { saveWorkdayLog } from "./day-log.js";
import { captureProfile, checkScheduledWorkday } from "./routes.js";

test("an unchanged scheduled source check advances the full interval without rerunning every minute", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-workday-schedule-"));
  try {
    const config = backOfficeTestConfig(root);
    const { path } = await captureProfile(config, await backOfficeAccess(config));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      days: {}, lastRun: 0,
      settings: {
        calendar: false, tasks: false, documents: false, workspaceActivity: false,
        intervalMinutes: 60,
        model: { workspaceId: "example", providerID: "fixture", modelID: "fixture" },
      },
    }));
    const start = new Date(2030, 0, 10, 8).getTime();
    const sourceChecks: number[] = [];
    async function check(minutes: number) {
      const now = start + minutes * 60_000;
      await checkScheduledWorkday(config, {
        now: () => now,
        async readConnected() {
          sourceChecks.push(minutes);
          return [];
        },
      });
    }
    const state = async () => z.object({
      lastRun: z.number(),
      reconstruction: z.record(z.string(), z.object({ key: z.string(), status: z.object({ type: z.string() }) })),
    }).parse(JSON.parse(await readFile(path, "utf8")));
    await check(0);
    const initial = await state();
    expect(Object.values(initial.reconstruction)[0]).toMatchObject({ status: { type: "ready" } });
    for (const minute of [59, 60, 61, 119, 120]) await check(minute);
    const latest = await state();
    expect(latest.reconstruction).toEqual(initial.reconstruction);
    expect(latest.lastRun).toBe(start + 120 * 60_000);
    expect(sourceChecks).toEqual([0, 60, 120]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists the complete source day log before inference and preserves it when a source fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-source-day-log-"));
  try {
    const config = backOfficeTestConfig(root);
    const { path } = await captureProfile(config, await backOfficeAccess(config));
    await mkdir(dirname(path), { recursive: true });
    const date = "2030-01-10";
    const start = new Date(2030, 0, 10, 8);
    const settings = { calendar: false, tasks: false, documents: false, workspaceActivity: false,
      schedule: { frequency: "hourly" }, model: { workspaceId: "local", providerID: "local", modelID: "llama.cpp" } };
    await writeFile(path, JSON.stringify({ days: {}, lastRun: 0, settings }));
    const localTime = (hour: number, minute = 0) => new Date(2030, 0, 10, hour, minute).toISOString();
    const meeting = (eventKey: string, startAt: string, endAt: string) => ({ eventKey, proposal: {
      key: crypto.randomUUID(), digest: "a".repeat(64), date, source: "calendar" as const, projectId: null, dismissed: false,
      narrative: "Synthetic appointment " + eventKey, activity: "EXM", startAt, endAt, workedMinutes: 60,
    } });
    const source = [meeting("in-progress", localTime(7, 30), localTime(8, 30)), meeting("future", localTime(13), localTime(14))];
    const check = (hour: number, readConnected: NonNullable<Parameters<typeof checkScheduledWorkday>[1]["readConnected"]>) =>
      checkScheduledWorkday(config, { now: () => new Date(2030, 0, 10, hour).getTime(), readConnected });
    await check(8, async () => source);
    const logfile = join(path + ".day-log", date + ".json");
    const log = await readFile(logfile, "utf8");
    const normalized = JSON.parse(log);
    expect(normalized).toMatchObject({ date, collectedAt: start.toISOString(), observations: [
      { eventKey: "in-progress", proposal: { startAt: localTime(7, 30), endAt: localTime(8, 30), workedMinutes: 60 } },
      { eventKey: "future", proposal: { startAt: localTime(13), endAt: localTime(14) } },
    ] });
    expect(JSON.parse(await readFile(path, "utf8")).checkedThrough[date]).toBeUndefined();
    await check(9, async () => { throw Error("Synthetic provider outage"); });
    expect(JSON.parse(await readFile(path, "utf8")).reconstruction[date].status.reason).toBe("sources_failed");
    expect(await readFile(logfile, "utf8")).toBe(log);
    await check(10, async () => source.map(item => ({ ...item, proposal: { ...item.proposal, key: crypto.randomUUID() } })));
    const repeated = JSON.parse(await readFile(logfile, "utf8"));
    expect(repeated.observations).toEqual(normalized.observations);
    expect(repeated.superseded).toEqual([]);
    await check(11, async () => []);
    const refreshed = JSON.parse(await readFile(logfile, "utf8"));
    expect(refreshed.observations).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8")).checkedThrough[date]).toBe(localTime(11));
    expect(refreshed.superseded).toMatchObject(source.map(item => ({ replacedAt: localTime(11), observation: { eventKey: item.eventKey } })));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily times fire once, survive a closed workspace, and never run while suggestions are off", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-workday-clock-"));
  try {
    const config = backOfficeTestConfig(root);
    const { path } = await captureProfile(config, await backOfficeAccess(config));
    await mkdir(dirname(path), { recursive: true });
    const settings = { calendar: false, tasks: false, documents: false, workspaceActivity: false,
      intervalMinutes: 0, model: { workspaceId: "fixture", providerID: "fixture", modelID: "fixture" } };
    const profile = z.object({
      settings: z.object({ enabled: z.boolean().optional() }).passthrough(),
      lastScheduledSlot: z.number(),
      checkedThrough: z.record(z.iso.date(), z.iso.datetime()),
    }).passthrough();
    await writeFile(path, JSON.stringify({ days: {}, lastRun: 0, settings }));
    let reads = 0;
    const tick = (day: number, hour: number, minute = 0) =>
      checkScheduledWorkday(config, { now: () => new Date(2030, 0, day, hour, minute).getTime(), async readConnected() { reads++; return []; } });
    const saved = async () => profile.parse(JSON.parse(await readFile(path, "utf8")));
    await tick(10, 17, 59);
    expect(reads).toBe(0);
    await Promise.all([tick(10, 18, 15), tick(10, 18, 15)]);
    expect(reads).toBe(1);
    const firstRun = await saved();
    expect(firstRun.lastScheduledSlot).toBe(new Date(2030, 0, 10, 18).getTime());
    expect(firstRun.checkedThrough["2030-01-10"]).toBe(new Date(2030, 0, 10, 18, 15).toISOString());
    await tick(10, 19, 59);
    expect(reads).toBe(1);
    await tick(10, 20);
    expect(reads).toBe(1);
    const evening = await saved();
    await writeFile(path, JSON.stringify({ ...evening, settings: { ...evening.settings, enabled: false } }));
    await tick(11, 18);
    expect(reads).toBe(1);
    expect((await saved()).checkedThrough["2030-01-11"]).toBeUndefined();
    await writeFile(path, JSON.stringify({ ...evening, settings: { ...evening.settings, enabled: true, schedule: { frequency: "daily", times: ["09:45"] } } }));
    await tick(11, 9, 44);
    expect(reads).toBe(1);
    await tick(11, 9, 45);
    expect(reads).toBe(2);
    const reviewed: Array<[string, string | undefined]> = [];
    const runChat = (minute: number) => checkScheduledWorkday(config, {
      now: () => new Date(2030, 0, 12, 9, minute).getTime(),
      async readConnected() { return []; },
      async startChat(_profile, date, _request, _model, previousDate) { reviewed.push([date, previousDate]); },
    });
    await runChat(44);
    await runChat(45);
    await runChat(46);
    expect(reviewed).toEqual([["2030-01-12", "2030-01-11"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a successful file scan retains earlier observed edits, while losing access removes their model eligibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "workday-file-snapshots-"));
  const path = join(root, "profile.json"), date = "2031-01-12", account = { provider: "google-drive" as const, account: "a".repeat(64) };
  const edit = (hour: string) => ({ eventKey: "file-at-" + hour, proposal: {
    key: crypto.randomUUID(), digest: "b".repeat(64), source: account.provider, account: account.account, date,
    narrative: "Memo", projectId: null, documentId: "same-file", activity: "MOD", startAt: null, endAt: null, workedMinutes: null,
    observedAt: date + "T" + hour + ":00:00.000Z", dismissed: false,
  } });
  const first = edit("09"), second = edit("14");
  try {
    await saveWorkdayLog(path, date, "UTC", first.proposal.observedAt, [first], [], [account]);
    const both = await saveWorkdayLog(path, date, "UTC", second.proposal.observedAt, [second], [], [account]);
    expect(both.map(row => row.eventKey).sort()).toEqual([first.eventKey, second.eventKey]);
    const missing = await saveWorkdayLog(path, date, "UTC", date + "T15:00:00.000Z", [], [{ ...account, reason: "offline" }], []);
    expect(missing).toEqual([]);
    const snapshot = () => readFile(join(path + ".day-log", date + ".json"), "utf8").then(JSON.parse);
    expect((await snapshot()).observations).toHaveLength(2);
    expect(await saveWorkdayLog(path, date, "UTC", date + "T16:00:00.000Z", [], [], [])).toEqual([]);
    expect((await snapshot()).observations).toEqual([]);
    expect((await snapshot()).superseded).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
