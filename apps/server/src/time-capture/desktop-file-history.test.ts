import { workdayChatReader } from "./workday-chat.test-support.js";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { startServer } from "../server.js";
import { readFileHistory } from "./desktop-file-history.js";
import { activeCaptureProfile } from "./profile.js";
import { humanInterval, type WorkdayEvidence } from "./private-workday.js";

test("only the local host can import date-scoped file-use observations with current profile consent", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-file-history-"));
  const config = backOfficeTestConfig(root);
  const server = await startServer(config);
  const date = "2025-04-14";
  const owner = await activeCaptureProfile(config);
  const { profileId, scope, user, principal } = owner;
  const readDay = await workdayChatReader(config, profileId, server.port);
  const history = "desktop-history?profileId=" + profileId;
  const workday = "workday?" + new URLSearchParams({ profileId, scope, user, principal, date });
  const api = (route: string, body?: unknown, host = true) => fetch("http://127.0.0.1:" + server.port + "/private-timesheet/" + route, {
    method: body ? "POST" : "GET",
    headers: { ...(host ? { "X-LegalWork-Host-Token": config.hostToken } : { Authorization: "Bearer " + config.token }), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setting = (field: string, value: boolean) => api(workday, { type: "settings-patch", change: { field, value } });
  const row = { name: "Synthetic local memo.pdf", observedAt: date + "T12:10:00.000Z" };
  try {
    expect((await api(history)).status).toBe(403);
    expect((await api(history, undefined, false)).status).toBe(401);
    expect((await api("desktop-history?profileId=other")).status).toBe(409);
    expect((await setting("desktopActivity", true)).status).toBe(200);
    const { epoch } = await (await api(history)).json();
    const payload = { platform: "darwin", entries: [row], date, epoch, limited: false };
    expect((await api(history, { ...payload, entries: [{ ...row, name: "/outside.pdf" }] })).status).toBe(400);
    expect((await api(history, { ...payload, entries: [{ ...row, contents: "ignored?" }] })).status).toBe(400);
    expect((await api(history, { ...payload, date: "2025-04-15" })).status).toBe(400);
    expect(await (await api(history, { ...payload, entries: [] })).json()).toEqual({ imported: 0 });
    expect(await (await api(history, { ...payload, entries: [row, row] })).json()).toEqual({ imported: 1 });
    expect(await (await api(history, payload)).json()).toEqual({ imported: 0 });
    expect((await readFileHistory(owner.path + ".other", date)).length).toBe(0);
    const work = await readFileHistory(owner.path, date);
    expect(work).toHaveLength(1);
    expect(work[0].proposal).toMatchObject({ source: "desktop", narrative: row.name, observedAt: row.observedAt, fileUseSource: "spotlight-last-used",
      startAt: null, endAt: null, projectId: null, workedMinutes: null });
    expect(humanInterval(work[0].proposal)).toBeUndefined();
    await readDay(date);
    const log = async (): Promise<WorkdayEvidence[]> => JSON.parse(await readFile(join(owner.path + ".day-log", date + ".json"), "utf8")).observations;
    expect((await log()).map(item => item.eventKey)).toContain(work[0].eventKey);
    expect((await setting("desktopActivity", false)).status).toBe(200);
    expect((await api(history, payload)).status).toBe(403);
    await readDay(date);
    expect((await log()).map(item => item.eventKey)).not.toContain(work[0].eventKey);
    expect((await setting("desktopActivity", true)).status).toBe(200);
    expect((await api(history, payload)).status).toBe(409);
    expect((await setting("enabled", false)).status).toBe(200);
    expect((await api(history)).status).toBe(403);
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
