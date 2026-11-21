import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TimeDraft, TimeEntry, TimePolicy, TimesheetCommand } from "@legalwork/types/timesheet";
import { openSqlite } from "../runtime-db.js";
import type { BackOfficeActor } from "./schema.js";
import { BackOfficeStore } from "./store.js";
import { readTimeDocument, readTimesheet, writeEntry } from "./timesheet-data.js";
import { commandTimesheet } from "./timesheet.js";
import { approveInvoice, prepareInvoice } from "./timesheet-invoice.test-support.js";

const reviewer = { userId: "reviewer", edit: true, finance: true, model: true };
const worker = { userId: "worker", edit: true, finance: false, model: false };
const people = [reviewer, worker].map(({ userId }) => ({ id: userId, name: userId }));
const scope = "local";
const entryRef = ({ id, revision }: TimeEntry) => ({ id, revision });
const stores: BackOfficeStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

async function fixture(terms: Pick<TimePolicy, "hourlyRate" | "currency"> = {}) {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  stores.push(store);
  const client = store.saveRecord(scope, reviewer, {
    objectId: "clients", revision: 0, values: { name: "Client", billingAddress: "Testgasse 5, 1010 Wien" },
  });
  const matter = store.saveRecord(scope, reviewer, {
    objectId: "matters", revision: 0, values: { name: "Matter", clients: [client.id] },
  });
  const run = (actor: BackOfficeActor, input: TimesheetCommand) =>
    commandTimesheet(store, scope, actor, people, input);
  const read = (actor: BackOfficeActor, forMutation = false) =>
    readTimesheet(store, scope, actor, people, [], forMutation);
  const policy: TimePolicy = {
    scope: "firm", targetId: "firm", effectiveFrom: "2026-01-01", revision: 0,
    reviewerId: reviewer.userId, ...terms,
  };
  run(reviewer, { type: "policy", policy });
  const draft: TimeDraft = {
    date: "2026-11-01", activity: "RES", narrative: "Research", matterId: matter.id,
    clientId: client.id, billable: true, workedMinutes: 60, billableMinutes: 60,
  };
  const submit = (overrides: Partial<TimeDraft> = {}) => {
    const entries = run(worker, { type: "create", requestId: randomUUID(), entry: { ...draft, ...overrides } }).entries;
    const created = entries.find((e) => e.status === "confirmed")!;
    run(worker, { type: "submit", entries: [entryRef(created)] });
    return read(reviewer).entries.find((e) => e.id === created.id)!;
  };
  const approve = (entry: TimeEntry) =>
    run(reviewer, { type: "approve", entries: [entryRef(entry)] }).entries.find((e) => e.id === entry.id)!;
  return { store, client, matter, run, read, policy, submit, approve };
}

test("issue uses the approved price and correction despite retroactive terms, and keeps access checks", async () => {
  const { store, matter, run, read, policy, submit, approve } = await fixture({ hourlyRate: 300, currency: "EUR" });
  const line = approve(submit());
  const correction = run(worker, {
    type: "adjust", ...entryRef(line), requestId: randomUUID(), reason: "Time checked",
    narrative: "Research and analysis", billableMinutes: 50,
  }).adjustments![0];
  const invoice = prepareInvoice([line]);
  expect(() => run(worker, invoice)).toThrow(/Billing access/);
  expect(() => run(reviewer, invoice)).toThrow(/pending corrections/);
  const reviewed = run(reviewer, {
    type: "decideAdjustment", id: correction.id, revision: correction.revision, approve: true,
  }).adjustments![0];
  run(reviewer, { type: "policy", policy: {
    ...policy, revision: 1, hourlyRate: 700, currency: "USD", maxMinutes: 30, incrementMinutes: 15,
  } });
  expect(() => run(reviewer, invoice)).toThrow(/approved corrections changed/);
  const updated = prepareInvoice([line], [{ id: reviewed.id, revision: reviewed.revision }]);
  store.saveRecord(scope, reviewer, { ...matter, archived: true, values: {} });
  expect(() => run(reviewer, updated)).toThrow(/unavailable/);
  const archived = store.raw(scope, matter.id)!;
  store.saveRecord(scope, reviewer, { ...archived, archived: false, values: {} });
  const current = run(reviewer, updated);
  const issued = run(reviewer, approveInvoice((command) => run(reviewer, command), current)).invoices[0];
  expect(issued).toMatchObject({ currency: "EUR", total: 250 });
  expect(issued.entries[0]).toMatchObject({
    revision: line.revision, workedMinutes: 60, billableMinutes: 50, hourlyRate: 300, narrative: "Research and analysis",
  });
  const artifact = readTimeDocument(store, scope, issued.id);
  const invoiced = read(reviewer).entries[0];
  expect(() => run(reviewer, { type: "return", entries: [entryRef(invoiced)], reason: "Review again" })).toThrow(/submitted/);
  const later = run(worker, {
    type: "adjust", ...entryRef(invoiced), requestId: randomUUID(), reason: "Further correction",
    narrative: "Updated description", billableMinutes: 30,
  }).adjustments!.find((a) => a.status === "pending")!;
  const postIssue = run(reviewer, {
    type: "decideAdjustment", id: later.id, revision: later.revision, approve: true,
  }).adjustments!.find((a) => a.id === later.id)!;
  expect(postIssue).toMatchObject({ invoiceId: issued.id, deltaAmount: -100, currency: "EUR" });
  expect(postIssue.noteNumber).toBe(`${issued.number}-C1`);
  expect(readTimeDocument(store, scope, issued.id)).toEqual(artifact);
});

test.each([{ currency: "EUR" }, { hourlyRate: 300 }])("hourly approval requires both pricing fields (%j)", async (terms) => {
  const { submit, approve, read, run, policy } = await fixture(terms);
  const line = submit();
  expect(() => approve(line)).toThrow(/hourly rate and currency/);
  expect(read(reviewer).entries[0]).toEqual(line);
  run(reviewer, { type: "policy", policy: { ...policy, revision: 1, hourlyRate: 300, currency: "EUR" } });
  expect(() => approve(line)).toThrow(/applicable billing terms changed/);
});

test.each(["Flat fee", "Flat fee with included time", "RVG"])("%s time remains approvable without hourly pricing", async (basis) => {
  const { store, matter, run, submit, approve } = await fixture({ hourlyRate: 300, currency: "EUR" });
  const agreement = store.saveRecord(scope, reviewer, {
    objectId: "feeAgreements", revision: 0, values: { name: "Agreement", matter: matter.id, basis },
  });
  const approved = approve(submit());
  expect(approved.status).toBe("approved");
  expect(approved.nonHourlyApproval).toBe(true);
  expect(approved.hourlyRate).toBeUndefined();
  store.saveRecord(scope, reviewer, { ...agreement, archived: true, values: {} });
  expect(() => run(reviewer, prepareInvoice([approved]))).toThrow(/approved, priced/);
  expect(() => run(reviewer, { type: "return", entries: [entryRef(approved)], reason: "Review price" })).toThrow(/submitted/);
});

test("changing the agreement basis after submission requires a fresh review", async () => {
  const { store, matter, run, read, submit, approve } = await fixture();
  const agreement = store.saveRecord(scope, reviewer, {
    objectId: "feeAgreements", revision: 0, values: { name: "Agreement", matter: matter.id, basis: "Hourly" },
  });
  const submitted = submit();
  store.saveRecord(scope, reviewer, { ...agreement, values: { basis: "Flat fee" } });
  expect(() => approve(submitted)).toThrow(/applicable billing terms changed/);

  run(reviewer, {
    type: "return", entries: [entryRef(submitted)], reason: "The agreement now uses a flat fee",
  });
  const returned = read(worker).entries[0];
  const resubmitted = run(worker, { type: "submit", entries: [entryRef(returned)] }).entries[0];
  expect(approve(resubmitted).nonHourlyApproval).toBe(true);
});

test("a historical unpriced approval is returned and reviewed at a new revision, retaining corrections and history", async () => {
  const { store, run, read, policy, submit, approve, client, matter } = await fixture();
  const line = submit();
  // Store the approval produced by versions of the workflow before pricing was required.
  const oldApproval: TimeEntry = { ...line, status: "approved" };
  store.transaction(() => writeEntry(store, scope, reviewer, line, oldApproval, "approve"), {
    actor: reviewer, action: "timesheet.approve",
  });
  const pending = run(worker, {
    type: "adjust", ...entryRef(oldApproval), requestId: randomUUID(), reason: "Corrected time",
    narrative: "Additional analysis", billableMinutes: 50,
  }).adjustments![0];
  const sendBack: TimesheetCommand = { type: "return", entries: [entryRef(oldApproval)], reason: "Apply agreed price" };
  expect(() => run(worker, sendBack)).toThrow(/independent/);
  expect(() => run(reviewer, sendBack)).toThrow(/pending corrections/);
  const correction = run(reviewer, {
    type: "decideAdjustment", id: pending.id, revision: pending.revision, approve: true,
  }).adjustments![0];
  expect(correction.deltaAmount).toBeNull();
  run(reviewer, { type: "policy", policy: { ...policy, revision: 1, hourlyRate: 300, currency: "EUR" } });
  const invoice = prepareInvoice([oldApproval], [{ id: correction.id, revision: correction.revision }]);
  expect(() => run(reviewer, invoice)).toThrow(/approved, priced/);
  run(reviewer, sendBack);
  const returned = read(worker, true).entries[0];
  expect(returned).toMatchObject({
    status: "confirmed", revision: oldApproval.revision + 1, billableMinutes: 50,
    narrative: "Additional analysis", workedMinutes: 60,
  });
  expect(returned.hourlyRate).toBeUndefined();
  expect(returned.history.at(-1)).toMatchObject({
    action: "return", reason: "Apply agreed price", before: { status: "approved", billableMinutes: 60 },
  });
  expect(() => run(reviewer, invoice)).toThrow();
  const edited = run(worker, {
    type: "update", ...entryRef(returned), entry: {
      date: returned.date, matterId: matter.id, clientId: client.id, activity: returned.activity,
      narrative: "Final analysis", billable: true, workedMinutes: 60, billableMinutes: 40,
    },
  }).entries[0];
  run(worker, { type: "submit", entries: [entryRef(edited)] });
  const submitted = read(reviewer).entries[0];
  const priced = approve(submitted);
  expect(priced).toMatchObject({ status: "approved", hourlyRate: 300, currency: "EUR" });
  expect(priced.history.find((h) => h.revision === oldApproval.revision)?.after.hourlyRate).toBeUndefined();
  const preview = run(reviewer, prepareInvoice([priced]));
  const issued = run(reviewer, approveInvoice((command) => run(reviewer, command), preview)).invoices[0];
  expect(issued.total).toBe(200);
  expect(issued.entries[0].narrative).toBe("Final analysis");
  expect(read(reviewer).adjustments).toContainEqual(correction);
});
