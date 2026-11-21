import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficeTestConfig } from "../back-office/config.test-support.js";
import { captureStateSchema, TimesheetStateSchema, type CaptureAction } from "../back-office/timesheet-schema.js";
import { startServer } from "../server.js";
import { acceptPrivateProposal, captureProfile, rememberAcceptedDocumentEdit } from "./routes.js";
import { digest } from "./private-workday.js";
import { randomUUID } from "node:crypto";
import type { CaptureProposal, WorkdayCorrection } from "@legalwork/types/time-capture";
import type { DraftStore } from "./private-edits.js";
import { modelEvidence } from "./workday-context.js";
import { privateInstructionSchema } from "./document-terminology.js";
import { z } from "zod";
import { correctWorkday } from "./correct-workday.js";
import { originalBillingComparison, proposalCommitment } from "./original.js";

function sample(timed: boolean) {
  const parent: CaptureProposal = {
    key: randomUUID(),
    digest: "",
    date: "2026-11-12",
    source: "calendar",
    narrative: "Original",
    activity: "EXM",
    projectId: "project",
    startAt: timed ? "2026-11-12T09:00:00Z" : null,
    endAt: timed ? "2026-11-12T09:30:00Z" : null,
    workedMinutes: timed ? 30 : null,
    dismissed: false,
  };
  parent.digest = proposalCommitment(parent);
  const saved = {
    draftClocks: {},
    originals: { [parent.digest]: parent },
    days: { [parent.date]: [{ eventKey: "calendar", proposal: parent }] },
    drafts: { [parent.key]: { date: parent.date, values: { workflow: true, worked: "30" }, proposalDigest: parent.digest } },
  };
  const edit: WorkdayCorrection = {
    type: "correct",
    key: parent.key,
    digest: parent.digest,
    narrative: "Edited",
    matterId: "m1",
    projectId: "project",
    startAt: parent.startAt,
    endAt: parent.endAt,
    workedMinutes: parent.workedMinutes,
  };
  return { saved, parent, edit };
}
test("private split moves last 12 minutes, gives distinct stable identities and binds both to the first proposal", () => {
  const { saved, parent, edit } = sample(true);
  edit.split = { matterId: "m2", projectId: null, minutes: 12 };
  correctWorkday(saved, parent.date, edit, "Europe/Vienna");
  const [first, second] = saved.days[parent.date].map((item) => item.proposal);
  expect(first.key).toBe(parent.key);
  expect(second.key).not.toBe(first.key);
  expect(saved.drafts[first.key]).toMatchObject({ proposalDigest: first.digest, values: { workflow: true } });
  expect(saved.drafts[second.key]).toBeUndefined();
  expect(first).toMatchObject({
    startAt: parent.startAt,
    endAt: "2026-11-12T09:18:00.000Z",
    workedMinutes: 18,
    matterId: "m1",
  });
  expect(second).toMatchObject({
    startAt: first.endAt,
    endAt: parent.endAt,
    workedMinutes: 12,
    matterId: "m2",
  });
  for (const p of [first, second])
    expect(originalBillingComparison(saved.originals[p.digest], p.digest, saved.originals)).toEqual({
      digest: p.digest,
      originalDigest: parent.digest,
      date: parent.date,
      workedMinutes: 30,
      narrative: "Original",
      activity: "EXM",
    });
  expect(() => correctWorkday(saved, parent.date, edit, "Europe/Vienna")).toThrow(/Refresh/);
  expect(saved.days[parent.date]).toHaveLength(2);
});
test("a split preserves the bill-to on the original segment with the same inferred matter", () => {
  const { saved, parent, edit } = sample(true);
  const store: Omit<typeof saved, keyof DraftStore> & DraftStore = { ...saved,
    drafts: { [parent.key]: { date: parent.date, proposalDigest: parent.digest, revision: 2,
      values: { matter: "m1", client: "reviewed-client", recordedMinutes: 30, billableMinutes: 12 } } },
  };
  correctWorkday(store, parent.date, { ...edit, draftRevision: 2,
    split: { matterId: "m2", projectId: null, minutes: 10 } }, "UTC",
    (proposal, second) => (proposal.workedMinutes ?? 0) - Number(second),
    proposal => proposal.matterId ?? (proposal.projectId === "project" ? "m1" : undefined));
  const [first, moved] = store.days[parent.date].map(item => item.proposal);
  expect(store.drafts[first.key]).toMatchObject({ revision: 3, proposalDigest: first.digest,
    values: { matter: "m1", client: "reviewed-client" } });
  expect(store.drafts[first.key].values).not.toHaveProperty("billableMinutes");
  expect(store.drafts[moved.key]).toBeUndefined();
  expect(first).toMatchObject({ workedMinutes: 20, chargeMinutes: 20 });
  expect(moved).toMatchObject({ workedMinutes: 10, chargeMinutes: 9 });
});

test("unknown durations remain unknown, explicit durations can be split without inventing clock time", () => {
  const { saved, parent, edit } = sample(false);
  correctWorkday(saved, parent.date, edit, "Europe/Vienna");
  const updated = saved.days[parent.date][0].proposal;
  expect(updated.workedMinutes).toBeNull();
  expect(updated.startAt).toBeNull();
  correctWorkday(
    saved,
    parent.date,
    {
      ...edit,
      digest: updated.digest,
      draftRevision: 1,
      workedMinutes: 20,
      split: { minutes: 12, matterId: "m2", projectId: null },
    },
    "Europe/Vienna",
  );
  expect(
    saved.days[parent.date].map((x) => [x.proposal.workedMinutes, x.proposal.startAt, x.proposal.endAt]),
  ).toEqual([
    [8, null, null],
    [12, null, null],
  ]);
});
test("range changes with a negative, incomplete, cross-day, or mismatched duration fail before modifying the original", () => {
  for (const fields of [
    { endAt: null },
    { endAt: "2026-11-11T12:00:00Z" },
    { endAt: "2026-11-13T01:00:00Z" },
    { workedMinutes: 29 },
  ]) {
    const { saved, parent, edit } = sample(true);
    expect(() => correctWorkday(saved, parent.date, { ...edit, ...fields }, "Europe/Vienna")).toThrow();
    expect(saved.days[parent.date][0].proposal).toBe(parent);
  }
});
test("a sub-minute stopwatch correction keeps the recorded clocks and null rounded minutes", () => {
  const { saved, parent, edit } = sample(true);
  parent.source = "stopwatch";
  correctWorkday(saved, parent.date, { ...edit, endAt: "2026-11-12T09:00:14Z", workedMinutes: null }, "UTC");
  expect(saved.days[parent.date][0].proposal).toMatchObject({
    startAt: "2026-11-12T09:00:00Z", endAt: "2026-11-12T09:00:14Z", workedMinutes: null,
  });
});

test("a private activity correction retains, replaces, or clears the code through refresh and acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-activity-"));
  const config = backOfficeTestConfig(root);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const owner = await captureProfile(config, await backOfficeAccess(config));
    const { parent, edit } = sample(false);
    const proposal = { ...parent, projectId: null };
    proposal.digest = proposalCommitment(proposal);
    await mkdir(dirname(owner.path), { recursive: true });
    await writeFile(owner.path, JSON.stringify({
      lastRun: 0,
      settings: { aiSuggestions: true, calendar: true, tasks: false, connections: [], intervalMinutes: 0 },
      days: { [proposal.date]: [{ eventKey: "calendar", generated: true, proposal }] },
      originals: { [proposal.digest]: proposal },
    }));
    const { profileId, scope, user, principal } = owner;
    const context = new URLSearchParams({ date: proposal.date, profileId, scope, user, principal });
    const request = async (action?: CaptureAction) => {
      const response = await fetch(`http://127.0.0.1:${server?.port}/private-timesheet/workday?${context}`, {
        method: action ? "POST" : "GET",
        headers: { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" },
        body: action ? JSON.stringify(action) : undefined,
      });
      expect(response.status).toBe(200);
      return captureStateSchema.parse(await response.json());
    };
    server = await startServer(config);
    const correction = { ...edit, projectId: null, matterId: null, digest: proposal.digest };
    const [retained] = (await request(correction)).proposals;
    expect(retained.activity).toBe("EXM");
    const [replaced] = (await request({ ...correction, digest: retained.digest, activity: "RES" })).proposals;
    expect(replaced.activity).toBe("RES");
    const [cleared] = (await request({ ...correction, digest: replaced.digest, activity: null })).proposals;
    expect(cleared).toMatchObject({ key: proposal.key, activity: "", parentDigest: replaced.digest });
    await server.stop();
    server = await startServer(config);
    expect((await request()).proposals[0]).toMatchObject({ digest: cleared.digest, activity: "" });
    const refreshed = await request({ type: "refresh", model: { workspaceId: "empty", providerID: "fixture", modelID: "fixture" } });
    expect(refreshed.status?.type).toBe("ready");
    expect(refreshed.proposals[0]).toMatchObject({ digest: cleared.digest, activity: "" });
    await expect(acceptPrivateProposal(config, owner, proposal.key, replaced.digest, async () => true)).rejects.toMatchObject({ status: 409 });
    await expect(acceptPrivateProposal(config, owner, proposal.key, cleared.digest, async () => "booked")).resolves.toBe("booked");
    expect((await request()).proposals).toEqual([]);
    const persisted = JSON.parse(await readFile(owner.path, "utf8"));
    expect(persisted.accepted[proposal.key]).toBe(cleared.digest);
    expect(persisted.originals[cleared.digest].activity).toBe("");
    expect(persisted.originals[proposal.digest].activity).toBe("EXM");
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("booking only the current private segment serializes a stale draft, preserving safe idempotent retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-split-"));
  try {
    const config = backOfficeTestConfig(root);
    const { saved, parent, edit } = sample(true);
    edit.split = { minutes: 12, matterId: "second", projectId: null };
    correctWorkday(saved, parent.date, edit, "Europe/Vienna");
    const dir = join(root, "private-timesheets"),
      path = join(dir, digest(["local", "local"]) + ".json");
    await mkdir(dir);
    await writeFile(
      path,
      JSON.stringify({
        ...saved,
        lastRun: 0,
        settings: { calendar: true, tasks: false, intervalMinutes: 0 },
      }),
    );
    const identity = {
        user: "local",
        principal: "",
        scope: "local",
        profileId: digest(["local", "local"]),
      },
      booked = new Set<string>();
    const issue = (key: string, hash: string) =>
      acceptPrivateProposal(config, identity, key, hash, async () => {
        booked.add(key);
        return "ok";
      }, "workflow", key === parent.key ? { revision: 1 } : undefined);
    await expect(issue(parent.key, parent.digest)).rejects.toMatchObject({ status: 409 });
    expect(booked.size).toBe(0);
    const [rest, moved] = saved.days[parent.date].map((x) => x.proposal);
    await issue(rest.key, rest.digest);
    await issue(rest.key, rest.digest);
    await issue(moved.key, moved.digest);
    expect(booked.size).toBe(2);
    expect(JSON.parse(await readFile(path, "utf8")).accepted).toEqual({
      [rest.key]: rest.digest,
      [moved.key]: moved.digest,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepting a document proposal binds its local file UUID to the confirmed work product within the profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-document-binding-"));
  try {
    const config = backOfficeTestConfig(root);
    const { parent, saved } = sample(false);
    const documentId = randomUUID(), workProductId = randomUUID(), matterId = randomUUID();
    const proposal = { ...parent, source: "documents" as const, documentId, activity: "MOD" };
    proposal.digest = proposalCommitment(proposal);
    saved.days[parent.date][0].proposal = proposal;
    saved.originals[proposal.digest] = proposal;
    const profileId = digest(["local", "local"]), dir = join(root, "private-timesheets");
    const path = join(dir, profileId + ".json");
    await mkdir(dir);
    await writeFile(path, JSON.stringify({ ...saved, lastRun: 0,
      settings: { calendar: false, tasks: false, documents: true, intervalMinutes: 0 } }));
    await acceptPrivateProposal(config, { user: "local", principal: "", scope: "local", profileId }, proposal.key, proposal.digest, async () => ({
      entries: [{ groupId: proposal.key, proposalDigest: proposal.digest, workerId: "local", matterId, workProductId, status: "confirmed" }],
      products: [{ id: workProductId, matterId }],
    }));
    expect(JSON.parse(await readFile(path, "utf8")).fileProducts).toEqual({ [documentId]: { [matterId]: workProductId } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a source correction rebases independent reviewed fields and rejects a stale form", () => {
  const { saved, parent, edit } = sample(true);
  const matterId = "m1";
  parent.matterId = matterId;
  parent.chargeMinutes = 30;
  parent.digest = proposalCommitment(parent);
  const values = { billingNarrative: "Reviewed", billableMinutes: 12, client: "client", matter: matterId,
    recordedMinutes: 30, startedAt: parent.startAt, endedAt: parent.endAt };
  const store: Omit<typeof saved, keyof DraftStore> & DraftStore = { ...saved, drafts: { [parent.key]: { date: parent.date, values, revision: 3, proposalDigest: parent.digest } },
    draftClocks: { [parent.key]: { date: parent.date, fields: { billableMinutes: 2, client: 3 }, guarded: true, proposalDigest: parent.digest } } };
  const correction = { ...edit, digest: parent.digest, matterId, draftRevision: 2 };
  expect(() => correctWorkday(store, parent.date, correction, "UTC"))
    .toThrow(/changed in another window/);
  expect(store.days[parent.date][0].proposal).toBe(parent);
  expect(store.drafts[parent.key].values).toEqual(values);
  correctWorkday(store, parent.date, { ...correction, draftRevision: 3 }, "UTC", () => 30);
  const proposal = store.days[parent.date][0].proposal;
  expect(store.drafts[parent.key]).toMatchObject({ proposalDigest: proposal.digest, revision: 4,
    values: { billableMinutes: 12, client: "client", recordedMinutes: 30 } });
  expect(store.drafts[parent.key].values).not.toHaveProperty("billingNarrative");
  correctWorkday(store, parent.date, { ...correction, digest: proposal.digest, draftRevision: 4,
    startAt: "2026-11-12T09:05:00Z", workedMinutes: 25 }, "UTC", () => 25);
  expect(store.drafts[parent.key].values).toEqual({ client: "client", matter: matterId });
  const revised = store.days[parent.date][0].proposal;
  expect(revised).toMatchObject({ chargeMinutes: 25, workedMinutes: 25 });
  correctWorkday(store, parent.date, { ...correction, digest: revised.digest, draftRevision: 5,
    matterId: "other-matter", startAt: revised.startAt, workedMinutes: 25 }, "UTC", () => 30);
  expect(store.drafts[parent.key].values).toEqual({});
});

test("workflow draft amount and work-product fields rebase with source changes", () => {
  const { saved, parent, edit } = sample(true);
  parent.matterId = "m1";
  parent.digest = proposalCommitment(parent);
  const values = { workflow: true, worked: "30", billableWork: "28", nonBillable: "2", billable: true,
    charge: "12", manualCharge: true, product: "Old product", productId: "old-product", createProduct: false };
  const store: Omit<typeof saved, keyof DraftStore> & DraftStore = {
    ...saved, drafts: { [parent.key]: { date: parent.date, values, revision: 1, proposalDigest: parent.digest } },
  };
  correctWorkday(store, parent.date, { ...edit, digest: parent.digest, draftRevision: 1,
    startAt: "2026-11-12T09:05:00Z", workedMinutes: 25 }, "UTC", () => 25);
  expect(store.drafts[parent.key].values).toEqual({ workflow: true, product: "Old product", productId: "old-product", createProduct: false });
  const current = store.days[parent.date][0].proposal;
  correctWorkday(store, parent.date, { ...edit, digest: current.digest, draftRevision: 2, matterId: "m2",
    startAt: current.startAt, workedMinutes: 25 }, "UTC", () => 25);
  expect(store.drafts[parent.key].values).toEqual({ workflow: true });
});

test("confirmed human wording teaches a stable document across a rename and a later edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-private-document-wording-"));
  try {
    const config = backOfficeTestConfig(root);
    const access = await backOfficeAccess(config);
    const owner = await captureProfile(config, access);
    const documentId = randomUUID(), matterId = "matter", otherMatter = "other";
    const { parent } = sample(false);
    const proposal = { ...parent, source: "documents" as const, documentId, matterId, narrative: "Bearbeiten Revision" };
    proposal.digest = proposalCommitment(proposal);
    const other = { ...proposal, key: randomUUID(), documentId: randomUUID() };
    other.digest = proposalCommitment(other);
    await mkdir(dirname(owner.path), { recursive: true });
    await writeFile(owner.path, JSON.stringify({
      lastRun: 0, settings: { calendar: false, tasks: false, documents: true, intervalMinutes: 0 },
      days: { [proposal.date]: [{ eventKey: "first", proposal, sourceDocumentTitle: "Revision", generated: true },
        { eventKey: "other", proposal: other, sourceDocumentTitle: "Appeal", generated: true }] },
      originals: { [proposal.digest]: proposal, [other.digest]: other },
      drafts: { [proposal.key]: { date: proposal.date, proposalDigest: proposal.digest, revision: 1, values: {
        billingNarrative: "Bearbeiten Rekurs",
      } } },
      draftClocks: { [proposal.key]: { date: proposal.date, proposalDigest: proposal.digest, fields: { billingNarrative: 1 }, guarded: true } },
    }));
    const book = (p: CaptureProposal, narrative: string, revision?: number) =>
      acceptPrivateProposal(config, owner, p.key, p.digest, async () => ({
        record: { id: p.key, objectId: "timeEntries", values: { matter: matterId, billingNarrative: narrative } },
      }), "record", revision === undefined ? undefined : { revision });
    await book(proposal, "Bearbeiten Rekurs", 1);
    await book(other, "Bearbeiten Modellvermutung");
    const readExamples = async () => Object.values(z.record(z.string(), privateInstructionSchema)
      .parse(JSON.parse(await readFile(owner.path, "utf8")).instructions));
    expect(await readExamples()).toMatchObject([{ documentId, matterId, kind: "wording-example",
      text: "Bearbeiten Rekurs", replacement: { from: "Revision", to: "Rekurs" } }]);
    const state = TimesheetStateSchema.parse({
      scope: "local", userId: "local", canManage: true, canReview: true, clients: [],
      matters: [{ id: matterId, name: "Matter", reference: "", clientIds: [] },
        { id: otherMatter, name: "Other", reference: "", clientIds: [] }],
      people: [], entries: [], products: [], invoices: [], policies: [], projects: [],
    });
    const renamed = { ...proposal, projectId: null, narrative: "Renamed.docx" };
    const modelContext = async () => modelEvidence([
      { eventKey: "same-document", proposal: renamed },
      { eventKey: "different-document", proposal: { ...renamed, documentId: other.documentId } },
      { eventKey: "different-matter", proposal: { ...renamed, matterId: otherMatter } },
    ], state, [], await readExamples(), proposal.date);
    expect((await modelContext()).map(ref => ref.documentTitle)).toEqual(["Rekurs", "Renamed", "Renamed"]);
    await rememberAcceptedDocumentEdit(config, access, { key: other.key, matterId,
      before: "Drafting Appeal", after: "Reviewing Appeal" });
    expect((await modelContext())[1]).toMatchObject({ documentTitle: "Renamed", confirmedWording: ["Reviewing Appeal"], terminology: [] });
    await rememberAcceptedDocumentEdit(config, access, { key: proposal.key, matterId,
      before: "Bearbeiten Rekurs", after: "Bearbeiten Berufung" });
    expect((await modelContext()).map(ref => ref.documentTitle)).toEqual(["Berufung", "Renamed", "Renamed"]);
    await rememberAcceptedDocumentEdit(config, access, { key: proposal.key, matterId,
      before: "Bearbeiten Berufung", after: "Prüfen Berufung" });
    expect((await modelContext())[0]).toMatchObject({ documentTitle: "Berufung", confirmedWording: ["Prüfen Berufung"] });
    await rememberAcceptedDocumentEdit(config, access, { key: proposal.key, matterId,
      before: "Bearbeiten Berufung", after: "Entwurf des außerordentlichen Revisionsrekurses überarbeiten" });
    expect((await modelContext()).map(ref => ref.confirmedWording)).toEqual([
      ["Entwurf des außerordentlichen Revisionsrekurses überarbeiten"], ["Reviewing Appeal"], undefined,
    ]);
    const actualRecord = randomUUID();
    const linked = JSON.parse(await readFile(owner.path, "utf8"));
    linked.reconciled = { [other.key]: actualRecord };
    await writeFile(owner.path, JSON.stringify(linked));
    await rememberAcceptedDocumentEdit(config, access, { key: actualRecord, matterId, reconciledOnly: true,
      before: "Reviewing Appeal", after: "Reviewing Motion" });
    expect((await modelContext())[1]).toMatchObject({ documentTitle: "Motion", confirmedWording: ["Reviewing Motion"] });
    const ambiguous = JSON.parse(await readFile(owner.path, "utf8"));
    ambiguous.reconciled[proposal.key] = actualRecord;
    await writeFile(owner.path, JSON.stringify(ambiguous));
    await rememberAcceptedDocumentEdit(config, access, { key: actualRecord, matterId, reconciledOnly: true,
      before: "Reviewing Motion", after: "Reviewing Brief" });
    expect((await modelContext())[1]).toMatchObject({ documentTitle: "Motion", confirmedWording: ["Reviewing Motion"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
