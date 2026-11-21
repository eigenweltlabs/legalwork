import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { defaultBackOfficeModel } from "@legalwork/types/back-office";
import type { TimeEntry, TimesheetState } from "@legalwork/types/timesheet";
import type { BackOfficeState } from "../../src/react-app/domains/back-office/api";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><body><div id='root'></div></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, sessionStorage: window.sessionStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element, Node: window.Node, Event: window.Event, PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

// The browser build loads the shared panel avatars through Vite.
const { mock } = await import("bun:test");
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-animation", () => ({ assistantAvatarAnimations: {} }));
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-assets", () => ({
  assistantAvatarImages: {}, assistantAvatarIcon: () => "flower",
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
const root = createRoot(document.getElementById("root")!);
const entry: TimeEntry = {
  id: "entry", date: "2026-11-17", status: "approved", revision: 1, workerId: "ben", authorId: "ben",
  matterId: "matter", clientId: "client", narrative: "Approved work", activity: "MOD", billable: true, workedMinutes: 45,
  billableMinutes: 45, hourlyRate: 300, currency: "EUR", source: "manual", history: [],
};
const state: TimesheetState = {
  userId: "anna", scope: "local", canManage: true, canReview: true, entries: [entry], policies: [], invoices: [],
  matters: [{ id: "matter", name: "Test matter", reference: "", clientIds: ["client"] }],
  clients: [{ id: "client", name: "Test client", billingAddress: "Fixture Lane 1" }], projects: [], products: [],
  people: [{ id: "anna", name: "Anna" }, { id: "ben", name: "Ben" }],
};

async function until(check: () => unknown) {
  for (let attempt = 0; attempt < 60 && !check(); attempt++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check(), "expected billing UI state");
}
const findButton = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
async function press(label: string) {
  await until(() => findButton(label) && !findButton(label)?.disabled);
  await act(async () => findButton(label)?.click());
}
async function selectNative(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  assert.ok(set);
  await act(async () => {
    set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

// Enter through the real billing route and exercise the HTTP client, both
// query observers, and the invoice editor's mounted local state.
const reviewOrigin = "http://invoice-review.example.test";
const reviewClient = createLegalworkServerClient({ baseUrl: reviewOrigin, token: "other-api", hostToken: "review-host" });
const reviewCache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
const reviewEntry: TimeEntry = { ...entry, narrative: "Fixture invoice line" };
const reviewState = { ...state, supportsInvoiceDrafts: true, entries: [reviewEntry],
  policies: [{ scope: "firm", targetId: "firm", effectiveFrom: "2020-01-01", revision: 1, reviewerId: "anna" }] };
const reviewDirectory: BackOfficeState = {
  scope: "local", directoryId: "invoice-fixture", model: defaultBackOfficeModel(),
  permissions: { finance: true, edit: true, model: true, userId: "anna" },
  records: [], views: [], sync: { enabled: false, cursor: 0, pending: 0, error: null },
};
let officeFailure = 0, timesheetFailure = 0, activeTimesheetUser = "anna";
const realFetch = globalThis.fetch;
const fetchReview: typeof globalThis.fetch = Object.assign(async (resource: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(resource instanceof Request ? resource.url : resource.toString());
  if (url.origin !== reviewOrigin) return realFetch(resource, init);
  if (url.pathname === "/back-office/projects") return Response.json({ projects: [] });
  if (url.pathname === "/back-office/timesheet") {
    if (timesheetFailure === 408) throw new TypeError("Fixture connection timed out");
    if (timesheetFailure) return Response.json({ message: "Fixture timesheet access denied" }, { status: timesheetFailure });
    return Response.json({ ...reviewState, userId: activeTimesheetUser });
  }
  assert.equal(url.pathname, "/back-office");
  if (officeFailure) return new Response("Fixture directory temporarily unavailable", { status: officeFailure });
  return Response.json(reviewDirectory);
}, realFetch);
globalThis.fetch = fetchReview;
try {
  await act(async () => root.render(<QueryClientProvider client={reviewCache}>
    <MemoryRouter initialEntries={["/time/review?date=" + entry.date]}><BackOfficePage client={reviewClient} /></MemoryRouter>
  </QueryClientProvider>));
  const invoiceEditor = () => document.querySelector(".bo-invoice-draft");
  const invoiceWording = () => invoiceEditor()?.querySelector<HTMLTextAreaElement>("textarea");
  const amount = () => invoiceEditor()?.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
  const refreshReview = (source: "directory" | "timesheet") => act(async () => {
    await reviewCache.invalidateQueries({ queryKey: ["back-office", reviewOrigin], predicate: query =>
      source === "directory" ? query.queryKey[2] === "auto" : query.queryKey[3] === "timesheet" });
  });
  const openInvoice = async () => {
    await press("Create Invoice");
    const matter = invoiceEditor()?.querySelector("select");
    assert.ok(matter);
    await selectNative(matter, "matter");
    const pricing = invoiceEditor()?.querySelector<HTMLSelectElement>('select:has(option[value="fixed"])');
    assert.ok(pricing);
    await selectNative(pricing, "fixed");
  };
  await openInvoice();
  const wording = invoiceWording(), fixedPrice = amount();
  assert.ok(wording && fixedPrice);
  await input(wording, "Unsaved invoice narrative");
  await input(fixedPrice, "125.50");

  timesheetFailure = 408;
  await refreshReview("timesheet");
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("connection timed out"));
  assert.equal(invoiceWording(), wording);
  assert.equal(wording.value, "Unsaved invoice narrative");
  timesheetFailure = 0;
  await press("Try again");
  await until(() => !document.querySelector('[role="alert"]'));

  officeFailure = 503;
  await refreshReview("directory");
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("HTTP 503"));
  assert.equal(amount(), fixedPrice);
  assert.equal(fixedPrice.value, "125.50");
  officeFailure = 0;
  await press("Try again");
  await until(() => !document.querySelector('[role="alert"]'));
  assert.equal(invoiceWording(), wording);
  assert.equal(wording.value, "Unsaved invoice narrative");

  timesheetFailure = 403;
  await refreshReview("timesheet");
  await until(() => !invoiceEditor());
  timesheetFailure = 408;
  await refreshReview("timesheet");
  assert.equal(invoiceEditor(), null, "a timeout after revoked access cannot restore the last draft");
  timesheetFailure = 0;
  await press("Try again");
  await openInvoice();
  assert.equal(invoiceWording()?.value, "Fixture invoice line", "access recovery opens a fresh editor");

  officeFailure = 401;
  await refreshReview("directory");
  await until(() => !invoiceEditor());
  officeFailure = 503;
  await refreshReview("directory");
  assert.equal(invoiceEditor(), null, "a directory denial cannot reuse an older identity on a later outage");
  officeFailure = 0;
  await press("Try again");
  await openInvoice();
  assert.equal(invoiceWording()?.value, "Fixture invoice line");

  activeTimesheetUser = "different-account";
  await refreshReview("timesheet");
  await until(() => !invoiceEditor());
  assert.equal(findButton("Create Invoice"), undefined, "a snapshot for another account is never presented");
} finally {
  await act(async () => root.render(null));
  reviewCache.clear();
  globalThis.fetch = realFetch;
}
await window.happyDOM.abort();
console.log("Timesheet workspace refresh regressions passed");
