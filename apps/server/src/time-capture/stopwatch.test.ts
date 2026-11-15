import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureStateSchema,
  stopwatchStateSchema,
  type StopwatchAction,
} from "@legalwork/types/time-capture";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import { BackOfficeRecordSchema } from "../back-office/schema.js";
import { startServer } from "../server.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { originalBillingComparison } from "./original.js";
import { changeStopwatch, emptyStopwatch } from "./stopwatch.js";

test("stopwatch uses the start zone through midnight and the autumn clock change", () => {
  const saved: Parameters<typeof changeStopwatch>[0] = {
    stopwatch: emptyStopwatch(),
    days: {},
    originals: {},
  };
  const id = randomUUID();
  changeStopwatch(saved, { type: "start", id }, new Date("2026-10-24T21:50:00Z"), "Europe/Vienna");
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
  }
  for (const type of ["stop", "start"] as const) changeStopwatch(saved, { type, id }, new Date(), "UTC");
  expect(saved.stopwatch.active).toBeNull();
  expect(Object.keys(saved.originals)).toHaveLength(4);
});

test("private stopwatch survives restart, concurrent stops and workday regeneration without enabling capture", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-timer-"));
  const config = backOfficeTestConfig(root);
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
    const { profileId, active } = stopwatchStateSchema.parse(await initial.json());
    expect(active).toBeNull();
    const endpoint = "stopwatch?profileId=" + profileId;
    const start: StopwatchAction = { type: "start", id: randomUUID() };
    expect((await api("stopwatch?profileId=other", start)).status).toBe(409);
    const running = stopwatchStateSchema.parse(await (await api(endpoint, start)).json());
    expect(running.active?.id).toBe(start.id);
    expect((await api(endpoint, { ...start, id: randomUUID() })).status).toBe(409);
    await server.stop();
    server = await startServer(config);
    expect(stopwatchStateSchema.parse(await (await api(endpoint, start)).json())).toEqual(running);
    const stop: StopwatchAction = { ...start, type: "stop" };
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
    expect(result.settings.calendar).toBe(false);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      source: "stopwatch",
      workedMinutes: null,
      activity: "",
      startAt: running.active!.startedAt,
      endAt: first.lastStopped!.stoppedAt,
    });
    const directory = (route: string, body?: unknown) =>
      fetch("http://127.0.0.1:" + server.port + "/back-office/" + route, {
        method: body ? "POST" : "GET",
        headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    const timesheet = "timesheet?scope=local&profileId=" + profileId;
    expect(TimesheetStateSchema.parse(await (await directory(timesheet)).json()).entries).toHaveLength(
      0,
    );
    const record = async (objectId: string, values: unknown) => {
      const response = await directory("records?scope=local", { revision: 0, objectId, values });
      return BackOfficeRecordSchema.parse((await response.json()).record);
    };
    const client = await record("clients", { name: "Synthetic timer client" });
    const matter = await record("matters", { name: "Synthetic timer matter", clients: [client.id] });
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const booked = TimesheetStateSchema.parse(await (await directory(timesheet, confirm)).json());
      expect(booked.entries).toHaveLength(1);
      expect(booked.entries[0]).toMatchObject({
        status: "confirmed",
        proposalDigest: proposal.digest,
        workedMinutes: 1,
      });
    }
    const next = { type: "start", id: randomUUID() };
    expect((await api(endpoint, next)).status).toBe(200);
    expect(stopwatchStateSchema.parse(await (await api(endpoint, stop)).json()).active?.id).toBe(
      next.id,
    );
    await api(workday, {
      type: "settings",
      settings: { calendar: true, tasks: false, intervalMinutes: 0 },
    });
    const prepared = captureStateSchema.parse(await (await api(workday, { type: "calendar" })).json());
    expect(prepared.proposals).toEqual(result.proposals);
    await api(workday, { type: "dismiss", key: result.proposals[0].key });
    expect(
      captureStateSchema.parse(await (await api(workday, { type: "calendar" })).json()).proposals,
    ).toEqual([]);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
