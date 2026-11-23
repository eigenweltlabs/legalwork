import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { startServer } from "../server.js";
import { readWorkdayLog } from "./day-log.js";
import { activeCaptureProfile } from "./profile.js";
import { digest, humanInterval, type WorkdayEvidence } from "./private-workday.js";
import { workdayChatReader } from "./workday-chat.test-support.js";

test("existing local file-use observations remain readable when desktop activity is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-file-history-"));
  const config = backOfficeTestConfig(root);
  const server = await startServer(config);
  try {
    const { path, profileId, scope, user, principal } = await activeCaptureProfile(config);
    const date = "2025-04-14";
    const archive = path + ".file-history";
    const file = join(archive, date + ".json");
    const record = {
      eventKey: digest("synthetic local memo"),
      proposal: {
        source: "desktop", fileUseSource: "spotlight-last-used", date, key: randomUUID(), digest: digest("file use"),
        projectId: null, narrative: "Synthetic local memo.pdf", observedAt: date + "T12:10:00.000Z",
        activity: "", dismissed: false, startAt: null, endAt: null, workedMinutes: null,
      },
    } satisfies WorkdayEvidence;
    const contents = JSON.stringify([record]);
    await mkdir(archive, { recursive: true });
    await writeFile(file, contents);
    const query = new URLSearchParams({ profileId, scope, user, principal, date });
    const readDay = await workdayChatReader(config, profileId, server.port);
    const setDesktopActivity = async (value: boolean) => {
      const response = await fetch("http://127.0.0.1:" + server.port + "/private-timesheet/workday?" + query, {
        method: "POST", headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "settings-patch", change: { field: "desktopActivity", value } }),
      });
      expect(response.status).toBe(200);
    };
    await setDesktopActivity(true);
    await readDay(date);
    const { observations } = await readWorkdayLog(path, date);
    const observed = observations.find(item => item.eventKey === record.eventKey);
    expect(observed?.proposal).toMatchObject(record.proposal);
    expect(humanInterval(record.proposal)).toBeUndefined();
    await setDesktopActivity(false);
    await readDay(date);
    expect((await readWorkdayLog(path, date)).observations.map(item => item.eventKey)).not.toContain(record.eventKey);
    expect(await readFile(file, "utf8")).toBe(contents);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
