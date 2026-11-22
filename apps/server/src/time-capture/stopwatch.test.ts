import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureStateSchema,
  captureChargeMinutes,
  stopwatchStateSchema,
  type StopwatchAction,
} from "@legalwork/types/time-capture";
import { proposedStopwatchCharge, resolveTimePolicy, TimesheetStateSchema } from "@legalwork/types/timesheet";
import { BackOfficeRecordSchema } from "../back-office/schema.js";
import { startServer } from "../server.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { originalBillingComparison } from "./original.js";
import { changeStopwatch, createStopwatchReader, emptyStopwatch, privateStopwatchSchema } from "./stopwatch.js";

test("timer polls reuse an unchanged snapshot and refresh it after an atomic write", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-timer-snapshot-"));
  try {
    const file = join(root, "profile.json"), replacement = join(root, "replacement.json");
    const read = createStopwatchReader();
    expect(await read(file)).toEqual({ active: null, lastStopped: null, enabled: true });
    await writeFile(file, JSON.stringify({ days: {} }));
    expect(await read(file)).toEqual({ active: null, lastStopped: null, enabled: true });
    const active = { id: randomUUID(), startedAt: "2026-11-17T10:00:00Z", matterId: null, zone: "UTC" };
    // Older workday sections do not need to pass the current schema for a read-only timer poll.
    const snapshot = { active, lastStopped: null, enabled: true };
    await writeFile(replacement, JSON.stringify({ days: { older: [] }, stopwatch: { ...snapshot, stoppedIds: [] } }));
    await rename(replacement, file);
    const running = await read(file);
    expect(running).toEqual(snapshot);
    expect(await read(file)).toBe(running);
    expect(await createStopwatchReader()(file)).toEqual(running);
    const other = join(root, "another-profile.json");
    expect(await read(other)).toEqual({ active: null, lastStopped: null, enabled: true });
    const assigned = { ...active, matterId: "mid-run" };
    await writeFile(replacement, JSON.stringify({ stopwatch: { active: assigned, lastStopped: null, stoppedIds: [] } }));
    await rename(replacement, file);
    expect(await read(file)).toEqual({ active: assigned, lastStopped: null, enabled: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing project-only timer keeps its clock until the user selects a matter", () => {
  const id = randomUUID(), start = "2026-11-17T12:00:00.000Z";
  const saved: Parameters<typeof changeStopwatch>[0] = {
    stopwatch: privateStopwatchSchema.parse({ active: { id, startedAt: start, projectId: "old-project", zone: "UTC" }, lastStopped: null, stoppedIds: [] }),
    days: {}, originals: {},
  };
  const end = new Date("2026-11-17T12:20:00.000Z");
  expect(() => changeStopwatch(saved, { type: "stop", id }, end, "UTC")).toThrow("Choose a matter");
  changeStopwatch(saved, { type: "assign", id, matterId: "chosen-matter" }, end, "UTC");
  changeStopwatch(saved, { type: "stop", id }, end, "UTC");
  expect(saved.days["2026-11-17"][0].proposal).toMatchObject({ startAt: start, matterId: "chosen-matter", projectId: null, workedMinutes: 20 });
});

test("stopwatch invoices round the exact interval once, retaining its raw timestamps and worked minutes", () => {
  const policy = resolveTimePolicy([], "", "", "2026-11-17");
  for (const { seconds, worked, up, nearest } of [
    { seconds: 601, worked: 10, up: 20, nearest: 10 },
    { seconds: 899, worked: 15, up: 20, nearest: 10 },
    { seconds: 900, worked: 15, up: 20, nearest: 20 },
    { seconds: 10, worked: null, up: 10, nearest: 0 },
  ]) {
    const saved: Parameters<typeof changeStopwatch>[0] = { stopwatch: emptyStopwatch(), days: {}, originals: {} };
    const id = randomUUID(), start = new Date("2026-11-17T10:00:00Z");
    const end = new Date(start.getTime() + seconds * 1000);
    changeStopwatch(saved, { type: "start", id, matterId: "m" }, start, "UTC");
    changeStopwatch(saved, { type: "stop", id }, end, "UTC");
    const proposal = saved.days["2026-11-17"][0].proposal;
    const minutes = captureChargeMinutes(proposal);
    expect(minutes).not.toBeNull();
    if (minutes === null) throw Error("Missing measured time");
    expect(proposedStopwatchCharge(minutes, policy)).toBe(up);
    expect(proposedStopwatchCharge(minutes, { ...policy, stopwatchRoundUp: false })).toBe(nearest);
    expect(proposal.workedMinutes).toBe(worked);
    expect(proposal.startAt).toBe(start.toISOString());
    expect(proposal.endAt).toBe(end.toISOString());
  }
});

test("stopwatch uses the start zone through midnight and the autumn clock change", () => {
  const saved: Parameters<typeof changeStopwatch>[0] = {
    stopwatch: emptyStopwatch(),
    days: {},
    originals: {},
  };
  const id = randomUUID();
  changeStopwatch(saved, { type: "start", id, matterId: "matter-one" }, new Date("2026-10-24T21:50:00Z"), "Europe/Vienna");
  changeStopwatch(saved, { type: "assign", id, matterId: "matter-two" }, new Date("2026-10-24T22:00:00Z"), "Europe/Vienna");
  changeStopwatch(saved, { type: "stop", id }, new Date("2026-10-26T00:05:00Z"), "America/New_York");
  expect(Object.keys(saved.days)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
  const proposals = Object.values(saved.days)
    .flat()
    .map((row) => row.proposal);
  expect(proposals.map((p) => p.workedMinutes)).toEqual([10, 1440, 60, 65]);
  expect(proposals.slice(1).map((p) => p.startAt)).toEqual(proposals.slice(0, -1).map((p) => p.endAt));
  expect(new Set(proposals.map((p) => p.key)).size).toBe(4);
  for (const p of proposals) {
    expect(originalBillingComparison(saved.originals[p.digest], p.digest)).toMatchObject({
      date: p.date,
      workedMinutes: p.workedMinutes,
    });
    expect(p.source).toBe("stopwatch");
    expect(p.matterId).toBe("matter-two");
    expect(p.projectId).toBeNull();
  }
  changeStopwatch(saved, { type: "stop", id }, new Date(), "UTC");
  changeStopwatch(saved, { type: "start", id, matterId: "matter-one" }, new Date(), "UTC");
  expect(saved.stopwatch.active).toBeNull();
  expect(Object.keys(saved.originals)).toHaveLength(4);
});

test("private stopwatch survives restart, concurrent stops and workday regeneration without enabling capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-timer-"));
  const config = backOfficeTestConfig(root, {
    workspaces: [{ id: "timer-project", name: "Timer test", workspaceType: "local", path: root, preset: "starter" }],
    authorizedRoots: [root],
  });
  let server = await startServer(config);
  const api = (suffix: string, action?: unknown, authorized = true) =>
    fetch("http://127.0.0.1:" + server.port + "/private-timesheet/" + suffix, {
      method: action === undefined ? "GET" : "POST",
      headers: authorized
        ? { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" }
        : { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
      body: action === undefined ? undefined : JSON.stringify(action),
    });
  try {
    expect((await api("stopwatch", undefined, false)).status).toBe(401);
    const initial = await api("stopwatch");
    expect(initial.headers.get("Cache-Control")).toBe("no-store");
    const directory = (route: string, body?: unknown) =>
      fetch("http://127.0.0.1:" + server.port + "/back-office/" + route, {
        method: body ? "POST" : "GET",
        headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    const record = async (objectId: string, values: unknown) => {
      const response = await directory("records?scope=local", { revision: 0, objectId, values });
      return BackOfficeRecordSchema.parse((await response.json()).record);
    };
    const client = await record("clients", { name: "Synthetic timer client" });
    const matter = await record("matters", { name: "Synthetic timer matter", clients: [client.id] });
    const secondMatter = await record("matters", { name: "Another matter", clients: [client.id] });
    const { profileId, active } = stopwatchStateSchema.parse(await initial.json());
    const { matters } = stopwatchStateSchema.parse(await (await api("stopwatch?includeMatters=1")).json());
    expect(matters?.map(m => m.id)).toContain(matter.id);
    expect(active).toBeNull();
    const endpoint = "stopwatch?profileId=" + profileId;
    const start: StopwatchAction = { type: "start", id: randomUUID(), matterId: matter.id };
    expect((await api("stopwatch?profileId=other", start)).status).toBe(409);
    expect((await api(endpoint, { ...start, matterId: "unavailable-matter" })).status).toBe(404);
    expect((await api(endpoint, { type: "start", id: start.id })).status).toBe(400);
    expect((await api(endpoint, { type: "start", id: start.id, projectId: "timer-project" })).status).toBe(400);
    const running = stopwatchStateSchema.parse(await (await api(endpoint, start)).json());
    expect(running.active?.id).toBe(start.id);
    expect((await api(endpoint, { ...start, id: randomUUID() })).status).toBe(409);
    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json())).toEqual(running);
    await writeEigenweltConnection(config, {
      account: { userId: "second-person", orgId: "fixture", orgName: "Fixture", orgRole: "org:member", userName: "Second", userEmail: null },
    });
    expect((await api(endpoint)).status).toBe(409);
    const other = stopwatchStateSchema.parse(await (await api("stopwatch")).json());
    expect(other.profileId).not.toBe(profileId);
    expect(other.active).toBeNull();
    await writeEigenweltConnection(config, { account: null });
    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json())).toEqual(running);

    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json())).toEqual(running);
    const assign: StopwatchAction = { type: "assign", id: start.id, matterId: secondMatter.id };
    expect((await api(endpoint, assign)).status).toBe(200);
    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json()).active?.matterId).toBe(secondMatter.id);
    expect((await api(endpoint, { ...assign, matterId: matter.id })).status).toBe(200);
    await server.stop();
    server = await startServer(config);
    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json())).toEqual(running);
    expect(stopwatchStateSchema.parse(await (await api(endpoint, start)).json())).toEqual(running);
    const stop: StopwatchAction = { type: "stop", id: start.id };
    const stopped = await Promise.all([api(endpoint, stop), api(endpoint, stop)]);
    const [first, retry] = await Promise.all(
      stopped.map(async (r) => stopwatchStateSchema.parse(await r.json())),
    );
    expect(first).toEqual(retry);
    expect(first.active).toBeNull();
    expect(first.lastStopped?.id).toBe(start.id);
    const date = first.lastStopped!.date;
    const workday =
      "workday?" +
      new URLSearchParams({ date, profileId, scope: "local", user: "local", principal: "" });
    const result = captureStateSchema.parse(await (await api(workday)).json());
    expect(result.settings).toMatchObject({ calendar: true, tasks: true, documents: true });
    expect(result.settings.aiSuggestions).not.toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      source: "stopwatch",
      projectId: null, matterId: matter.id,
      workedMinutes: null,
      activity: "",
      startAt: running.active!.startedAt,
      endAt: first.lastStopped!.stoppedAt,
    });
    const timesheet = "timesheet?scope=local&profileId=" + profileId;
    expect(TimesheetStateSchema.parse(await (await directory(timesheet)).json()).entries).toHaveLength(
      0,
    );
    const proposal = result.proposals[0];
    const confirm = {
      type: "create",
      source: "suggestion",
      requestId: proposal.key,
      proposalDigest: proposal.digest,
      entry: {
        date,
        narrative: "Reading",
        activity: "RES",
        clientId: client.id,
        matterId: matter.id,
        workedMinutes: 1,
        billable: false,
        billableMinutes: 0,
      },
    };
    const patch = { type: "draft-patch", key: proposal.key, date, proposalDigest: proposal.digest };
    const draftA = captureStateSchema.parse(await (await api(workday, { ...patch, revision: 0,
      changes: { narrative: "Reading" }, initial: { workflow: true },
    })).json()).drafts[proposal.key];
    const draftB = captureStateSchema.parse(await (await api(workday, { ...patch, revision: draftA.revision,
      changes: { narrative: "Reading revised attachments" },
    })).json()).drafts[proposal.key];
    const stale = await directory(timesheet + `&draftDate=${date}&draftRevision=${draftA.revision}`, confirm);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "private_draft_conflict", details: { draft: draftB } });
    expect((await directory(timesheet, confirm)).status).toBe(409);
    expect(TimesheetStateSchema.parse(await (await directory(timesheet)).json()).entries).toHaveLength(0);
    const reviewed = { ...confirm, entry: { ...confirm.entry, narrative: "Reading revised attachments" } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const booked = TimesheetStateSchema.parse(await (await directory(timesheet + `&draftDate=${date}&draftRevision=${draftB.revision}`, reviewed)).json());
      expect(booked.entries).toHaveLength(1);
      expect(booked.entries[0]).toMatchObject({
        status: "confirmed",
        proposalDigest: proposal.digest,
        workedMinutes: 1,
        narrative: reviewed.entry.narrative,
      });
    }
    const next = { type: "start", id: randomUUID(), matterId: matter.id };
    expect((await api(endpoint, next)).status).toBe(200);
    expect(stopwatchStateSchema.parse(await (await api(endpoint, stop)).json()).active?.id).toBe(
      next.id,
    );
    await api(workday, {
      type: "settings",
      settings: { calendar: true, tasks: false, intervalMinutes: 0 },
    });
    const prepared = captureStateSchema.parse(await (await api(workday, { type: "calendar" })).json());
    expect(prepared.proposals).toEqual([]);
    expect((await api(workday, { type: "dismiss", key: result.proposals[0].key })).status).toBe(409);
    const off = await api(workday, { type: "settings-patch", change: { field: "enabled", value: false } });
    expect(off.status).toBe(200);
    expect(stopwatchStateSchema.parse(await (await api(endpoint)).json()).enabled).toBe(false);
    expect((await api(endpoint, { type: "assign", id: next.id, matterId: secondMatter.id })).status).toBe(409);
    expect((await api(endpoint, { type: "stop", id: next.id })).status).toBe(200);
    expect((await api(endpoint, { ...next, id: randomUUID() })).status).toBe(409);
    expect(stopwatchStateSchema.parse(await (await api(endpoint + "&includeMatters=1")).json()).matters).toBeUndefined();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
