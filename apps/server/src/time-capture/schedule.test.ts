import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
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
    await tick(10, 7, 59);
    expect(reads).toBe(0);
    await Promise.all([tick(10, 8, 15), tick(10, 8, 15)]);
    expect(reads).toBe(1);
    const morning = await saved();
    expect(morning.lastScheduledSlot).toBe(new Date(2030, 0, 10, 8).getTime());
    expect(morning.checkedThrough["2030-01-10"]).toBe(new Date(2030, 0, 10, 8, 15).toISOString());
    await tick(10, 19, 59);
    expect(reads).toBe(1);
    await tick(10, 20);
    expect(reads).toBe(2);
    const evening = await saved();
    await writeFile(path, JSON.stringify({ ...evening, settings: { ...evening.settings, enabled: false } }));
    await tick(11, 8);
    expect(reads).toBe(2);
    expect((await saved()).checkedThrough["2030-01-11"]).toBeUndefined();
    await writeFile(path, JSON.stringify({ ...evening, settings: { ...evening.settings, enabled: true, schedule: { frequency: "daily", times: ["09:45"] } } }));
    await tick(11, 9, 44);
    expect(reads).toBe(2);
    await tick(11, 9, 45);
    expect(reads).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
