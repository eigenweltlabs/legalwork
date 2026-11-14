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
  TimePolicy,
  TimesheetCommand,
  TimesheetState,
} from "@legalwork/types/timesheet";

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
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
  entries: [row, { ...row, id: "own", workerId: "partner" }],
  matters: [{ id: "m", name: "Alpha", reference: "A", clientIds: ["c"] }],
  clients: [{ id: "c", name: "Acme" }],
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
  downloadTimesheetAdjustment: async () => {
    throw new Error("Unused");
  },
  downloadTimesheetInvoice: async () => {
    throw new Error("Unused");
  },
};
const render = async (node: ReactNode) =>
  act(async () => root.render(<BackOfficeTheme>{node}</BackOfficeTheme>));
const draw = (state: TimesheetState) =>
  render(<BillingReview state={state} onCommand={command} client={client} />);
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
    const el = host.querySelector<HTMLSelectElement>('select[aria-label="' + label + '"]');
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
  await draw(actor);
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
  const charge = host.querySelector<HTMLButtonElement>('button[aria-label="Charge (min)"]');
  assert.ok(charge);
  await click(charge);
  const minutes = field('input[aria-label="Charge (min)"]');
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
  await draw({ ...actor, entries: [{ ...row, status: "approved" }] });
  await select("View", "approved");
  await click(field('input[aria-label="Select all eligible positions"]'));
  await click(match("Preview invoice"));
  assert.equal(calls.length, 2, "preview must not issue");
  await click(match("Issue numbered invoice"));
  assert.equal(calls.at(-1)?.type, "invoice");
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
  await click(field('input[aria-label="Select all eligible positions"]'));
  assert.ok(match("Preview invoice").disabled, "unreviewed delta blocks issuance");
  const revised = {
    ...locked,
    adjustments: [
      { ...correction, revision: 2, status: "approved" as const, reviewedAt: new Date().toISOString() },
    ],
  };
  await draw(revised);
  await click(match("Preview invoice"));
  assert.match(host.querySelector("iframe")?.getAttribute("srcdoc") ?? "", /Revised reply brief/);
  await click(match("Issue numbered invoice"));
  const revisedInvoice = calls.at(-1);
  assert.ok(revisedInvoice?.type === "invoice");
  assert.deepEqual(revisedInvoice.adjustmentVersions, [{ id: "corr", revision: 2 }]);
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
  await render(<BillingPreferences state={{ ...actor, scope: "local" }} onCommand={command} />);
  const toggle = host.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Enforce billing increment"]',
  );
  assert.ok(toggle);
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
  await click(host.querySelector<HTMLButtonElement>('button[aria-label="Charge (min)"]')!);
  await write(field('input[aria-label="Charge (min)"]'), "120");
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
      hourlyRate: i === 55 ? 150 : 270,
    };
  });
  await draw({ ...actor, entries: threeWeeks });
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
  console.log("Billing review passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.close();
}
