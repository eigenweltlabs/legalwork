import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { value, configurable: true });

import type {
  TimeEntry,
  TimeInvoiceDraft,
  TimePolicy,
  TimesheetCommand,
  TimesheetState,
} from "@legalwork/types/timesheet";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { BillingReview } = await import("../../src/react-app/domains/back-office/billing-review");
const { BillingPreferences } = await import(
  "../../src/react-app/domains/back-office/billing-preferences"
);
const { BackOfficeTheme } = await import("../../src/react-app/domains/back-office/twenty-controls");
const { reviewPeriod, feeTotals } = await import(
  "../../src/react-app/domains/back-office/billing-amounts"
);
const { standardInvoice } = await import("@legalwork/types/invoice-template");
const today = reviewPeriod().to;
const policy: TimePolicy = {
  scope: "firm",
  targetId: "firm",
  effectiveFrom: "2000-01-01",
  revision: 1,
  reviewerId: "partner",
  hourlyRate: 300,
  currency: "EUR",
};
const row: TimeEntry = {
  id: "a",
  date: today,
  status: "submitted",
  authorId: "lawyer",
  workerId: "lawyer",
  matterId: "m",
  clientId: "c",
  activity: "MOD",
  workProductId: "brief",
  narrative: "Brief amended",
  submittedNarrative: "Brief amended",
  suggestion: "Amending brief",
  billable: true,
  workedMinutes: 40,
  billableMinutes: 40,
  hourlyRate: 300,
  currency: "EUR",
  revision: 1,
  source: "manual",
  history: [],
};
const actor: TimesheetState = {
  userId: "partner",
  scope: "team",
  canManage: true,
  canReview: true,
  supportsInvoiceDrafts: true,
  entries: [row, { ...row, id: "own", workerId: "partner" }],
  matters: [{ id: "m", name: "Alpha", reference: "A", clientIds: ["c"] }],
  clients: [{ id: "c", name: "Acme", billingAddress: "Fixture Lane 1" }],
  projects: [],
  people: [
    { id: "lawyer", name: "Lawyer" },
    { id: "partner", name: "Partner" },
  ],
  products: [{ id: "brief", name: "Reply brief", matterId: "m" }],
  policies: [policy],
  invoices: [],
};
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const calls: TimesheetCommand[] = [];
const command = async (c: TimesheetCommand) => {
  calls.push(c);
};
const client = {
  downloadTimesheetDraft: async () => {
    throw new Error("Unused");
  },
  downloadTimesheetAdjustment: async () => {
    throw new Error("Unused");
  },
  downloadTimesheetInvoice: async () => {
    throw new Error("Unused");
  },
};
const render = async (node: ReactNode) =>
  act(async () => root.render(<MemoryRouter><BackOfficeTheme>{node}</BackOfficeTheme></MemoryRouter>));
const draw = (state: TimesheetState, canEdit = true) =>
  render(<BillingReview canEdit={canEdit} state={state} onCommand={command} client={client} />);
const match = (s: string) => {
  const el = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (e) => e.textContent === s,
  );
  assert.ok(el, "Button " + s);
  return el;
};
const click = async (el: HTMLElement) => act(async () => el.click());
const select = async (label: string, v: string) => {
  await act(async () => {
    const el = host.querySelector<HTMLSelectElement>('select[aria-label="' + label + '"]') ??
      [...host.querySelectorAll("label")].find((item) => item.firstChild?.textContent === label)?.querySelector("select");
    assert.ok(el);
    el.value = v;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
};
const field = (sel: string) => {
  const el = host.querySelector<HTMLInputElement>(sel);
  assert.ok(el, "Input " + sel);
  return el;
};
async function write(el: HTMLInputElement, v: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(set);
    set.call(el, v);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function key(el: HTMLElement, key: string) {
  await act(async () => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })));
}
try {
  await draw(actor, false);
  assert.ok(field('input[aria-label="Select all eligible positions"]').disabled);
  await draw({ ...actor, canManage: false });

  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.match(host.textContent ?? "", /Selected: 1/);
  const changed = {
    ...actor,
    entries: actor.entries.map((e) => (e.id === row.id ? { ...e, revision: 2 } : e)),
  };
  await draw(changed);
  assert.ok(!host.textContent?.includes("Selected: 1"), "stale revisions excluded");
  await click(field('input[aria-label="Select all eligible positions"]'));
  await click(match("Approve selection"));
  assert.deepEqual(calls.at(-1), { type: "approve", entries: [{ id: "a", revision: 2 }] });
  await click(field('input[aria-label="Select all eligible positions"]'));
  const charge = host.querySelector<HTMLButtonElement>('button[aria-label="Billable (min)"]');
  assert.ok(charge);
  await click(charge);
  const minutes = field('input[aria-label="Billable (min)"]');
  await write(minutes, "20");
  await key(minutes, "Enter");
  assert.equal(calls.length, 1);
  assert.ok(match("Approve selection").disabled, "Open edits must never approve an older line");
  const reason = field('input[aria-label="Reason for charge adjustment"]');
  await write(reason, "Capped by agreement");
  await key(reason, "Enter");
  assert.deepEqual(calls.at(-1), {
    type: "review",
    id: "a",
    revision: 2,
    billableMinutes: 20,
    narrative: "Brief amended",
    reason: "Capped by agreement",
  });
  const narrative = host.querySelector<HTMLButtonElement>('button[aria-label="Narrative"]');
  assert.ok(narrative);
  await click(narrative);
  const revisedText = field('input[aria-label="Narrative"]');
  await write(revisedText, "New narrative");
  await select("Client", "c");
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(match("Approve selection").disabled, "Filtering must keep a visible draft blocking approval");
  await draw({ ...actor, entries: [{ ...row, revision: 3, workedMinutes: 60 }] });
  await key(revisedText, "Enter");
  assert.equal(calls.length, 2, "Editing a superseded revision must not write to its replacement");
  await key(revisedText, "Escape");
  await select("Client", "");
  await draw({ ...actor, entries: [{ ...row, status: "approved" }] });

  await select("View", "approved");
  const prior = { ...row, date: "2001-09-01", id: "earlier", narrative: "Earlier approved work", status: "approved" as const };
  await draw({ ...actor, entries: [prior, { ...prior, id: "issued", narrative: "Previously issued work", status: "invoiced" },
    { ...prior, id: "future", date: "2099-11-30", narrative: "After cutoff" }, { ...row, status: "approved" }] });
  const unbilled = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("All unbilled time"))?.querySelector("input");
  assert.ok(unbilled);
  assert.ok(!host.textContent?.includes(prior.narrative));
  await click(unbilled);
  assert.ok(host.textContent?.includes(prior.narrative));
  assert.ok(!host.textContent?.includes("Previously issued work"));
  assert.ok(!host.textContent?.includes("After cutoff"));
  await click(unbilled);
  assert.ok(!host.textContent?.includes(prior.narrative));
  await draw({ ...actor, supportsInvoiceDrafts: undefined, entries: [{ ...row, status: "approved" }] });
  assert.ok(!host.textContent?.includes("Create Invoice"));
  assert.match(host.textContent ?? "", /require support from the connected firm server/);
  const open: TimesheetState = { ...actor, entries: [prior, { ...row, status: "approved" },
    { ...row, id: "queued", narrative: "Waiting for review", status: "submitted" },
    { ...row, id: "own-open", workerId: actor.userId, narrative: "Booked this morning", status: "confirmed" },
  ] };
  await draw(open);
  await click(match("Create Invoice"));
  assert.match(host.textContent ?? "", /Choose a matter/);
  await select("Matter", "m");
  assert.match(host.textContent ?? "", /Acme/);
  assert.match(host.textContent ?? "", /Booked this morning/);
  assert.match(host.textContent ?? "", /Open submitted entries/);
  assert.ok(!host.textContent?.includes(prior.narrative));
  const allOpen = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("All open entries through"))?.querySelector("input");
  assert.ok(allOpen);
  await click(allOpen);
  assert.ok(host.textContent?.includes(prior.narrative));
  await click(allOpen);
  await click(match("Preview invoice"));
  assert.ok(!host.textContent?.includes("Issue numbered invoice"));
  const prepared = calls.at(-1);
  assert.ok(prepared?.type === "prepareInvoice");
  assert.deepEqual(prepared.draft.entries, [{ id: row.id, revision: row.revision }]);
  const draft: TimeInvoiceDraft = {
    id: crypto.randomUUID(), revision: "a".repeat(64), input: prepared.draft, currency: "EUR", showHours: true,
    totalMinor: 20000, protectedMinor: 0, selectedBaseMinor: 20000, selectedTotalMinor: 20000,
    snapshot: { date: today, client: "Acme", clientAddress: "Fixture Lane 1", template: standardInvoice },
    lines: [{ entry: { ...row, status: "approved" }, originalNarrative: row.narrative, currentNarrative: row.narrative,
      rules: [], amountMinor: 20000, baseAmountMinor: 20000, actualAmountMinor: 20000 }],
  };
  await draw({ ...open, invoiceDraft: draft });
  await click(match("Approve this invoice"));
  assert.deepEqual(calls.at(-1), { type: "approveInvoice", id: draft.id, revision: draft.revision });
  await draw({ ...open, invoiceDraft: { ...draft, approval: { actorId: actor.userId, at: new Date().toISOString(), revision: draft.revision } } });
  await click(match("Issue numbered invoice"));
  assert.equal(calls.at(-1)?.type, "issueInvoice");
  await draw({
    ...actor,
    entries: [row, { ...row, id: "b", workerId: "partner", billableMinutes: 20, hourlyRate: 240 }],
  });
  await select("View", "costs");
  assert.match(host.textContent ?? "", /Reply brief/);
  assert.match(host.textContent ?? "", /280\.00/);
  await click(match("Reply brief"));
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Rename work product"]')!);
  const name = field('input[aria-label="Rename work product"]');
  await write(name, "Revised filing");
  await key(name, "Enter");
  assert.deepEqual(calls.at(-1), {
    type: "renameProduct",
    id: "brief",
    expectedName: "Reply brief",
    name: "Revised filing",
  });

  const correction = {
    id: "corr",
    entryId: "a",
    baseRevision: 1,
    revision: 1,
    matterId: "m",
    workerId: "lawyer",
    authorId: "lawyer",
    reason: "Agreed fee cap",
    narrative: "Revised reply brief",
    fromMinutes: 40,
    toMinutes: 20,
    deltaAmount: -100,
    currency: "EUR",
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };
  const locked = {
    ...actor,
    canManage: false,
    entries: [{ ...row, status: "approved" as const }],
    adjustments: [correction],
  };
  await draw(locked);
  await select("View", "adjustments");
  assert.match(host.textContent ?? "", /Agreed fee cap/);
  assert.match(host.textContent ?? "", /100.00/);
  await click(match("Agreed fee cap"));
  assert.match(host.textContent ?? "", /Revised reply brief/);
  await click(match("Approve correction"));
  assert.deepEqual(calls.at(-1), { type: "decideAdjustment", id: "corr", revision: 1, approve: true });
  await select("View", "approved");
  await click(match("Create Invoice"));
  await select("Matter", "m");
  const invoiceDates = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  await write(invoiceDates[0], today);
  await write(invoiceDates[1], today);
  assert.ok(match("Preview invoice").disabled, "an unreviewed delta blocks issuance");
  const revised = {
    ...locked,
    adjustments: [
      { ...correction, revision: 2, status: "approved" as const, reviewedAt: new Date().toISOString() },
    ],
  };
  await draw(revised);
  await click(match("Preview invoice"));
  assert.equal(host.querySelector<HTMLTextAreaElement>(".bo-invoice-table textarea")?.value, "Revised reply brief");
  const revisedInvoice = calls.at(-1);
  assert.ok(revisedInvoice?.type === "prepareInvoice");
  assert.deepEqual(revisedInvoice.draft.adjustmentVersions, [{ id: "corr", revision: 2 }]);
  await click(match("Back"));
  await select("View", "costs");
  const totals = host.querySelector("tbody tr")?.textContent ?? "";
  assert.match(totals, /100.00/);
  assert.ok(!totals.includes("200.00"), "original charge is reduced once");
  const mixed = feeTotals([
    row,
    { ...row, currency: "JPY", billableMinutes: 10, hourlyRate: 241 },
    { ...row, hourlyRate: undefined },
  ]);
  assert.equal(mixed.byCurrency.get("JPY"), 40);
  assert.equal(mixed.unresolved, 1);
  const smallFee = { ...row, currency: "EUR", billableMinutes: 60, hourlyRate: 0.1 };
  assert.equal(feeTotals([smallFee, smallFee, smallFee]).byCurrency.get("EUR"), 0.3);
  await render(
    <BillingPreferences
      state={{ ...actor, scope: "local", policies: [{ ...policy, hourlyRate: undefined, currency: undefined }] }}
      onCommand={command}
    />,
  );
  const toggle = host.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Enforce billing increment"]',
  );
  assert.ok(toggle);
  assert.equal(toggle.dataset.size, "default");
  assert.ok(toggle.closest('[data-slot="item-header-actions"]'));
  await click(toggle);
  await click(match("Save billing settings"));
  const saved = calls.at(-1);
  assert.ok(saved?.type === "policy");
  assert.equal(saved.policy.scope, "firm");
  assert.equal(saved.policy.targetId, "firm");
  assert.equal(saved.policy.enforceIncrement, false);
  const bound: TimePolicy = {
    scope: "client",
    targetId: "c",
    effectiveFrom: "2025-01-01",
    revision: 2,
    incrementMinutes: 6,
    bindingIncrement: true,
  };
  const project = { id: "project", name: "Team matter", matterIds: ["m"] };
  await render(
    <BillingPreferences
      key="project"
      state={{
        ...actor,
        entries: [
          { ...row, projectId: "project" },
          { ...row, id: "protected", projectId: "project", status: "invoiced" },
          { ...row, id: "previous-date", date: "2025-01-01", projectId: "project" },
          { ...row, id: "another-project", projectId: "other" },
        ],
        projects: [project],
        policies: [policy, bound],
      }}
      initialProjectId="project"
      onCommand={command}
    />,
  );
  assert.match(host.textContent ?? "", /Acme/);
  assert.match(host.textContent ?? "", /Binding increment of 6 minutes/);
  const inherited = host.querySelector<HTMLButtonElement>('[aria-label="Enforce billing increment"]');
  assert.ok(inherited);
  await click(inherited);
  assert.ok(match("Save billing settings").disabled);
  assert.match(host.textContent ?? "", /Open positions with changed terms \(1\)/);
  const receipt = host.querySelector("textarea[required]");
  assert.ok(receipt);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.ok(setter);
    setter.call(receipt, "Signed engagement amendment");
    receipt.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await click(match("Save billing settings"));
  const authorized = calls.at(-1);
  assert.ok(authorized?.type === "policy");
  assert.equal(authorized.policy.incrementExceptionReason, "Signed engagement amendment");
  assert.equal(authorized.policy.incrementException, undefined, "Receipt must come from server");

  await draw({
    ...actor,
    entries: [
      {
        ...row,
        id: "over",
        workedMinutes: 150,
        billableMinutes: 150,
        narrative: "Telephone call",
        activity: "TEL",
        suggestion: undefined,
      },
    ],
  });
  const over = host.querySelector<HTMLButtonElement>('[aria-label="30 min over limit"]');
  assert.ok(over);
  await click(over);
  assert.match(host.textContent ?? "", /permitted maximum is 120/i);
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(match("Approve selection").disabled);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Billable (min)"]')!);
  await write(field('input[aria-label="Billable (min)"]'), "120");
  const capReason = field('input[aria-label="Reason for charge adjustment"]');
  await write(capReason, "Client time limit");
  await key(capReason, "Enter");
  assert.deepEqual(calls.at(-1), {
    type: "review",
    id: "over",
    revision: 1,
    narrative: "Telephone call",
    billableMinutes: 120,
    reason: "Client time limit",
  });

  const testWindow = reviewPeriod();
  const threeWeeks = Array.from({ length: 56 }, (_, i) => {
    const day = new Date(testWindow.from + "T12:00:00");
    day.setDate(day.getDate() + (i % 21));
    return {
      ...row,
      id: "period-" + i,
      narrative: "Review position " + i,
      revision: i + 1,
      suggestion: undefined,
      date: reviewPeriod(day).to,
      workedMinutes: 60,
      billableMinutes: 60,
      workerId: i === 55 ? "other-lawyer" : row.workerId,
      hourlyRate: i === 55 ? 150 : 270,
    };
  });
  await draw({
    ...actor,
    entries: threeWeeks,
    people: [...actor.people, { id: "other-lawyer", name: "Other lawyer" }],
    policies: [{ ...policy, hourlyRate: 270, workerRates: { "other-lawyer": 150 } }],
  });
  assert.match(host.textContent ?? "", /56 positions · €15,000\.00/);
  for (const i of [0, 1, 55])
    await click(field('input[aria-label="Select entry: Review position ' + i + '"]'));
  assert.match(host.textContent ?? "", /Selected: 3 · €690\.00/);
  await click(match("Approve selection"));
  const sub = calls.at(-1);
  assert.ok(sub?.type === "approve");
  assert.deepEqual(
    sub.entries.toSorted((a, b) => a.id.localeCompare(b.id)),
    [0, 1, 55].map((i) => ({ id: "period-" + i, revision: i + 1 })),
  );
  const wordingEntries = [
    { ...row, narrative: "Brief amended", suggestion: undefined },
    { ...row, id: "b", narrative: "Memo amended", suggestion: undefined },
    { ...row, id: "c", narrative: "Researching", suggestion: undefined },
  ];
  const wordingState = {
    ...actor, entries: wordingEntries,
    policies: [{ ...policy, actionFirst: true, language: "English" }],
  };
  await draw(wordingState);
  await click(field('input[aria-label="Select all eligible positions"]'));
  const previousCalls = calls.length;
  await click(match("Check billing text"));
  const previewRows = () => [...host.querySelectorAll(".bo-billing-wording-preview tbody tr")]
    .map((tr) => [...tr.querySelectorAll("td")].slice(-2).map((cell) => cell.textContent));
  assert.deepEqual(previewRows(), [["Brief amended", "Amending Brief"], ["Memo amended", "Amending Memo"]]);
  assert.match(host.querySelector(".bo-billing-wording-preview")?.textContent ?? "", /Start with an action word/);
  assert.equal(calls.length, previousCalls, "A wording preview is read-only");
  await draw({ ...wordingState, entries: [wordingEntries[0], { ...wordingEntries[1], revision: 2 }, wordingEntries[2]] });
  assert.equal(host.querySelector(".bo-billing-wording-preview"), null, "A changed revision invalidates the preview");
  await click(field('input[aria-label="Select entry: Memo amended"]'));
  await click(match("Check billing text"));
  await click(match("Apply previewed changes (2)"));
  assert.deepEqual(calls.at(-1), {
    type: "applyWording",
    entries: [
      { id: "a", revision: 1, before: "Brief amended", after: "Amending Brief" },
      { id: "b", revision: 2, before: "Memo amended", after: "Amending Memo" },
    ],
  });
  await click(field('input[aria-label="Select entry: Researching"]'));
  await click(match("Check billing text"));
  assert.match(host.textContent ?? "", /No wording changes suggested/);

  const missingPrice = { ...row, id: "unpriced", hourlyRate: undefined, suggestion: undefined };
  const unpricedPolicy = { ...policy, hourlyRate: undefined };
  await draw({ ...actor, entries: [missingPrice], policies: [unpricedPolicy] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /Set an hourly rate and currency/);
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(match("Approve selection").disabled);

  const stalePrice = { ...row, id: "stale-price", suggestion: undefined };
  await draw({ ...actor, entries: [stalePrice], policies: [{ ...policy, hourlyRate: 350, currency: "USD" }] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /Pricing changed for this service date/);
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(match("Approve selection").disabled);

  const historical = { ...missingPrice, status: "approved" as const, revision: 5 };
  await draw({ ...actor, entries: [historical] });
  await select("View", "approved");
  await click(field('input[aria-label="Select all eligible positions"]'));
  const returnButton = match("Return for pricing review");
  assert.ok(returnButton.disabled);
  await write(field('input[aria-label="Reason for returning"]'), "Apply the agreed hourly rate");
  await click(returnButton);
  assert.deepEqual(calls.at(-1), {
    type: "return", entries: [{ id: historical.id, revision: 5 }], reason: "Apply the agreed hourly rate",
  });

  await draw({ ...actor, entries: [{ ...historical, nonHourlyApproval: true }] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /tracks time separately from its fee/);
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(!host.textContent?.includes("Return for pricing review"));

  await draw({ ...actor, entries: [{ ...row, status: "approved" }], policies: [{ ...policy, maxMinutes: 30 }] });
  assert.equal(host.querySelector('[aria-label="10 min over limit"]'), null);
  assert.ok(!match("Create Invoice").disabled);
  console.log("Billing review passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.close();
}
