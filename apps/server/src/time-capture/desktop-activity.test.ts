import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DesktopActivitySample } from "@legalwork/types/time-capture";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { activeCaptureProfile } from "./profile.js";
import { readDesktopEvidence, recordDesktopSample, resetDesktopSampling, resolveDesktopForeground } from "./desktop-activity.js";

test("desktop source requires deliberate consent, coalesces recent samples, stops on idle, lock, gaps or profile changes and clips local days", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-desktop-samples-"));
  try {
    const config = backOfficeTestConfig(root);
    const owner = await activeCaptureProfile(config);
    await mkdir(dirname(owner.path), { recursive: true });
    const configure = (desktopActivity: boolean) => writeFile(owner.path, JSON.stringify({ days: {}, lastRun: 0,
      settings: { desktopActivity, calendar: false, tasks: false } }));
    const first = Date.parse("2030-01-08T23:59:30Z");
    const at = (seconds: number) => first + seconds * 1000;
    const sample = (seconds: number, extra: Partial<DesktopActivitySample> = {}) => ({
      platform: "darwin" as const, permission: "granted" as const, state: "active" as const,
      application: "Pages", documentName: "Synthetic memo.pages", idleSeconds: 0, observedAt: at(seconds), ...extra });
    const observe = (seconds: number, extra?: Partial<DesktopActivitySample>) =>
      recordDesktopSample(config, owner, sample(seconds, extra), at(seconds));
    await expect(observe(0)).rejects.toMatchObject({ code: "desktop_capture_disabled" });
    await configure(true);
    await expect(recordDesktopSample(config, { ...owner, path: owner.path + "-other" }, sample(0), first)).rejects.toMatchObject({ code: "private_workday_changed" });
    await expect(recordDesktopSample(config, owner, sample(0), at(180))).rejects.toMatchObject({ code: "desktop_sample_time" });
    for (const seconds of [0, 15, 30, 45, 60, 75, 90, 105, 120, 135]) await observe(seconds);
    await observe(135);
    await observe(120);
    await observe(150, { state: "idle", idleSeconds: 61 });
    await observe(165);
    await observe(180, { state: "locked" });
    await observe(195);
    await observe(255);
    await observe(270, { isLegalWork: true });
    await observe(285, { permission: "needed" });
    await observe(300, { permission: "needed" });
    await observe(315, { documentName: "/private/secret.pdf" });
    await observe(330, { documentName: "https://private.example/report.pdf" });
    await observe(345, { application: "C:\\secret\\Application.exe" });
    await observe(360, { application: "C:\\secret\\Application.exe" });
    const firstDay = await readDesktopEvidence(owner, "2030-01-08", "UTC");
    expect(firstDay).toHaveLength(1);
    expect(firstDay[0].proposal.endAt).toBe("2030-01-09T00:00:00.000Z");
    const records = await readDesktopEvidence(owner, "2030-01-09", "UTC");
    expect(records).toHaveLength(2);
    expect(records[0].proposal).toMatchObject({ startAt: "2030-01-09T00:00:00.000Z", endAt: new Date(at(135)).toISOString(),
      desktopContext: { platform: "darwin", application: "Pages", documentName: "Synthetic memo.pages" }, workedMinutes: null });
    expect(records[1].proposal.desktopContext).toEqual({ platform: "darwin", application: "Pages" });
    expect(JSON.stringify(records)).not.toMatch(/private.example|secret/);
    const template = records[0], shift = (seconds: number) => new Date(at(seconds)).toISOString();
    const workspace = { ...template, eventKey: "project-focus", proposal: { ...template.proposal, source: "workspace" as const,
      desktopContext: undefined, startAt: shift(15), endAt: shift(150) } };
    const calendar = { ...workspace, eventKey: "meeting", proposal: { ...workspace.proposal, source: "calendar" as const } };
    const resolved = resolveDesktopForeground([workspace, template, calendar]);
    expect(resolved.filter(row => row.proposal.source === "workspace").map(row => [row.proposal.startAt, row.proposal.endAt]))
      .toEqual([[shift(15), shift(30)], [shift(135), shift(150)]]);
    expect(resolved.filter(row => row.proposal.source === "workspace").every(row => row.claims?.[0].id === "project-focus")).toBe(true);
    expect(resolved.find(row => row.proposal.source === "calendar")).toEqual(calendar);
    await configure(false);
    expect(await readDesktopEvidence(owner, "2030-01-09", "UTC")).toEqual([]);
    await expect(observe(375)).rejects.toMatchObject({ code: "desktop_capture_disabled" });
    resetDesktopSampling(config);
  } finally { await rm(root, { recursive: true, force: true }); }
});
