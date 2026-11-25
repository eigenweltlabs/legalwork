import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(window.navigator, "pdfViewerEnabled", { value: true, configurable: true });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
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
  TimePolicy,
  TimesheetCommand,
  TimesheetState,
} from "@legalwork/types/timesheet";

const { act, useState } = await import("react");
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
  supportsInvoiceCreation: true,
  supportsHourlyInvoiceCurrency: true,
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
const calls: TimesheetCommand[] = [];
const command = async (c: TimesheetCommand) => {
  calls.push(c);
};
const client = {
  downloadTimesheetAdjustment: async () => {
    throw new Error("Unused");
  },
  downloadTimesheetInvoice: async () => {
    throw new Error("Unused");
  },
};
const viewTarget = host.appendChild(document.createElement("div"));
const billingRoot = createRoot(viewTarget);
const render = async (node: ReactNode) =>
  act(async () => billingRoot.render(<MemoryRouter><BackOfficeTheme>{node}</BackOfficeTheme></MemoryRouter>));
const draw = (state: TimesheetState, canEdit = true) =>
  render(<BillingReview canEdit={canEdit} state={state} onCommand={command} client={client} />);
const match = (s: string) => {
  const el = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (e) => e.textContent?.trim() === s || e.getAttribute("aria-label") === s,
  );
  assert.ok(el, "Button " + s);
  return el;
};
const click = async (el: HTMLElement) => act(async () => el.click());
const select = async (label: string, value: string) => {
  const trigger = host.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  assert.ok(trigger, "Select " + label);
  if (trigger instanceof window.HTMLInputElement) {
    await act(async () => trigger.focus());
    await key(trigger, "ArrowDown");
    await write(trigger, value);
  } else {
    await click(trigger);
  }
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(item => item.textContent?.trim() === value || item.firstElementChild?.textContent?.trim() === value);
  assert.ok(option, "Option " + value);
  await act(async () => {
    option.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    option.click();
  });
};
const checkbox = (label: string) => {
  const control = host.querySelector<HTMLButtonElement>(`[data-slot="checkbox"][aria-label="${label}"]`);
  assert.ok(control, "Checkbox " + label);
  return control;
};
const save = () => [...host.querySelectorAll<HTMLButtonElement>(".bo-invoice-footer button")]
  .find(button => button.textContent?.trim() === "Create Invoice")!;
const field = (sel: string) => {
  const el = host.querySelector<HTMLInputElement>(sel);
  assert.ok(el, "Input " + sel);
  return el;
};
async function write(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  await act(async () => {
    const prototype = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
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
  assert.equal(checkbox("Select all eligible positions").getAttribute("aria-disabled"), "true");
  await draw({ ...actor, canManage: false });

  await click(checkbox("Select all eligible positions"));
  assert.match(host.textContent ?? "", /Selected: 1/);
  const changed = {
    ...actor,
    entries: actor.entries.map((e) => (e.id === row.id ? { ...e, revision: 2 } : e)),
  };
  await draw(changed);
  assert.ok(!host.textContent?.includes("Selected: 1"), "stale revisions excluded");
  await click(checkbox("Select all eligible positions"));
  await click(match("Approve selection"));
  assert.deepEqual(calls.at(-1), { type: "approve", entries: [{ id: "a", revision: 2 }] });
  await click(checkbox("Select all eligible positions"));
  const charge = host.querySelector<HTMLButtonElement>('button[aria-label="Billable (min)"]');
  assert.ok(charge);
  await click(charge);
  const minutes = field('input[aria-label="Billable (min)"]');
  await write(minutes, "20");
  assert.equal(calls.length, 1);
  assert.ok(match("Approve selection").disabled, "Open edits must never approve an older line");
  const reason = field('input[aria-label="Reason for changing billable time (optional)"]');
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
  await write(revisedText, "");
  await select("Client", "Acme");
  await click(checkbox("Select all eligible positions"));
  assert.ok(match("Approve selection").disabled, "Filtering must keep a visible draft blocking approval");
  await draw({ ...actor, entries: [{ ...row, revision: 3, workedMinutes: 60 }] });
  await key(revisedText, "Enter");
  assert.equal(calls.length, 2, "Editing a superseded revision must not write to its replacement");
  await key(revisedText, "Escape");
  await select("Client", "All clients");
  await draw({ ...actor, entries: [{ ...row, status: "approved" }] });

  await select("View", "Approved positions");
  const prior = { ...row, date: "2001-09-01", id: "earlier", narrative: "Earlier approved work", status: "approved" as const };
  await draw({ ...actor, entries: [prior, { ...prior, id: "issued", narrative: "Previously issued work", status: "invoiced" },
    { ...prior, id: "future", date: "2099-11-30", narrative: "After cutoff" }, { ...row, status: "approved" }] });
  const unbilled = [...host.querySelectorAll("label")].find(label => label.textContent?.includes("All unbilled time"))?.querySelector<HTMLElement>('[data-slot="checkbox"]');
  assert.ok(unbilled);
  assert.ok(!host.textContent?.includes(prior.narrative));
  await click(unbilled.closest("label")!.querySelector("input[type=checkbox]")!);
  assert.ok(host.textContent?.includes(prior.narrative));
  assert.ok(!host.textContent?.includes("Previously issued work"));
  assert.ok(!host.textContent?.includes("After cutoff"));
  await click(unbilled.closest("label")!.querySelector("input[type=checkbox]")!);
  assert.ok(!host.textContent?.includes(prior.narrative));
  await draw({ ...actor, supportsInvoiceCreation: false, supportsInvoiceDrafts: true, entries: [{ ...row, status: "approved" }] });
  assert.ok(!host.textContent?.includes("Create Invoice"));
  assert.match(host.textContent ?? "", /update the connected firm service/);
  const open: TimesheetState = { ...actor, policies: [policy, { ...policy, scope: "project", targetId: "required-review", reviewerId: "lawyer" }], entries: [prior, { ...row, status: "approved" },
    { ...row, id: "usd", status: "approved", currency: "USD", narrative: "USD briefing" },
    { ...prior, id: "queued", narrative: "Waiting for historical review", status: "submitted", suggestion: undefined },
    { ...prior, id: "own-open", workerId: actor.userId, projectId: "required-review", narrative: "Booked earlier", status: "confirmed" },
  ] };
  await draw(open);
  await click(match("Create Invoice"));
  assert.ok(host.querySelector('input[placeholder="Choose a matter"]'));
  await select("Matter", "Alpha");
  assert.match(host.textContent ?? "", /Acme/);
  assert.equal(host.querySelector('input[aria-label="Client"]'), null, "A single billing client is filled in automatically");
  assert.equal(host.querySelector('[aria-label="Fee basis"]'), null);
  assert.equal(host.querySelector("textarea"), null);
  assert.ok(checkbox("Select entry: Earlier approved work"));
  assert.ok(save().disabled, "Creating an invoice starts with a deliberate selection");
  await click(checkbox("Select entry: Earlier approved work"));
  const ownTimesheet = [...host.querySelectorAll("a")].find((link) => link.textContent?.includes("Open my timesheet"));
  assert.equal(ownTimesheet?.getAttribute("href"), "/time?date=2001-09-01");
  await click(match("Open submitted entries"));
  const submittedTable = host.querySelector(".bo-billing-body");
  assert.match(submittedTable?.textContent ?? "", /Waiting for historical review/);
  assert.equal(host.querySelector('[role="combobox"][aria-label="View"] [data-slot="select-value"]')?.textContent, "Awaiting review");
  assert.equal(host.querySelector('button[role="combobox"][aria-label="Matter"] [data-slot="select-value"]')?.textContent, "Alpha");
  assert.equal(host.querySelector('button[role="combobox"][aria-label="Client"] [data-slot="select-value"]')?.textContent, "Acme");
  const reviewDates = [...host.querySelectorAll<HTMLInputElement>('input[type="date"]')].filter((el) => !el.closest("[hidden]"));
  assert.deepEqual(reviewDates.map((el) => el.value), [prior.date, prior.date]);
  await click(match("Back to invoice"));
  assert.equal(checkbox("Select entry: Earlier approved work").getAttribute("aria-checked"), "true",
    "Returning from a historical review keeps the invoice selection");
  await click(checkbox("Select entry: USD briefing"));
  assert.ok(save().disabled, "An hourly invoice cannot silently omit entries in a second currency");
  assert.match(host.textContent ?? "", /The selected time uses more than one currency/);
  await click(checkbox("Select entry: Earlier approved work"));
  await click(save());
  const usdInvoice = calls.at(-1);
  assert.ok(usdInvoice?.type === "createInvoice");
  assert.equal(usdInvoice.invoice.pricing.currency, "USD");
  assert.deepEqual(usdInvoice.invoice.entries, [{ id: "usd", revision: row.revision }]);
  assert.equal(host.querySelector(".bo-invoice-editor-view"), null);
  assert.doesNotMatch(host.textContent ?? "", /Save and preview|Invoice approval|Issue numbered invoice/);
  await draw({
    ...actor,
    entries: [row, { ...row, id: "b", workerId: "partner", billableMinutes: 20, hourlyRate: 240 }],
  });
  await select("View", "Work products and fees");
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
  await select("View", "Corrections");
  assert.match(host.textContent ?? "", /Agreed fee cap/);
  assert.match(host.textContent ?? "", /100.00/);
  await click(match("Agreed fee cap"));
  assert.match(host.textContent ?? "", /Revised reply brief/);
  await click(match("Approve correction"));
  assert.deepEqual(calls.at(-1), { type: "decideAdjustment", id: "corr", revision: 1, approve: true });
  await select("View", "Approved positions");
  await click(match("Create Invoice"));
  await select("Matter", "Alpha");
  await click(match("Filter by date"));
  const invoiceDates = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="date"]'));
  await write(invoiceDates[0], today);
  await write(invoiceDates[1], today);
  await click(checkbox("Select entry: Brief amended"));
  assert.ok(save().disabled, "an unreviewed delta blocks issuance");
  const revised = {
    ...locked,
    adjustments: [
      { ...correction, revision: 2, status: "approved" as const, reviewedAt: new Date().toISOString() },
    ],
  };
  await draw(revised);
  assert.match(host.querySelector(".bo-invoice-draft")?.textContent ?? "", /Revised reply brief/);
  await click(save());
  const revisedInvoice = calls.at(-1);
  assert.ok(revisedInvoice?.type === "createInvoice");
  assert.deepEqual(revisedInvoice.invoice.adjustmentVersions, [{ id: "corr", revision: 2 }]);
  await select("View", "Work products and fees");
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
      section="rules"
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
      section="rules"
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
  const beforeException = calls.length;
  await click(inherited);
  assert.equal(calls.length, beforeException);
  assert.match(host.textContent ?? "", /Enter the reason to save this project exception/);
  assert.match(host.textContent ?? "", /Open positions with changed terms \(1\)/);
  const receipt = host.querySelector("textarea[required]");
  assert.ok(receipt);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    assert.ok(setter);
    setter.call(receipt, "Signed engagement amendment");
    receipt.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(calls.length, beforeException, "Typing the reason does not publish it");
  await act(async () => receipt.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })));
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
  await click(checkbox("Select all eligible positions"));
  assert.ok(match("Approve selection").disabled);
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Billable (min)"]')!);
  await write(field('input[aria-label="Billable (min)"]'), "120");
  const capReason = field('input[aria-label="Reason for changing billable time (optional)"]');
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
    await click(checkbox(`Select entry: Review position ${i}`));
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
  await click(checkbox("Select all eligible positions"));
  const previousCalls = calls.length;
  await click(match("Check billing text"));
  const previewRows = () => [...host.querySelectorAll(".bo-billing-wording-preview tbody tr")]
    .map((tr) => [...tr.querySelectorAll("td")].slice(-2).map((cell) => cell.textContent));
  assert.deepEqual(previewRows(), [["Brief amended", "Amending Brief"], ["Memo amended", "Amending Memo"]]);
  assert.match(host.querySelector(".bo-billing-wording-preview")?.textContent ?? "", /Start with an action word/);
  assert.equal(calls.length, previousCalls, "A wording preview is read-only");
  await draw({ ...wordingState, entries: [wordingEntries[0], { ...wordingEntries[1], revision: 2 }, wordingEntries[2]] });
  assert.equal(host.querySelector(".bo-billing-wording-preview"), null, "A changed revision invalidates the preview");
  await click(checkbox("Select entry: Memo amended"));
  await click(match("Check billing text"));
  await click(match("Apply previewed changes (2)"));
  assert.deepEqual(calls.at(-1), {
    type: "applyWording",
    entries: [
      { id: "a", revision: 1, before: "Brief amended", after: "Amending Brief" },
      { id: "b", revision: 2, before: "Memo amended", after: "Amending Memo" },
    ],
  });
  await click(checkbox("Select entry: Researching"));
  await click(match("Check billing text"));
  assert.match(host.textContent ?? "", /No wording changes suggested/);

  const missingPrice = { ...row, id: "unpriced", hourlyRate: undefined, suggestion: undefined };
  const unpricedPolicy = { ...policy, hourlyRate: undefined };
  await draw({ ...actor, entries: [missingPrice], policies: [unpricedPolicy] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /Set an hourly rate and currency/);
  await click(checkbox("Select all eligible positions"));
  assert.ok(match("Approve selection").disabled);

  const stalePrice = { ...row, id: "stale-price", suggestion: undefined };
  await draw({ ...actor, entries: [stalePrice], policies: [{ ...policy, hourlyRate: 350, currency: "USD" }] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /Pricing changed for this service date/);
  await click(checkbox("Select all eligible positions"));
  assert.ok(match("Approve selection").disabled);

  const historical = { ...missingPrice, status: "approved" as const, revision: 5 };
  await draw({ ...actor, entries: [historical] });
  await select("View", "Approved positions");
  await click(checkbox("Select all eligible positions"));
  const returnButton = match("Return for pricing review");
  assert.equal(returnButton.disabled, false);
  await write(field('input[aria-label="Reason for returning (optional)"]'), "Apply the agreed hourly rate");
  await click(returnButton);
  assert.deepEqual(calls.at(-1), {
    type: "return", entries: [{ id: historical.id, revision: 5 }], reason: "Apply the agreed hourly rate",
  });

  await draw({ ...actor, entries: [{ ...historical, nonHourlyApproval: true }] });
  await click(match("Pricing"));
  assert.match(host.textContent ?? "", /tracks time separately from its fee/);
  await click(checkbox("Select all eligible positions"));
  assert.ok(!host.textContent?.includes("Return for pricing review"));

  await draw({ ...actor, entries: [{ ...row, status: "approved" }], policies: [{ ...policy, maxMinutes: 30 }] });
  assert.equal(host.querySelector('[aria-label="10 min over limit"]'), null);
  assert.ok(!match("Create Invoice").disabled);
  await render(null);
  const selectable = { ...actor, supportsBillingClientAssignment: true,
    clients: [...actor.clients, { id: "second", name: "Second recipient" }],
    matters: [{ ...actor.matters[0], clientIds: ["c", "second"] }],
    entries: [{ ...row, clientId: "", narrative: "Unassigned matter billing" }] };
  await draw(selectable);
  await click(match("Create Invoice"));
  await select("Matter", "Alpha");
  await select("Client", "Second recipient");
  assert.ok(host.textContent?.includes("Unassigned matter billing"));
  await click(match("Assign to Second recipient"));
  assert.deepEqual(calls.at(-1), { type: "assignBillingClient", id: row.id, revision: row.revision, clientId: "second" });
  await render(null);
  const excludedDirect = { ...row, id: "excluded-direct", workerId: actor.userId, authorId: actor.userId,
    narrative: "Saved without a reviewer", status: "confirmed" as const };
  const fresh = { ...excludedDirect, id: "new-direct", narrative: "Call with client" };
  const emptyMatter = { id: "kestrel", name: "Kestrel", clientIds: ["c"] };
  const directState: TimesheetState = { ...actor, canReview: false, canInvoice: true,
    matters: [emptyMatter, ...actor.matters], entries: [excludedDirect, fresh] };
  await render(<BillingReview state={directState} client={client} canEdit onCommand={command} initialMode="invoices" invoiceViews />);
  await click(match("Create Invoice"));
  assert.equal(field('input[aria-label="Matter"]').value, "Alpha");
  await click(match("Back"));
  await click(match("Unbilled time"));
  const ownRow = [...host.querySelectorAll("tbody tr")].find(item => item.textContent?.includes(fresh.narrative));
  const invoiceThisEntry = ownRow?.querySelector<HTMLButtonElement>("button");
  assert.equal(invoiceThisEntry?.textContent, "Invoice this entry");
  assert.ok(invoiceThisEntry);
  await click(invoiceThisEntry);
  assert.equal(checkbox("Select entry: Call with client").getAttribute("aria-checked"), "true");
  assert.equal(checkbox("Select entry: Saved without a reviewer").getAttribute("aria-checked"), "false");
  assert.match(checkbox("Select entry: Call with client").closest("tr")?.textContent ?? "", /Approved/);
  await click(save());
  const preparedSingle = calls.at(-1);
  assert.ok(preparedSingle?.type === "createInvoice");
  assert.deepEqual(preparedSingle.invoice.entries, [{ id: fresh.id, revision: fresh.revision }]);
  await render(null);
  const unpricedState = { ...directState, policies: [{ ...policy, hourlyRate: undefined, reviewerId: undefined }] };
  let rejectSave: ((error: Error) => void) | undefined;
  function RateEditorFixture() {
    const [state, setState] = useState(unpricedState);
    return <BillingReview state={state} client={client} canEdit initialMode="invoices" invoiceViews
      onCommand={async action => {
        await command(action);
        if (action.type !== "policy") return;
        if (!rejectSave) await new Promise<void>((_, reject) => { rejectSave = reject; });
        setState(previous => ({ ...previous, policies: [...previous.policies,
          { ...action.policy, revision: action.policy.revision + 1 },
        ] }));
      }} />;
  }
  await render(<RateEditorFixture />);
  await click(match("Create Invoice"));
  await click(checkbox("Select entry: Call with client"));
  assert.ok(save().disabled);
  assert.match(host.textContent ?? "", /No hourly rate/);
  const beforeRate = calls.length;
  await click(match("Edit rate"));
  const rateDialog = document.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(rateDialog);
  const partnerLabel = Array.from(rateDialog.querySelectorAll("label")).find(label => label.textContent?.trim() === "Partner");
  const rate = partnerLabel && document.getElementById(partnerLabel.htmlFor);
  assert.ok(rate instanceof window.HTMLInputElement);
  assert.equal(calls.length, beforeRate, "Opening the rate editor never sets a fee");
  await write(rate, "330");
  await act(async () => rate.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true })));
  assert.equal(calls.length, beforeRate, "Leaving the field waits for explicit confirmation");
  const saveRate = () => [...rateDialog.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "Save rate")!;
  await click(saveRate());
  assert.match(rateDialog.textContent ?? "", /Saving/);
  assert.ok(rejectSave);
  await act(async () => rejectSave?.(new Error("Billing settings could not be reached.")));
  assert.match(rateDialog.querySelector('[role="alert"]')?.textContent ?? "", /Billing settings could not be reached/);
  assert.equal(rate.value, "330");
  await click(saveRate());
  const updatedRate = calls.at(-1);
  assert.ok(updatedRate?.type === "policy");
  assert.equal(updatedRate.policy.targetId, "m");
  assert.equal(updatedRate.policy.effectiveFrom, today);
  assert.equal(updatedRate.policy.workerRates?.partner, 330);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.match(host.textContent ?? "", /€330\.00\/h/);
  assert.equal(save().disabled, false);

  await render(null);
  const fixedState: TimesheetState = { ...directState, policies: [
    { ...policy, reviewerId: undefined },
    { scope: "matter", targetId: "m", effectiveFrom: "0001-01-01", revision: 0,
      agreementId: "flat", allocationUnavailable: true, nonHourlyAgreement: true, nonHourlyBasis: "fixed" },
  ] };
  await render(<BillingReview state={fixedState} client={client} canEdit onCommand={command} initialMode="invoices" invoiceViews />);
  await click(match("Create Invoice"));
  await click(checkbox("Select entry: Call with client"));
  assert.match(host.textContent ?? "", /covered by a flat-fee agreement/);
  assert.doesNotMatch(host.textContent ?? "", /No hourly rate|Edit rate/);
  assert.ok(save().disabled);
  await click(match("Use fixed price"));
  await write(field('input[inputmode="decimal"]'), "250");
  assert.equal(save().disabled, false);
  await click(save());
  const preparedFixed = calls.at(-1);
  assert.ok(preparedFixed?.type === "createInvoice" && preparedFixed.invoice.pricing.mode === "fixed");
  assert.equal(preparedFixed.invoice.pricing.amountMinor, 25000);
  console.log("Billing review passed");
} finally {
  await act(async () => billingRoot.unmount());
  await window.happyDOM.close();
}
