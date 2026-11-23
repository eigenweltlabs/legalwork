import { workdayChatReader } from "./workday-chat.test-support.js";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { dayInZone } from "../calendar/dates.js";
import { startServer } from "../server.js";
import { recordingEvidence } from "./meeting-recording.js";
import { activeCaptureProfile } from "./profile.js";
import { type WorkdayEvidence } from "./private-workday.js";
import { reconstructWorkday } from "./reconstruct-workday.js";
import { workdayGroupingInput } from "./workday-model-passes.js";

test("a completed meeting crossing midnight splits into reviewable capture intervals and can corroborate its calendar", () => {
  const row = { profileId: "a".repeat(64), epoch: 1, id: "rec-test-001", title: "Contract meeting", projectId: "p",
    startedAt: Date.parse("2025-04-14T21:50:00Z"), stoppedAt: Date.parse("2025-04-14T22:20:00Z") };
  const [first, next] = recordingEvidence(row, "Europe/Berlin");
  expect(first.proposal).toMatchObject({ date: "2025-04-14", endAt: "2025-04-14T22:00:00.000Z", workedMinutes: null });
  expect(next.proposal).toMatchObject({ date: "2025-04-15", startAt: "2025-04-14T22:00:00.000Z", workedMinutes: null });
  const meeting = { id: "matter", name: "Example" };
  const group = [{ item: first, matter: meeting }, { item: { ...first, eventKey: "calendar-id", proposal: { ...first.proposal, source: "calendar" as const } }, matter: meeting }];
  expect(workdayGroupingInput(group).map(obs => obs.source)).toEqual(["recordings", "calendar"]);
  const output = reconstructWorkday({ proposals: [{ evidenceIds: [first.eventKey, "calendar-id"], matterId: "matter", projectId: "p",
    documentId: null, activity: "EXM", narrative: "Discuss the contract", workedMinutes: 10, startAt: first.proposal.startAt, endAt: first.proposal.endAt }] },
    group, first.proposal.date, "Europe/Berlin");
  expect(output).toHaveLength(1);
  expect(output[0].proposal).toMatchObject({ workedMinutes: 10, narrative: "Discuss the contract" });
  expect(output[0].generated).toBe(true);
  expect(output[0].claims?.map(claim => claim.source).sort()).toEqual(["calendar", "recordings"]);
});

test("host-only recording ingest preserves consent, ignores duplicate delivery and feeds the private day log only while enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-workday-recordings-"));
  const config = backOfficeTestConfig(root);
  const server = await startServer(config);
  try {
    const owner = await activeCaptureProfile(config);
    const { profileId, scope, user, principal } = owner;
    const readDay = await workdayChatReader(config, profileId, server.port);
    const date = dayInZone(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    const workday = "workday?" + new URLSearchParams({ profileId, scope, user, principal, date });
    const api = (route: string, body?: unknown, host = true) => fetch("http://127.0.0.1:" + server.port + "/private-timesheet/" + route, {
      method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json",
        ...(host ? { "X-LegalWork-Host-Token": config.hostToken } : { Authorization: "Bearer " + config.token }) },
    });
    const consent = "meeting-recording";
    const set = (field: string, value: boolean) => api(workday, { type: "settings-patch", change: { field, value } });
    expect((await api(consent, undefined, false)).status).toBe(401);
    expect(await (await api(consent)).json()).toMatchObject({ enabled: false });
    expect((await set("recordings", true)).status).toBe(200);
    const { epoch } = await (await api(consent)).json();
    const row = { id: "rec-test-001", title: "Contract meeting", projectId: null, profileId, epoch, startedAt: epoch, stoppedAt: Date.now() };
    expect((await api(consent, { ...row, transcript: "Private transcript" })).status).toBe(400);
    expect((await api(consent, { ...row, profileId: "f".repeat(64) })).status).toBe(409);
    expect(await (await api(consent, row)).json()).toEqual({ added: 1 });
    expect(await (await api(consent, row)).json()).toEqual({ added: 0 });
    await readDay(date);
    const logged = async (): Promise<WorkdayEvidence[]> => JSON.parse(await readFile(join(owner.path + ".day-log", date + ".json"), "utf8")).observations;
    expect((await logged()).filter(item => item.proposal.source === "recordings")).toHaveLength(1);
    expect((await set("recordings", false)).status).toBe(200);
    await readDay(date);
    expect((await logged()).filter(item => item.proposal.source === "recordings")).toEqual([]);
    expect((await set("recordings", true)).status).toBe(200);
    expect((await api(consent, row)).status).toBe(409);
    expect((await set("enabled", false)).status).toBe(200);
    expect(await (await api(consent)).json()).toMatchObject({ enabled: false });
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
