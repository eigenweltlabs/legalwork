import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { BackOfficeRecordSchema, defaultBackOfficeModel } from "@legalwork/types/back-office";
import type { TimeEntry, TimesheetCommand, TimesheetState } from "@legalwork/types/timesheet";
import type { BackOfficeState } from "../../src/react-app/domains/back-office/api";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><body><div id='root'></div></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, sessionStorage: window.sessionStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  DOMRect: window.DOMRect, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter, Event: window.Event, PointerEvent: window.PointerEvent,
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
const { MemoryRouter, useNavigate } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
const { WorkspaceHeaderTarget } = await import("../../src/react-app/domains/back-office/time-workspace-header");
const header = document.body.appendChild(document.createElement("header"));
const root = createRoot(document.getElementById("root")!);
function WindowHistory() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate(-1)}>Window back</button><button onClick={() => navigate(1)}>Window forward</button></>;
}
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

async function until(check: () => unknown, message = "expected billing UI state") {
  for (let attempt = 0; attempt < 60 && !check(); attempt++)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.ok(check(), message);
}
const findButton = (label: string) => [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
async function press(label: string) {
  await until(() => findButton(label) && !findButton(label)?.disabled);
  await act(async () => findButton(label)?.click());
}
async function selectOption(label: string, name: string) {
  const trigger = document.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  assert.ok(trigger, label);
  if (trigger instanceof window.HTMLInputElement) {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await input(trigger, name);
  } else {
    await act(async () => trigger.click());
  }
  const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === name);
  await until(option);
  await act(async () => {
    option()?.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    option()?.click();
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
const ownHistorical: TimeEntry = {
  ...entry, id: "own-earlier", workerId: "anna", authorId: "anna", status: "confirmed",
  date: "2026-11-18", projectId: "required-review", narrative: "Own historical work",
};
const reviewState = { ...state, supportsInvoiceDrafts: true, supportsInvoiceCreation: true, entries: [reviewEntry, ownHistorical],
  policies: [{ scope: "firm", targetId: "firm", effectiveFrom: "2020-01-01", revision: 1, reviewerId: "anna" },
    { scope: "project", targetId: "required-review", effectiveFrom: "2020-01-01", revision: 1, reviewerId: "ben" }] };
const reviewDirectory: BackOfficeState = {
  scope: "local", directoryId: "invoice-fixture", model: defaultBackOfficeModel(),
  permissions: { finance: true, edit: true, model: true, userId: "anna" },
  records: [], views: [], sync: { enabled: false, cursor: 0, pending: 0, error: null },
};
let officeFailure = 0, timesheetFailure = 0, activeTimesheetUser = "anna";
const invoiceWrites: TimesheetCommand[] = [];
let creationSupported = true;
let invoiceDocumentsRead: string[] = [];
const issuedOn = "2026-11-19";
const invoiceRecord = BackOfficeRecordSchema.parse({
  id: "773dc6f1-d404-47fe-9bbb-2099191b2b1f", objectId: "invoices", ownerId: "anna", access: "org", members: [],
  values: { name: "Invoice 439", status: "Issued", invoiceNumber: "439", issuedOn },
  revision: 1, schemaRevision: 1, createdAt: issuedOn + "T12:00:00Z", updatedAt: issuedOn + "T12:00:00Z", archivedAt: null,
});
let recordsMode = false, finance = true;
const realFetch = globalThis.fetch;
const fetchReview: typeof globalThis.fetch = Object.assign(async (resource: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(resource instanceof Request ? resource.url : resource.toString());
  if (url.origin !== reviewOrigin) return realFetch(resource, init);
  if (url.pathname === "/back-office/projects") return Response.json({ projects: [] });
  if (url.pathname === "/back-office/time-members") return Response.json({ members: [] });
  if (url.pathname.endsWith("/document")) {
    const format = url.searchParams.get("format") ?? "";
    invoiceDocumentsRead.push(format);
    return new Response(null, { status: 404 });
  }
  if (url.pathname === "/back-office/timesheet") {
    if (timesheetFailure === 408) throw new TypeError("Fixture connection timed out");
    if (timesheetFailure) return Response.json({ message: "Fixture timesheet access denied" }, { status: timesheetFailure });
    const command: TimesheetCommand | undefined = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (command) {
      invoiceWrites.push(command);
      assert.equal(command.type, "createInvoice");
    }
    return Response.json({ ...reviewState, supportsInvoiceCreation: creationSupported, userId: activeTimesheetUser, invoices: [],
      ...(recordsMode ? { service: "records" } : {}) });
  }
  assert.equal(url.pathname, "/back-office");
  if (officeFailure) return new Response("Fixture directory temporarily unavailable", { status: officeFailure });
  return Response.json({ ...reviewDirectory, records: [invoiceRecord], permissions: { ...reviewDirectory.permissions, finance } });
}, realFetch);
globalThis.fetch = fetchReview;
try {
  await act(async () => root.render(<QueryClientProvider client={reviewCache}>
    <MemoryRouter initialEntries={["/time/review?date=2026-11-19"]}><WindowHistory />
      <WorkspaceHeaderTarget.Provider value={header}><BackOfficePage client={reviewClient} /></WorkspaceHeaderTarget.Provider>
    </MemoryRouter>
  </QueryClientProvider>));
  const invoiceEditor = () => document.querySelector(".bo-invoice-draft");
  const amount = () => invoiceEditor()?.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
  const refreshReview = (source: "directory" | "timesheet") => act(async () => {
    await reviewCache.invalidateQueries({ queryKey: ["back-office", reviewOrigin], predicate: query =>
      source === "directory" ? query.queryKey[2] === "auto" : query.queryKey[3] === "timesheet" });
  });
  const invoiceTab = () => document.querySelector<HTMLButtonElement>('[data-panel-tab-id="timekeeping:invoices"] button[aria-pressed]');
  await until(invoiceTab);
  const invoicePane = invoiceTab()?.closest("[data-document-pane]");
  assert.ok(invoicePane?.querySelector('[data-panel-tab-id="timekeeping:entries"]'));
  assert.equal(invoiceTab()?.getAttribute("aria-pressed"), "true", "the old billing review URL opens Invoices");
  const headerDate = () => header.querySelector<HTMLInputElement>('input[type="date"]')?.value;
  const period = () => header.querySelector('.bo-time-period [aria-pressed="true"]')?.textContent;
  const previousDay = header.querySelector<HTMLButtonElement>('button[aria-label="Previous day"]');
  assert.ok(previousDay, "date navigation renders in the window header");
  await act(async () => previousDay.click());
  assert.equal(headerDate(), "2026-11-18");
  await press("Week");
  assert.equal(period(), "Week");
  await press("Window back");
  assert.equal(period(), "Day");
  assert.equal(headerDate(), "2026-11-18");
  await press("Window back");
  assert.equal(headerDate(), "2026-11-19");
  await press("Window forward");
  assert.equal(headerDate(), "2026-11-18");
  await press("Window forward");
  assert.equal(period(), "Week");
  assert.equal(invoiceTab()?.closest("[data-document-pane]"), invoicePane);
  await press("Window back");
  await press("Window back");
  const openInvoice = async () => {
    await until(invoiceTab);
    if (invoiceTab()?.getAttribute("aria-pressed") !== "true") await act(async () => invoiceTab()?.click());
    await press("Create Invoice");
    await selectOption("Matter", "Test matter");
    const selection = invoiceEditor()?.querySelector<HTMLElement>('[role="checkbox"][aria-label="Select entry: Fixture invoice line"]');
    assert.ok(selection);
    await act(async () => selection.click());
    const pricing = invoiceEditor()?.querySelector<HTMLDetailsElement>(".bo-invoice-disclosure");
    assert.ok(pricing);
    await act(async () => { pricing.open = true; });
    await selectOption("Fee basis", "Fixed price");
  };
  await openInvoice();
  const fixedPrice = amount();
  assert.ok(fixedPrice);
  await input(fixedPrice, "125.50");

  const entriesTab = document.querySelector<HTMLButtonElement>('[data-panel-tab-id="timekeeping:entries"] button[aria-pressed]');
  assert.ok(entriesTab);
  await act(async () => entriesTab.click());
  await until(() => document.querySelector(".time-ledger-pane:not([hidden])"));
  assert.equal(invoiceEditor(), null, "switching away detaches the draft from the visible pane");
  const reviewLink = invoiceTab();
  assert.ok(reviewLink);
  await act(async () => reviewLink.click());
  await until(invoiceEditor);
  assert.equal(amount(), fixedPrice);
  assert.equal(fixedPrice.value, "125.50");

  timesheetFailure = 408;
  await refreshReview("timesheet");
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes("connection timed out"));
  assert.equal(amount(), fixedPrice);
  assert.equal(fixedPrice.value, "125.50");
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
  assert.equal(amount(), fixedPrice);
  assert.equal(fixedPrice.value, "125.50");

  timesheetFailure = 403;
  await refreshReview("timesheet");
  await until(() => !invoiceEditor());
  timesheetFailure = 408;
  await refreshReview("timesheet");
  assert.equal(invoiceEditor(), null, "a timeout after revoked access cannot restore the last draft");
  timesheetFailure = 0;
  await press("Try again");
  await openInvoice();
  assert.equal(amount()?.value, "", "access recovery opens a fresh editor");

  officeFailure = 401;
  await refreshReview("directory");
  await until(() => !invoiceEditor());
  officeFailure = 503;
  await refreshReview("directory");
  assert.equal(invoiceEditor(), null, "a directory denial cannot reuse an older identity on a later outage");
  officeFailure = 0;
  await press("Try again");
  await openInvoice();
  assert.equal(amount()?.value, "");

  await input(amount()!, "125.50");
  await press("Create Invoice");
  await until(() => !invoiceEditor(), "saved directly from the editor");
  assert.equal(invoiceWrites.length, 1);
  assert.ok(invoiceWrites[0].type === "createInvoice");
  assert.equal(invoiceWrites[0].invoice.pricing.mode, "fixed");
  assert.equal(invoiceDocumentsRead.length, 0);
  assert.equal(document.querySelector('[data-panel-tab-id="timekeeping:invoice-approval"]'), null);
  await selectOption("View", "Issued invoices");
  const row = () => document.querySelector(`[data-workspace-tab="invoices"] [data-record-id="${invoiceRecord.id}"]`);
  await until(row, "invoice register uses the directory grid");
  assert.match(row()?.textContent ?? "", /Invoice 439/);
  assert.equal(findButton("PDF"), undefined);
  assert.equal(findButton("Word"), undefined);
  activeTimesheetUser = "different-account";
  await refreshReview("timesheet");
  await until(() => !invoiceEditor() && !findButton("Create Invoice"), "a snapshot for another account is never presented");

  await act(async () => root.render(null));
  reviewCache.clear();
  recordsMode = true;
  activeTimesheetUser = "anna";
  const { usePanelTabStore } = await import("../../src/react-app/domains/session/panel/panel-tab-store");
  const store = usePanelTabStore.getState();
  const scope = Object.keys(store.sessions).find(id => id.startsWith("timekeeping:"));
  assert.ok(scope);
  store.closeTab(scope, "timekeeping:invoices");
  store.setPaneSizes(scope, "workday", { main: 55, side: 45 });
  localStorage.removeItem(scope + ":invoice-tab-added");
  const mountRecords = () => act(async () => root.render(<QueryClientProvider client={reviewCache}>
    <MemoryRouter initialEntries={["/time"]}><BackOfficePage client={reviewClient} /></MemoryRouter>
  </QueryClientProvider>));
  store.openTab(scope, { id: "timekeeping:invoice-approval", type: "workspace-page", label: "Invoice approval" }, "side");
  await mountRecords();
  await until(() => !usePanelTabStore.getState().sessions[scope]?.tabs.some(tab => tab.id === "timekeeping:invoice-approval"), "retired invoice approval tab is removed");
  await until(invoiceTab, "saved workspace gets the invoices tab");
  const migrated = usePanelTabStore.getState().sessions[scope];
  assert.deepEqual(migrated.panes.find(pane => pane.id === "main")?.tabIds, ["timekeeping:entries", "timekeeping:invoices"]);
  assert.equal(migrated.sizes.workday.main, 55, "introducing Invoices keeps a saved split");
  await act(async () => invoiceTab()?.click());
  await until(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-workspace-tab="invoices"] button'))
    .some(button => button.textContent?.trim() === "Record existing invoice" && !button.disabled), "records-only mode opens the invoice register");
  assert.equal(document.querySelector(".bo-invoice-draft"), null, "the records service does not open the approval workflow");
  recordsMode = false;
  creationSupported = false;
  await refreshReview("timesheet");
  await until(() => document.body.textContent?.includes("update the connected firm service"), "the workflow explains why invoice creation is unavailable");
  assert.equal(findButton("Create Invoice"), undefined);
  assert.equal(document.querySelector('[data-panel-tab-id="timekeeping:invoice-approval"]'), null);
  recordsMode = true;
  finance = false;
  await refreshReview("directory");
  await until(() => !invoiceTab(), "revoking finance access removes the invoices tab");
  assert.equal(document.querySelector('[data-workspace-tab="invoices"]'), null);

} finally {
  await act(async () => root.render(null));
  reviewCache.clear();
  globalThis.fetch = realFetch;
}
await window.happyDOM.abort();
console.log("Timesheet workspace refresh regressions passed");
