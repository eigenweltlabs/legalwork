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
