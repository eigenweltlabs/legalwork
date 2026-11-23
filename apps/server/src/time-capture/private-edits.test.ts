import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { BackOfficeRecordSchema } from "../back-office/schema.js";
import { captureProposalSchema, captureSettingsSchema, captureStateSchema, type CaptureAction } from "../back-office/timesheet-schema.js";
import { ApiError } from "../errors.js";
import { startServer } from "../server.js";
import { proposalCommitment } from "./original.js";
import { acceptPrivateProposal, captureProfile } from "./routes.js";

test("two workday windows preserve disjoint settings and draft edits, and detect changed or deleted drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-concurrent-workdays-"));
  const config = backOfficeTestConfig(root);
  const { path, profileId, scope, user, principal } = await captureProfile(config, await backOfficeAccess(config));
  const date = "2026-11-20", key = randomUUID();
  const legacySettings = captureSettingsSchema.parse({ calendar: true, tasks: true, documents: true, intervalMinutes: 0 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    settings: legacySettings, lastRun: 0, days: {},
    drafts: { [key]: { date, values: { billingNarrative: "Initial draft", recordedMinutes: 15 } } },
  }));
  const server = await startServer(config);
  const url = `http://127.0.0.1:${server.port}/private-timesheet/workday?` + new URLSearchParams({ date, profileId, scope, user, principal });
  function request(action?: CaptureAction) {
    return fetch(url, { method: action ? "POST" : "GET",
      body: action && JSON.stringify(action), headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" } });
  }
  async function read(action?: CaptureAction) {
    const response = await request(action);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return captureStateSchema.parse(body);
  }
  try {
    const [first, second] = await Promise.all([read(), read()]);
    await read({ type: "settings-patch", change: { field: "calendar", value: false } });
    await read({ type: "settings-patch", change: { field: "desktopActivity", value: true } });
    const settings = (await read({ type: "settings-patch", change: { field: "schedule", value: { frequency: "daily", times: ["17:30"] } } })).settings;
    expect(settings).toMatchObject({ calendar: false, desktopActivity: true, schedule: { frequency: "daily", times: ["17:30"] } });
    expect((await request({ type: "settings", settings: second.settings })).status).toBe(409);
    expect((await read()).settings).toEqual(settings);

    const status = () => fetch(new URL("/private-timesheet/activity", url), { headers: { "X-LegalWork-Host-Token": config.hostToken } }).then(response => response.json());
    await read({ type: "settings-patch", change: { field: "enabled", value: false } });
    expect(await status()).toMatchObject({ profileId, scope, principal, user, enabled: false, directoryId: expect.any(String) });
    expect((await request({ type: "suggest" })).status).toBe(409);
    await read({ type: "settings-patch", change: { field: "enabled", value: true } });
    expect(await status()).toMatchObject({ enabled: true });

    const edit: CaptureAction = { type: "draft-patch", key, date, revision: first.drafts[key].revision ?? 0, changes: { billingNarrative: "First window wording" } };
    const updated = (await read(edit)).drafts[key];
    const merged = (await read({ type: "draft-patch", key, date, revision: second.drafts[key].revision ?? 0, changes: { recordedMinutes: 30 } })).drafts[key];
    expect(merged.values).toEqual({ billingNarrative: "First window wording", recordedMinutes: 30 });
    expect(merged.revision).toBeGreaterThan(updated.revision ?? 0);
    // A lost response can be retried without undoing the other window's change.
    expect((await read(edit)).drafts[key]).toEqual(merged);
    const replaced = { ...edit, changes: { billingNarrative: "Second window wording" } };
    const sameField = await request(replaced);
    expect(sameField.status).toBe(409);
    expect(await sameField.json()).toMatchObject({ code: "private_draft_conflict", details: { draft: merged } });
    const resolved = (await read({ ...replaced, revision: merged.revision ?? 0 })).drafts[key];
    expect(resolved.values).toEqual({ billingNarrative: "Second window wording", recordedMinutes: 30 });
    expect((await request(edit)).status).toBe(409);
    expect((await request({ ...edit, changes: null })).status).toBe(409);
    const deletion = { ...edit, changes: null, revision: resolved.revision ?? 0 };
    expect((await read(deletion)).drafts[key]).toBeUndefined();
    expect((await read(deletion)).drafts[key]).toBeUndefined();
    expect((await request(edit)).status).toBe(409);
    expect((await request({ ...replaced, revision: resolved.revision ?? 0 })).status).toBe(409);
    expect((await read()).drafts[key]).toBeUndefined();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("private booking keeps confirmed draft revisions across manual publication and ambiguous proposal retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-booking-revision-"));
  const config = backOfficeTestConfig(root);
  const identity = await captureProfile(config, await backOfficeAccess(config));
  const { path, profileId, scope, user, principal } = identity;
  const date = "2026-11-20", key = randomUUID(), legacyKey = randomUUID();
  const proposal = captureProposalSchema.parse({ key: randomUUID(), digest: "0".repeat(64), date,
    source: "stopwatch", projectId: null, activity: "RES", narrative: "Timer original",
    startAt: null, endAt: null, workedMinutes: 4, dismissed: false });
  proposal.digest = proposalCommitment(proposal);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    settings: { calendar: false, tasks: false, intervalMinutes: 0 }, lastRun: 0,
    days: { [date]: [{ eventKey: "synthetic-stopwatch", proposal }] }, originals: { [proposal.digest]: proposal },
    drafts: { [legacyKey]: { date, revision: 1, values: { workflow: true, narrative: "Legacy interrupted row" } } },
    draftClocks: { [legacyKey]: { date, fields: {}, guarded: true, booking: { revision: 1, pending: true, target: "record" } } },
  }));
  const server = await startServer(config);
  const call = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
  });
  const workday = "/private-timesheet/workday?" + new URLSearchParams({ date, profileId, scope, user, principal });
  const records = "/back-office/records?scope=local";
  try {
    const record = async (objectId: string, values: unknown) => {
      const response = await call(records, { revision: 0, objectId, values });
      return BackOfficeRecordSchema.parse((await response.json()).record);
    };
    const client = await record("clients", { name: "Synthetic client" });
    const matter = await record("matters", { name: "Synthetic matter", clients: [client.id] });
    const draftValues = { name: "Manual draft", billingNarrative: "Manual draft", status: "Draft",
      matter: matter.id, client: client.id, serviceDate: date, startedAt: date, recordedMinutes: 15, billableMinutes: 15 };
    const legacyPatch = { type: "draft-patch", key: legacyKey, date, revision: 1, changes: { billingNarrative: "Recovered draft" } };
    expect((await call(workday, legacyPatch)).status).toBe(409);
    const legacyRejected = await call(records, { id: legacyKey, create: true, revision: 0, objectId: "timeEntries",
      values: { ...draftValues, matter: randomUUID() }, privateDraft: { profileId, date, revision: 1 } });
    expect(legacyRejected.status).toBe(400);
    expect((await call(workday, legacyPatch)).status).toBe(200);
    const draftPatch = { type: "draft-patch", key, date };
    const initial = captureStateSchema.parse(await (await call(workday, { ...draftPatch, revision: 0, changes: draftValues })).json()).drafts[key];
    const latest = captureStateSchema.parse(await (await call(workday, { ...draftPatch, revision: initial.revision,
      changes: { recordedMinutes: 20, billableMinutes: 20 },
    })).json()).drafts[key];
    const booking = { id: key, create: true, revision: 0, objectId: "timeEntries", values: draftValues,
      privateDraft: { profileId, date, revision: initial.revision } };
    const stale = await call(records, booking);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "private_draft_conflict", details: { draft: latest } });
    const reviewed = { ...booking, values: latest.values, privateDraft: { ...booking.privateDraft, revision: latest.revision } };
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = await call(records, reviewed);
      expect(saved.status).toBe(200);
      expect(BackOfficeRecordSchema.parse((await saved.json()).record).values.recordedMinutes).toBe(20);
    }
    expect((await call(workday, { ...draftPatch, revision: latest.revision, changes: { billingNarrative: "Do not restore" } })).status).toBe(409);
    expect(captureStateSchema.parse(await (await call(workday)).json()).drafts[key]).toBeUndefined();

    const proposalPatch = { ...draftPatch, key: proposal.key, proposalDigest: proposal.digest };
    const current = captureStateSchema.parse(await (await call(workday, { ...proposalPatch, revision: 0,
      changes: { narrative: "Reviewed timer wording" },
    })).json()).drafts[proposal.key];
    const expected = { date, revision: current.revision ?? 0 };
    await expect(acceptPrivateProposal(config, identity, proposal.key, proposal.digest, async () => {
      throw new ApiError(503, "synthetic_remote_timeout", "The remote acknowledgement was lost.");
    }, "workflow", expected)).rejects.toMatchObject({ status: 503 });
    const blocked = await call(workday, { ...proposalPatch, revision: expected.revision, changes: { narrative: "Unacknowledged wording" } });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "private_booking_pending" });
    expect((await call(workday, { ...proposalPatch, revision: expected.revision, changes: null })).status).toBe(409);
    const replay = await call(workday, { ...proposalPatch, revision: expected.revision, changes: {} });
    expect(replay.status).toBe(200);
    expect(captureStateSchema.parse(await replay.json()).drafts[proposal.key]).toEqual(current);
    await expect(acceptPrivateProposal(config, identity, proposal.key, proposal.digest,
      async () => "completed", "workflow", expected)).resolves.toBe("completed");
    expect(captureStateSchema.parse(await (await call(workday)).json()).drafts[proposal.key]).toBeUndefined();
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewed directory bookings accept manual minutes and preserve the private source for timed and untimed proposals", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-proposal-booked-minutes-"));
  const config = backOfficeTestConfig(root);
  const { path, profileId, scope, user, principal } = await captureProfile(config, await backOfficeAccess(config));
  const date = "2026-11-20";
  const proposals = [false, true].map(timed => {
    const proposal = captureProposalSchema.parse({
      key: randomUUID(), digest: "0".repeat(64), date,
      source: timed ? "calendar" : "documents", projectId: null, activity: "RES",
      narrative: timed ? "Original calendar source" : "Original document source",
      startAt: timed ? date + "T13:00:00Z" : null,
      endAt: timed ? date + "T13:30:00Z" : null,
      workedMinutes: timed ? 30 : null, dismissed: false,
    });
    return { ...proposal, digest: proposalCommitment(proposal) };
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    settings: { calendar: true, tasks: false, documents: true, intervalMinutes: 0 }, lastRun: 0,
    days: { [date]: proposals.map(proposal => ({ eventKey: proposal.key, proposal, generated: true })) },
    originals: Object.fromEntries(proposals.map(proposal => [proposal.digest, proposal])),
  }));
  const server = await startServer(config);
  const query = new URLSearchParams({ date, profileId, scope, user, principal });
  const records = "/back-office/records?scope=local";
  const workday = "/private-timesheet/workday?" + query;
  const call = (route: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}${route}`, {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    headers: { "X-LegalWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
  });
  const json = async (response: Response): Promise<unknown> => {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  const recordResult = z.object({ record: BackOfficeRecordSchema });
  const record = async (body: unknown) => recordResult.parse(await call(records, body).then(json)).record;
  try {
    const client = await record({ revision: 0, objectId: "clients", values: { name: "Synthetic client" } });
    const matter = await record({ revision: 0, objectId: "matters", values: { name: "Synthetic matter", clients: [client.id] } });
    for (const proposal of proposals) {
      const timed = proposal.startAt !== null;
      const recordedMinutes = timed ? 24 : 15;
      const values = {
        name: "Reviewed service", billingNarrative: "Reviewed service", status: "Draft",
        matter: matter.id, client: client.id, serviceDate: date, startedAt: proposal.startAt ?? date,
        endedAt: proposal.endAt, recordedMinutes: proposal.workedMinutes, billableMinutes: timed ? 20 : 10,
      };
      const patch = { type: "draft-patch", key: proposal.key, date, proposalDigest: proposal.digest };
      const initial = captureStateSchema.parse(await call(workday, { ...patch, revision: 0, changes: values }).then(json)).drafts[proposal.key];
      const changes = timed ? { recordedMinutes, startedAt: date, endedAt: null } : { recordedMinutes };
      const reviewed = captureStateSchema.parse(await call(workday, { ...patch, revision: initial.revision, changes }).then(json)).drafts[proposal.key];
      const publication = {
        id: proposal.key, create: true, revision: 0, objectId: "timeEntries", values: reviewed.values,
        privateProposal: { key: proposal.key, digest: proposal.digest, profileId, draftRevision: reviewed.revision },
      };
      const stale = await call(records, { ...publication, privateProposal: { ...publication.privateProposal, draftRevision: initial.revision } });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ code: "private_draft_conflict" });
      const saved = await record(publication);
      expect(saved.values).toMatchObject({ recordedMinutes, startedAt: date, endedAt: null, serviceDate: date });
      expect((await record(publication)).id).toBe(saved.id);
      expect(JSON.stringify(saved)).not.toContain(proposal.digest);

      const original = await call("/private-timesheet/original/" + proposal.digest + "?" + query).then(json);
      expect(original).toMatchObject({ digest: proposal.digest, narrative: proposal.narrative, workedMinutes: proposal.workedMinutes });
      const workdayAfterBooking = captureStateSchema.parse(await call(workday).then(json));
      expect(workdayAfterBooking.drafts[proposal.key]).toBeUndefined();
      expect(workdayAfterBooking.proposals.some(item => item.key === proposal.key)).toBe(false);
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
