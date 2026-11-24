import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { TimesheetCommand, TimesheetState, TimeEntry, TimePolicy } from "@legalwork/types/timesheet";
import type { LegalworkExtensionActionCall, LegalworkExtensionActionResult } from "../../src/app/lib/legalwork-server";
import type { BackOfficeState } from "../../src/react-app/domains/back-office/api";
import type { CaptureAction, CaptureProposal, CaptureSettings, CaptureState, StopwatchAction, StopwatchState } from "@legalwork/types/time-capture";

const window = new Window({ url: "http://localhost" });
let workspaceWidth = 1100;
const workspaceObservers = new Set<ResizeObserverCallback>();
const calendarObservers = new WeakMap<Element, ResizeObserverCallback>();
class WorkspaceResizeObserver extends window.ResizeObserver {
  private workspace = false;
  constructor(private readonly change: ResizeObserverCallback) { super(change); }
  observe(target: Element) {
    if (target.hasAttribute("data-calendar-time-grid")) calendarObservers.set(target, this.change);
    if (target.hasAttribute("data-document-layout")) {
      this.workspace = true;
      workspaceObservers.add(this.change);
    }
    super.observe(target);
  }
  disconnect() {
    if (this.workspace) workspaceObservers.delete(this.change);
    super.disconnect();
  }
}
const offsetWidth = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetWidth")?.get;
const offsetLeft = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "offsetLeft")?.get;
const rectangle = window.HTMLElement.prototype.getBoundingClientRect;
Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    if (this.hasAttribute("data-document-layout") || this.hasAttribute("data-group")) return workspaceWidth;
    if (this.hasAttribute("data-panel")) return Math.round(workspaceWidth * (Number(this.style.flexGrow) || 50) / 100);
    return offsetWidth?.call(this) ?? 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "offsetLeft", {
  configurable: true,
  get() {
    const preceding = this.parentElement?.firstElementChild;
    if (preceding instanceof window.HTMLElement && (this.id === "side" || this.hasAttribute("data-separator"))) {
      return preceding.offsetWidth + (this.id === "side" ? 1 : 0);
    }
    return offsetLeft?.call(this) ?? 0;
  },
});
Object.defineProperty(window.HTMLElement.prototype, "ariaDisabled", {
  configurable: true,
  get() { return this.getAttribute("aria-disabled"); },
});
window.HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.hasAttribute("data-calendar-hours")) {
    const grid = this.closest("[data-calendar-time-grid]");
    return new window.DOMRect(0, -(grid?.scrollTop ?? 0), 52, Number.parseFloat(this.style.height));
  }
  if (this.hasAttribute("data-panel") || this.hasAttribute("data-separator")) {
    return new window.DOMRect(this.offsetLeft, 0, this.offsetWidth || 1, 500);
  }
  return rectangle.call(this);
};
window.document.write("<!doctype html><html><body><div id='root'></div></body></html>");
Object.entries({
  window,
  document: window.document,
  navigator: window.navigator, sessionStorage: window.sessionStorage,
  localStorage: window.localStorage,
  CSS: window.CSS,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  DOMRect: window.DOMRect,
  DOMParser: window.DOMParser,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Event: window.Event,
  PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: WorkspaceResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true }));

// Initialize Lexical after the test DOM exists and before the shared composer is loaded.
// The Bun DOM fixture has no asset bundler. Panel avatar URLs are supplied by Vite in the app.
const { mock } = await import("bun:test");
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-animation", () => ({ assistantAvatarAnimations: {} }));
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-assets", () => ({
  assistantAvatarImages: {}, assistantAvatarIcon: () => "flower",
}));
const { t } = await import("../../src/i18n");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { WorkdayTimeline, WorkdayCorrectionForm } = await import(
  "../../src/react-app/domains/back-office/timesheet-workday-view"
);
const { createRoot } = await import("react-dom/client");
const { TimesheetLedger } = await import("../../src/react-app/domains/back-office/timesheet-ledger");
const { decodeTimeRow, timeRowMime } = await import(
  "../../src/react-app/domains/back-office/timesheet-clipboard"
);
const { BackOfficeTheme } = await import("../../src/react-app/domains/back-office/twenty-controls");
const base: TimeEntry = {
  id: "old-id",
  workerId: "anna",
  authorId: "ben",
  revision: 4,
  status: "approved",
  source: "manual",
  groupId: "old-group",
  date: "2026-11-12",
  matterId: "matter",
  clientId: "client",
  projectId: "p1",
  activity: "MOD",
  narrative: "Original",
  workedMinutes: 34,
  billable: true,
  billableMinutes: 30,
  workProductId: "wp",
  workProductTitle: "Memo",
  hourlyRate: 480,
  currency: "EUR",
  startAt: "2026-11-12T09:00:00Z",
  endAt: "2026-11-12T09:34:00Z",
  history: [],
};
const state: TimesheetState = {
  userId: "anna",
  scope: "local",
  canManage: true,
  supportsTimeAllocations: true,
  canReview: true,
  entries: [base],
  policies: [],
  invoices: [],
  matters: [{ id: "matter", name: "M", reference: "26/12", clientIds: ["client"] }],
  clients: [{ id: "client", name: "Client" }],
  projects: [{ id: "p1", name: "Project", matterIds: ["matter"] }],
  people: [
    { id: "anna", name: "Anna" },
    { id: "ben", name: "Ben", canRecordTimeFor: true },
  ],
  products: [
    { id: "wp2", name: "Memo", matterId: "matter", authorId: "ben", createdAt: "2026-11-11T10:00:00Z" },
    { id: "wp", name: "Memo", matterId: "matter", authorId: "anna", createdAt: "2026-11-12T09:00:00Z" },
  ],
};
const commands: TimesheetCommand[] = [];
let failOnce = false;
const send = async (command: TimesheetCommand) => {
  commands.push(command);
  if (failOnce) {
    failOnce = false;
    throw Error("Offline");
  }
};
const root = createRoot(document.getElementById("root")!);
const area = (row: string) => {
  if (row === "new" && !document.querySelector('[data-time-row="new"]')) {
    const add = document.querySelector<HTMLButtonElement>(".time-new-entry");
    assert.ok(add);
    act(() => add.click());
  }
  const result = document.querySelector<HTMLElement>('[data-time-row="' + row + '"]');
  assert.ok(result);
  return result;
};
const cell = (row: string, key: string) => {
  const result = area(row).querySelector<HTMLInputElement>('input[data-column="' + key + '"]');
  assert.ok(result);
  return result;
};
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const write = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    assert.ok(write);
    element.focus();
    write.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}
async function key(element: HTMLInputElement, value: string) {
  await act(async () =>
    element.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true })),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
}
async function clip(element: Element, type: string, clipboard: DataTransfer) {
  await act(async () => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboard });
    element.dispatchEvent(event);
  });
}
try {
  localStorage.setItem("legalwork.timekeeping.duration-format", "minutes");
  // Exercise the optional recorded-time allocations throughout the keyboard tests.
  localStorage.setItem("legalwork.timesheet.columns." + state.scope + ":" + state.userId, JSON.stringify(["worked"]));
  await act(async () => root.render(<MemoryRouter><BackOfficeTheme><TimesheetLedger
    state={{ ...state, entries: [{ ...base, status: "pending" }] }} initialDate={base.date} onCommand={send} /></BackOfficeTheme></MemoryRouter>));
  const decline = () => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="' + t("timesheets.ledger.decline") + '"]');
    assert.ok(button);
    return button;
  };
  const deletionChoice = (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === label);
    assert.ok(button);
    return button;
  };
  await act(async () => decline().click());
  assert.equal(commands.length, 0);
  await act(async () => deletionChoice(t("common.cancel")).click());
  assert.equal(commands.length, 0);
  await act(async () => decline().click());
  await act(async () => deletionChoice(t("timesheets.remove.confirm")).click());
  assert.deepEqual(commands.pop(), { type: "decline", entries: [{ id: base.id, revision: base.revision }] });
  await act(async () => root.render(null));
  const suggestionId = crypto.randomUUID();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <TimesheetLedger
            state={state}
            onCommand={send}
            initialDraft={{
              key: suggestionId,
              entry: base,
              source: "suggestion",
              proposalDigest: "a".repeat(64),
            }}
          />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  const optionsButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "Options");
  assert.ok(optionsButton);
  await act(async () => optionsButton.click());
  const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
  const selectedLabel = area("new").querySelector('[data-column="billableWork"]')?.getAttribute("aria-label");
  const option = menuItems().find(item => item.textContent?.trim() === selectedLabel);
  assert.ok(option);
  await act(async () => option.click());
  assert.equal(document.querySelector('[role="columnheader"][data-field="billableWork"]'), null);
  assert.ok(JSON.parse(localStorage.getItem("legalwork.timesheet.columns." + state.scope + ":" + state.userId)!).includes("billableWork"));
  await act(async () => option.click());
  assert.ok(document.querySelector('[role="columnheader"][data-field="billableWork"]'));
  await act(async () => optionsButton.click());
  assert.equal(document.querySelectorAll("[data-time-row]")[1]?.getAttribute("data-time-row"), "new");
  await key(cell("new", "narrative"), "Enter");
  const suggest = commands.at(-1);
  assert.ok(suggest?.type === "create");
  assert.equal(suggest.entry.startAt, base.startAt);
  assert.equal(suggest.source, "suggestion");
  assert.equal(suggest.requestId, suggestionId);
  const sourceCheckbox = area(base.id).querySelector<HTMLInputElement>("input[type='checkbox']");
  assert.ok(sourceCheckbox);
  await act(async () => {
    sourceCheckbox.focus();
    sourceCheckbox.click();
  });
  assert.equal(sourceCheckbox.checked, true);
  const clipboard = new window.DataTransfer();
  await clip(sourceCheckbox, "copy", clipboard);
  const payload = clipboard.getData(timeRowMime);
  assert.ok(payload);
  for (const privateField of [
    "revision",
    "workerId",
    "authorId",
    "source",
    "groupId",
    "currency",
    "hourlyRate",
    "startAt",
    "endAt",
    "status",
    "history",
  ])
    assert.ok(!(privateField in JSON.parse(payload)), privateField);
  assert.equal(decodeTimeRow("", clipboard.getData("text/plain"))?.workProductId, "wp");
  const date = document.querySelector<HTMLInputElement>(".bo-time-toolbar input[type=date]");
  assert.ok(date);
  await input(date, "2026-11-13");
  await clip(cell("new", "narrative"), "paste", clipboard);
  assert.equal(commands.length, 1);
  assert.equal(cell("new", "narrative").value, "Original");
  assert.equal(cell("new", "date").value, "2026-11-13");
  await input(cell("new", "narrative"), "Edited copy");
  await input(date, "2026-11-14");
  assert.equal(date.value, "2026-11-13");
  assert.equal(cell("new", "date").value, "2026-11-13", "Navigation must not redate an unfinished row");
  await clip(cell("new", "narrative"), "paste", clipboard);
  assert.equal(cell("new", "narrative").value, "Edited copy");
  failOnce = true;
  await key(cell("new", "charge"), "Tab");
  assert.equal(cell("new", "narrative").value, "Edited copy");
  await key(cell("new", "charge"), "Tab");
  const pasted = commands.at(-1),
    retry = commands.at(-2);
  assert.ok(pasted?.type === "create" && retry?.type === "create");
  assert.equal(pasted.requestId, retry.requestId);
  assert.notEqual(pasted.requestId, suggestionId);
  assert.equal(pasted.entry.workProductId, "wp");
  assert.equal(pasted.entry.startAt, undefined);
  assert.deepEqual(pasted.workerIds, ["anna"]);
  assert.equal(pasted.entry.projectId, "p1");
  await input(cell("new", "activity"), "MOD");
  await input(cell("new", "narrative"), "More work");
  await input(cell("new", "billableWork"), "20");
  await input(cell("new", "product"), "Memo");
  const beforeDuplicate = commands.length;
  await key(cell("new", "charge"), "Enter");
  assert.equal(commands.length, beforeDuplicate);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Several work products/);
  const productOptions = Array.from(cell("new", "product").list?.querySelectorAll("option") ?? []);
  const chosenProduct = productOptions.find((o) => o.value.includes("Ben") && o.value.includes("wp2"));
  assert.ok(chosenProduct);
  await input(cell("new", "product"), chosenProduct.value);
  await key(cell("new", "charge"), "Enter");
  const modified = commands.at(-1);
  assert.ok(modified?.type === "create");
  assert.equal(modified.entry.workProductId, "wp2");
  await input(cell("new", "activity"), "DFT");
  await input(cell("new", "date"), "2026-11-14");
  assert.equal(date.value, "2026-11-13");
  await input(cell("new", "narrative"), "Separate brief");
  await input(cell("new", "billableWork"), "20");
  await input(cell("new", "product"), "Memo");
  const separate = area("new").querySelector<HTMLButtonElement>(
    'button[aria-label="Create a separate work product"]',
  );
  assert.ok(separate);
  await act(async () => separate.click());
  await key(cell("new", "charge"), "Enter");
  const fresh = commands.at(-1);
  assert.ok(fresh?.type === "create");
  assert.equal(fresh.entry.workProductId, undefined);
  assert.equal(fresh.entry.createWorkProduct, true);
  assert.equal(fresh.entry.workProductTitle, "Memo");
  assert.equal(fresh.entry.date, "2026-11-14");
  assert.equal(cell("new", "date").value, "2026-11-13");
  const offDayEntry: TimeEntry = {
    ...base, id: crypto.randomUUID(), groupId: fresh.requestId, status: "confirmed",
    date: fresh.entry.date, narrative: fresh.entry.narrative,
  };
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme>
      <TimesheetLedger state={{ ...state, entries: [base, offDayEntry] }} onCommand={send} />
    </BackOfficeTheme></MemoryRouter>,
  ));
  assert.ok(area(offDayEntry.id).closest(".time-created-entry"));
  const offDayCell = area(offDayEntry.id).querySelector<HTMLElement>('[data-column="narrative"]');
  assert.ok(offDayCell);
  await act(async () => offDayCell.click());
  assert.ok(cell(offDayEntry.id, "narrative"), "an off-day workflow row can be edited from its receipt");
  const cancelOffDayEdit = area(offDayEntry.id).querySelector<HTMLButtonElement>('button[aria-label="Discard edits"]');
  assert.ok(cancelOffDayEdit);
  await act(async () => cancelOffDayEdit.click());
  const receiptLink = document.querySelector<HTMLButtonElement>(".time-created-date");
  assert.ok(receiptLink);
  assert.match(receiptLink.parentElement?.textContent ?? "", /Separate brief/);
  await act(async () => receiptLink.click());
  assert.equal(date.value, "2026-11-14");
  assert.equal(document.querySelector(".time-booking-receipt"), null);
  await input(date, "2026-11-13");
  for (let i = 0; i < 14; i++) {
    await input(cell("new", "activity"), "RES");
    await input(cell("new", "narrative"), "Research " + i);
    await input(cell("new", "billableWork"), "20");
    await key(cell("new", "charge"), "Tab");
    assert.equal(document.activeElement, cell("new", "matter"));
  }
  await input(cell("new", "activity"), "RES");
  await input(cell("new", "narrative"), "Long session");
  await input(cell("new", "billableWork"), "150");
  await input(cell("new", "charge"), "149");
  const countBeforeCap = commands.length;
  await key(cell("new", "narrative"), "Enter");
  assert.equal(commands.length, countBeforeCap, "strict increment still applies to long sessions");
  await input(cell("new", "charge"), "150");
  assert.match(document.querySelector(".bo-time-cap")?.textContent ?? "", /120-minute/);
  await key(cell("new", "narrative"), "Enter");
  const longCommand = commands.at(-1);
  assert.ok(longCommand?.type === "create");
  assert.equal(longCommand.entry.billableMinutes, 150);
  assert.equal(longCommand.entry.workedMinutes, 150);
  const long: TimeEntry = {
    ...base,
    ...longCommand.entry,
    workerId: "anna",
    status: "confirmed",
    id: "long-line",
  };
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <TimesheetLedger state={{ ...state, entries: [base, long] }} onCommand={send} />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  assert.ok(area(long.id).querySelector(".bo-time-cap-icon"));
  const submitButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === "Submit period",
  );
  assert.ok(submitButton);
  await act(async () => submitButton.click());
  const submitted = commands.at(-1);
  assert.ok(submitted?.type === "submit");
  assert.deepEqual(submitted.entries, [{ id: long.id, revision: long.revision }]);
  const entry: TimeEntry = { ...base, status: "submitted" };
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <TimesheetLedger state={{ ...state, entries: [entry] }} onCommand={send} />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  await input(date, base.date);
  const existing = area(base.id).querySelector<HTMLElement>('[data-column="narrative"]');
  assert.ok(existing);
  await act(async () => existing.click());
  const beforeEdit = commands.length;
  await key(cell(base.id, "narrative"), "Enter");
  assert.equal(commands.length, beforeEdit, "Inspecting a submitted cell must not reopen the entry");
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="narrative"]')?.click());
  await input(cell(base.id, "narrative"), "Cancelled");
  await key(cell(base.id, "narrative"), "Escape");
  assert.equal(commands.length, beforeEdit);
  assert.equal(area(base.id).querySelector('[data-column="narrative"]')?.textContent, "Original");
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="narrative"]')?.click());
  await input(cell(base.id, "narrative"), "Corrected");
  await key(cell(base.id, "charge"), "Tab");
  const update = commands.at(-1);
  assert.ok(update?.type === "update");
  assert.equal(update.revision, 4);
  assert.equal(update.entry.narrative, "Corrected");
  assert.equal(update.entry.startAt, base.startAt);
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="billableWork"]')?.click());
  await input(cell(base.id, "billableWork"), "55");
  await key(cell(base.id, "charge"), "Tab");
  const resized = commands.at(-1);
  assert.ok(resized?.type === "update");
  assert.equal(resized.entry.startAt, undefined);
  // A shared meeting can be logged for both workers in a weekly list.
  const weekButton = [...document.querySelectorAll<HTMLButtonElement>(".bo-time-period button")].find(button => button.textContent === "Week");
  assert.ok(weekButton);
  await act(async () => weekButton.click());
  assert.equal(document.querySelectorAll(".bo-time-week button").length, 7);
  await input(cell("new", "matter"), "26/12 · Project");
  await input(cell("new", "workers"), "Anna");
  await input(cell("new", "activity"), "INM");
  await input(cell("new", "narrative"), "Meeting");
  await input(cell("new", "billableWork"), "20");
  await input(cell("new", "nonBillable"), "10");
  const addPerson = document.querySelector<HTMLButtonElement>(".bo-time-add-person");
  assert.ok(addPerson);
  await act(async () => addPerson.click());
  const participant = document.querySelector(".bo-time-participant");
  const personSelect = participant?.querySelector("select");
  assert.ok(personSelect);
  await act(async () => {
    personSelect.value = "ben";
    personSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const extra = participant!.querySelectorAll("input");
  await input(extra[0], "10");
  await input(extra[1], "5");
  await key(cell("new", "charge"), "Tab");
  const meeting = commands.at(-1);
  assert.ok(meeting?.type === "create");
  assert.deepEqual(meeting.workerIds, ["anna", "ben"]);
  assert.equal(meeting.entry.workedMinutes, 30);
  assert.equal(meeting.entry.nonBillableMinutes, 10);
  assert.deepEqual(meeting.workerTimes, [{ workerId: "ben", workedMinutes: 15, nonBillableMinutes: 5, billableMinutes: 10 }]);
  const { fromDraft, matterOptions, parseRow, workerOptions } = await import(
    "../../src/react-app/domains/back-office/timesheet-row"
  );
  const caseMatches = {
    ...state,
    people: [...state.people, { id: "second", name: "ANNA", canRecordTimeFor: true }],
    matters: [...state.matters, { ...state.matters[0], id: "second-matter", name: "m" }],
  };
  const distinctWorker = workerOptions(caseMatches).find((p) => p.id === "second");
  const distinctMatter = matterOptions(caseMatches).find((m) => m.matterId === "second-matter");
  assert.ok(distinctWorker && distinctMatter);
  const chosen = parseRow({
    ...fromDraft({ ...base, workProductId: undefined, workProductTitle: undefined }, distinctWorker.label, base.date, caseMatches),
    matter: distinctMatter.label,
  }, caseMatches);
  assert.ok("entry" in chosen);
  assert.deepEqual(chosen.workerIds, ["second"]);
  assert.equal(chosen.entry.matterId, "second-matter");
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <TimesheetLedger state={{ ...state, entries: [entry] }} onCommand={send} canEdit={false} />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  assert.equal(document.querySelector('[data-time-row="new"]'), null);
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="billableWork"]')?.click());
  assert.equal(area(base.id).querySelector('[data-column="billableWork"] input'), null);
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <TimesheetLedger state={state} onCommand={send} />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    area(base.id)
      .querySelector<HTMLButtonElement>('button[aria-label="Show revision history"]')
      ?.click(),
  );
  const button = (text: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === text,
    );
  const ask = button("Request correction");
  assert.ok(ask);
  await act(async () => ask.click());
  const form = document.querySelector<HTMLFormElement>(".bo-time-original form");
  assert.ok(form);
  const fields = form.querySelectorAll("input");
  await input(fields[0], "Corrected after invoicing");
  await input(fields[1], "20");
  await input(fields[2], "Wrong description");
  await act(async () =>
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  const adjustment = commands.at(-1);
  assert.ok(adjustment?.type === "adjust");
  assert.equal(adjustment.id, base.id);
  assert.equal(adjustment.reason, "Wrong description");
  assert.equal(adjustment.billableMinutes, 20);
  const capture = {
    key: crypto.randomUUID(),
    digest: "a".repeat(64),
    source: "calendar" as const,
    projectId: "p1",
    date: base.date,
    activity: "EXM",
    narrative: "Timed suggestion",
    startAt: base.startAt!,
    endAt: base.endAt!,
    workedMinutes: 34,
    dismissed: false,
  };
  const unknown = {
    ...capture,
    key: crypto.randomUUID(),
    narrative: "Untimed",
    startAt: null,
    endAt: null,
    workedMinutes: null,
  };
  const estimated = { ...unknown, key: crypto.randomUUID(), source: "documents" as const, estimatedMinutes: 8,
    estimateReason: "Two recorded amendments support an estimate.", narrative: "Amending the memo" };
  const directory = {
    ...state,
    matters: [
      ...state.matters,
      { id: "other", name: "Unused matter", reference: "", clientIds: ["client"] },
    ],
  };
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <WorkdayTimeline
            date={base.date}
            proposals={[capture, unknown, estimated]}
            state={directory}
            view="combined"
            selected={undefined}
            onOpen={() => {}}
          />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  const axis = document.querySelector<HTMLElement>("[data-calendar-time-grid]");
  assert.ok(axis);
  const resizeCalendar = async (height: number, width: number, clamped = false) => {
    const observer = calendarObservers.get(axis);
    assert.ok(observer, "timeline measures its scroll viewport");
    Object.defineProperty(axis, "clientHeight", { configurable: true, value: height });
    Object.defineProperty(axis, "clientWidth", { configurable: true, value: width });
    await act(async () => {
      if (clamped) { axis.scrollTop = 0; axis.dispatchEvent(new window.Event("scroll")); }
      observer([], {} as ResizeObserver);
    });
  };
  const calendarHeight = () => Number.parseFloat(axis.querySelector<HTMLElement>("[data-calendar-hours]")!.style.height);
  const timeBlock = () => Number.parseFloat(axis!.querySelector<HTMLElement>("[data-calendar-column] [data-proposal-id]")!.style.top);
  await resizeCalendar(640, 600);
  const originalDayHeight = calendarHeight(), originalBlockTop = timeBlock();
  assert.ok(originalBlockTop > 0 && originalBlockTop < originalDayHeight);
  await act(async () => { axis.scrollTop = 240; axis.dispatchEvent(new window.Event("scroll")); });
  await resizeCalendar(1600, 900, true);
  assert.ok(calendarHeight() > 1600, "a tall external-display window still scrolls vertically");
  assert.equal(axis.scrollTop / calendarHeight(), 240 / originalDayHeight, "enlarging the window keeps the top hour");
  assert.equal(timeBlock() / calendarHeight(), originalBlockTop / originalDayHeight, "a timed event stays at its recorded clock time");
  await resizeCalendar(1600, 620, true);
  assert.equal(axis.scrollTop / calendarHeight(), 240 / originalDayHeight, "reparenting a pane at the same height keeps its position");
  await resizeCalendar(640, 600, true);
  assert.equal(axis.scrollTop, 240);
  assert.equal(axis.querySelectorAll("[data-calendar-column] [data-proposal-id]").length, 1, "recorded work stays in the ledger");
  assert.equal(axis.querySelectorAll("[data-calendar-column]").length, 1);
  assert.equal(axis.querySelector("[data-calendar-now]"), null);
  assert.match(document.querySelector("[data-calendar-untimed]")?.textContent ?? "", /Untimed/);
  assert.match(document.querySelector("[data-calendar-untimed]")?.textContent ?? "", /Estimated 8 min/);
  assert.ok(!axis.textContent?.includes("Unused matter"));
  assert.ok(!axis.querySelector("[data-calendar-column]")?.textContent?.includes("Untimed"));
  const { calendarDay } = await import("../../src/react-app/domains/calendar/calendar-format");
  await act(async () => root.render(
    <WorkdayTimeline date={calendarDay(new Date())} proposals={[]} state={directory}
      view="combined" selected={undefined} onOpen={() => {}} />,
  ));
  assert.match(document.querySelector("[data-calendar-now]")?.textContent ?? "", /Current time/);
  let correctedMinutes: number | null | undefined;
  let correctedRevision: number | undefined;
  let correctedSplit: unknown;
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <WorkdayCorrectionForm
            proposal={estimated}
            draftRevision={4}
            state={directory}
            pending={false}
            close={() => {}}
            save={async (action) => {
              correctedMinutes = action.workedMinutes;
              correctedRevision = action.draftRevision;
              return true;
            }}
          />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  const correction = document.querySelector<HTMLFormElement>("[data-time-source-editor]");
  assert.ok(correction);
  await act(async () =>
    correction.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(correctedMinutes, null, "saving other fields preserves the separately marked estimate");
  assert.match(correction.textContent ?? "", /Estimated 8 min/);
  assert.match(correction.textContent ?? "", /Two recorded amendments/);
  assert.equal(correction.querySelector<HTMLInputElement>('input[inputmode=numeric]')?.value, "8");
  assert.equal(correctedRevision, 4);
  const splitControl = correction.querySelector<HTMLInputElement>("[role=checkbox]");
  assert.ok(splitControl, "calendar suggestions allow splitting");
  await act(async () => splitControl.click());
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <WorkdayCorrectionForm proposal={{ ...unknown, source: "stopwatch" }} state={directory}
            pending={false} close={() => {}} save={async action => {
              correctedSplit = action.split;
              return true;
            }} />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  assert.equal(correction.querySelector("[role=checkbox]"), null, "stopwatch corrections cannot be split");
  correctedSplit = "Not submitted";
  await act(async () => correction.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(correctedSplit, undefined, "a previously selected split is omitted after switching to a stopwatch");
  // A first visit from Workday must carry the proposal through the real Back Office route.
  const { defaultBackOfficeModel } = await import("@legalwork/types/back-office");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
  const { createLegalworkServerClient, LegalworkServerError } = await import("../../src/app/lib/legalwork-server");
  const { TimesheetCommandSchema } = await import("@legalwork/types/timesheet");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
  const writes: TimesheetCommand[] = [];
  const privateWrites: CaptureAction[] = [];
  const workdayDrafts: CaptureState["drafts"] = {};
  const otherProfileDrafts: CaptureState["drafts"] = {};
  let pauseDraft: Promise<void> | undefined;
  let changeNarrativeFromOtherWindow = false;
  let refreshProposalAtAcceptance = false;
  const confirmedEntries: TimeEntry[] = [];
  let captureProfileId = "profile-a";
  const overlayRunId = crypto.randomUUID();
  let activeStopwatch: StopwatchState["active"] = null;
  let lastStopped: StopwatchState["lastStopped"] = null;
  const stopwatchActions: StopwatchAction[] = [];
  let responseLost = false;
  const recordedTimer: CaptureProposal = {
    ...capture, key: crypto.randomUUID(), digest: "0".repeat(64), source: "stopwatch",
    startAt: base.date + "T12:00:00Z", endAt: base.date + "T12:10:00Z",
    activity: "", narrative: "Stopwatch", workedMinutes: 10, projectId: null,
  };
  let workdayReads = 0;
  const client = {
    ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
    privateStopwatch: async (action?: StopwatchAction, profile?: string): Promise<StopwatchState> => {
      assert.equal(profile, captureProfileId);
      if (action) {
        stopwatchActions.push(action);
        if (action.type === "start") {
          assert.equal(activeStopwatch, null);
          activeStopwatch = { id: action.id, startedAt: new Date().toISOString(), matterId: action.matterId };
        } else {
          assert.equal(activeStopwatch?.id, action.id);
          if (action.type === "assign" && activeStopwatch) activeStopwatch = { ...activeStopwatch, matterId: action.matterId };
          if (action.type === "stop") {
            lastStopped = { id: action.id, date: base.date, stoppedAt: base.date + "T12:10:00Z" };
            activeStopwatch = null;
            if (responseLost) throw new Error("Response lost");
          }
        }
      }
      return { profileId: captureProfileId, active: activeStopwatch, lastStopped, enabled: true };
    },
    privateWorkday: async (context: { profileId?: string; date: string }, action?: CaptureAction): Promise<CaptureState> => {
      workdayReads++;
      if (action) privateWrites.push(action);
      const drafts = context.profileId === "profile-a" ? workdayDrafts : otherProfileDrafts;
      if (action?.type === "draft-patch") {
        const pending = pauseDraft;
        pauseDraft = undefined;
        if (pending) await pending;
        const previous = drafts[action.key];
        const revision = (previous?.revision ?? 0) + 1;
        if (previous && changeNarrativeFromOtherWindow && typeof action.changes?.narrative === "string") {
          changeNarrativeFromOtherWindow = false;
          drafts[action.key] = { ...previous, revision, values: { ...previous.values, narrative: "Other window wording" } };
          throw new LegalworkServerError(409, "private_draft_conflict", "This private draft changed in another window.", { draft: drafts[action.key] });
        }
        if (action.changes) drafts[action.key] = { date: action.date, proposalDigest: action.proposalDigest,
          values: { ...(previous?.values ?? action.initial), ...action.changes }, revision };
        else delete drafts[action.key];
        if (refreshProposalAtAcceptance && action.key === capture.key) {
          refreshProposalAtAcceptance = false;
          drafts[action.key].values.narrative = "Confirmed wording from the other window";
        }
      }
      return {
        settings: { calendar: true, tasks: false, aiSuggestions: true, intervalMinutes: 0 },
        proposals: context.profileId === "profile-a" && context.date === base.date
          ? [capture, unknown, ...(lastStopped && lastStopped.id !== overlayRunId ? [recordedTimer] : [])]
          : [],
        drafts, connections: [], modelReady: false, guidelines: [],
        status: { type: "ready", message: "Synthetic internal status" },
      };
    },
    backOffice: async (path: string, options?: { body?: unknown }) => {
      if (path === "/projects") return { projects: [] };
      if (path.startsWith("/timesheet?")) {
        if (options?.body) {
          const command = TimesheetCommandSchema.parse(options.body);
          const query = new URL(path, "http://localhost").searchParams;
          assert.equal(query.get("profileId"), command.type === "create" ? captureProfileId : null);
          if (command.type === "create") {
            const drafts = captureProfileId === "profile-a" ? workdayDrafts : otherProfileDrafts;
            assert.equal(query.get("draftRevision"), String(drafts[command.requestId].revision));
            assert.equal(query.get("draftDate"), drafts[command.requestId].date);
          }
          writes.push(command);
          if (command.type === "create") confirmedEntries.push({
            ...command.entry, id: crypto.randomUUID(), groupId: command.requestId, revision: 1,
            status: "confirmed", workerId: state.userId, authorId: state.userId, history: [],
            source: command.source ?? "manual", proposalDigest: command.proposalDigest,
          });
        }
        return { ...state, entries: confirmedEntries };
      }
      assert.ok(path.startsWith("?manifest="), path);
      return {
        scope: "local",
        directoryId: "synthetic",
        captureProfileId,
        model: defaultBackOfficeModel(),
        records: [],
        permissions: { userId: state.userId, edit: true, model: true, finance: true },
        views: [],
        sync: { enabled: false, cursor: 0, pending: 0, error: null },
      };
    },
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={["/back-office/timesheet-workday?date=" + base.date]}>
          <BackOfficePage client={client} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const block = (proposal: CaptureProposal) => document.querySelector<HTMLButtonElement>(`[data-proposal-id="${proposal.key}"]`);
  async function calendarAction(proposal: CaptureProposal, label: string) {
    const rail = block(proposal)?.parentElement?.querySelector("[data-calendar-proposal-actions]");
    const control = [...rail?.querySelectorAll<HTMLButtonElement>("button") ?? []].find(candidate => candidate.title === label);
    assert.ok(control, label);
    await act(async () => { control.focus(); control.click(); });
  }
  const proposalHeading = () => document.querySelector<HTMLHeadingElement>(".time-workspace-editor h3");
  async function openProposal(proposal: CaptureProposal) {
    for (let i = 0; i < 20 && !block(proposal); i++) await settle();
    const target = block(proposal);
    assert.ok(target, proposal.narrative);
    await act(async () => {
      target.focus();
      target.click();
    });
    for (let i = 0; i < 20 && (!proposalHeading() || document.activeElement !== proposalHeading()); i++) await settle();
    assert.ok(proposalHeading(), "Missing timeline dialog for " + proposal.narrative);
    assert.ok(document.activeElement === proposalHeading(), "activating a proposal takes focus to its editor heading");
    assert.equal(target.getAttribute("aria-expanded"), "true");
    assert.equal(target.getAttribute("aria-controls"), proposalHeading()?.closest("[id].time-workspace-editor")?.id);
  }
  const workspaceGroup = () => {
    const group = document.querySelector<HTMLElement>("[data-document-layout]");
    assert.ok(group);
    return group;
  };
  const panes = () => [...workspaceGroup().querySelectorAll<HTMLElement>("[data-document-pane]")];
  const tabNode = (id: string) => document.querySelector<HTMLElement>(`[data-panel-tab-id="timekeeping:${id}"]`);
  const selectTab = async (id: string) => {
    const target = tabNode(id)?.querySelector<HTMLButtonElement>("button[aria-pressed]");
    assert.ok(target, id);
    await act(async () => target.click());
    assert.equal(target.getAttribute("aria-pressed"), "true");
  };
  const strips = () => [...document.querySelectorAll<HTMLElement>("[data-document-pane] .lw-panel-tab-list")];
  const paneOf = (id: string) => tabNode(id)?.closest(".lw-panel-tab-list");
  const paneOrder = (pane: Element) => [...pane.querySelectorAll<HTMLElement>("[data-panel-tab-id]")]
    .map(el => el.dataset.panelTabId?.replace("timekeeping:", ""));
  async function menuItem(label: string) {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent?.trim() === label);
    assert.ok(item, label);
    await act(async () => item.click());
    await settle();
  }
  async function newTab(label: string) {
    const add = document.querySelector<HTMLButtonElement>('button[aria-label="New tab"]');
    assert.ok(add, "workspace New tab menu");
    await act(async () => { add.focus(); add.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await menuItem(label);
  }
  async function tabMenu(id: string, label: string) {
    const source = tabNode(id);
    assert.ok(source);
    await act(async () => source.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await menuItem(label);
  }
  const moveTab = (id: string, destination: number) => tabMenu(id, "Move to pane " + destination);
  const separator = () => {
    const separator = workspaceGroup().querySelector<HTMLElement>('[role="separator"]');
    assert.ok(separator);
    return separator;
  };
  const press = async (label: string, focus = false) => {
    const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button =>
      button.textContent?.trim() === label || button.getAttribute("aria-label") === label);
    assert.ok(target, label);
    await act(async () => {
      if (focus) target.focus();
      target.click();
    });
  };
  await openProposal(capture);
  const closeSuggestion = document.querySelector<HTMLButtonElement>(".time-workspace-editor [data-slot=dialog-close]");
  assert.ok(closeSuggestion);
  await act(async () => { closeSuggestion.focus(); closeSuggestion.click(); });
  assert.equal(proposalHeading(), null);
  assert.equal(document.activeElement, block(capture));
  assert.equal(block(capture)?.getAttribute("aria-expanded"), "false");
  await openProposal(unknown);
  await act(async () => {
    const handledByChild = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handledByChild.preventDefault();
    proposalHeading()?.dispatchEvent(handledByChild);
  });
  assert.ok(proposalHeading(), "Escape already handled by a child does not close the editor");
  await act(async () => proposalHeading()?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(proposalHeading(), null);
  assert.equal(document.activeElement, block(unknown), "an untimed proposal restores its originating action");
  await openProposal(capture);
  assert.equal(panes().length, 2);
  assert.equal(separator().getAttribute("aria-valuenow"), "67");
  await act(async () => separator().dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
  assert.equal(separator().getAttribute("aria-valuenow"), "62", "the split can be adjusted with the keyboard");
  await newTab("Reset workspace layout");
  assert.equal(separator().getAttribute("aria-valuenow"), "67");
  const initialReads = workdayReads;
  lastStopped = { id: overlayRunId, date: base.date, stoppedAt: base.date + "T12:00:00Z" };
  await act(async () => cache.invalidateQueries({ queryKey: ["private-stopwatch"] }));
  for (let i = 0; i < 20 && workdayReads === initialReads; i++) await settle();
  assert.ok(workdayReads > initialReads, "a stop in the desktop overlay refreshes the open workday");
  const stopwatchTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="Stopwatch"]');
  assert.ok(stopwatchTrigger);
  const selectPopup = async (label: string, value: string) => {
    const select = document.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${label}"]`);
    assert.ok(select, label);
    await act(async () => select.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === value);
    assert.ok(option, value);
    await act(async () => { option.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true })); option.click(); });
    await settle();
  };
  const stopwatchMatter = () => document.querySelector<HTMLButtonElement>('[data-slot="popover-content"] [role="combobox"]');
  await act(async () => { stopwatchTrigger.focus(); stopwatchTrigger.click(); });
  for (let i = 0; i < 20 && document.activeElement !== stopwatchMatter(); i++) await settle();
  assert.equal(document.activeElement, stopwatchMatter());
  assert.equal(button("Start stopwatch")?.disabled, false);
  assert.equal(stopwatchMatter()?.getAttribute("aria-expanded"), "false");
  await act(async () => stopwatchMatter()?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await settle();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("26/12"))!.click());
  await press("Start stopwatch");
  for (let i = 0; i < 20 && document.activeElement !== stopwatchTrigger; i++) await settle();
  assert.equal(document.activeElement, stopwatchTrigger);
  const started = stopwatchActions.at(-1);
  assert.ok(started?.type === "start");
  assert.equal(started.matterId, "matter", "app start updates the same profile snapshot read by the HUD");

  await press("Stopwatch");
  assert.equal(document.querySelector<HTMLInputElement>('[data-slot="popover-content"] input[role="combobox"]')?.value, "M");
  responseLost = true;
  await press("Stop stopwatch");
  for (let i = 0; i < 20 && (!block(recordedTimer) || document.activeElement !== stopwatchTrigger); i++) await settle();
  assert.equal(document.activeElement, stopwatchTrigger);
  assert.ok(block(recordedTimer), "stopping refreshes the selected day's private timeline immediately");
  assert.deepEqual(stopwatchActions.filter(action => action.type === "stop"), [{ type: "stop", id: started.id }]);
  assert.equal(writes.length, 0, "starting or stopping the stopwatch does not book time");

  await press("Stopwatch");
  assert.equal(button("Start stopwatch")?.disabled, false, "a stopwatch can run unassigned");
  await press("Stopwatch");
  assert.ok(stopwatchTrigger.closest('[role="toolbar"]')?.querySelector('input[type="date"]'), "date and stopwatch share the app header");
  const proposalPanel = document.querySelector<HTMLFormElement>('[data-time-proposal]');
  assert.ok(proposalPanel);
  const proposedText = proposalPanel.querySelector<HTMLTextAreaElement>('[data-column="narrative"]');
  const proposedCharge = proposalPanel.querySelector<HTMLInputElement>('[data-column="charge"]');
  assert.equal(proposedText?.value, capture.narrative);
  assert.ok(proposedCharge);
  await input(proposedCharge, "30");
  await act(async () => cache.invalidateQueries({ queryKey: ["back-office"] }));
  assert.equal(document.activeElement, proposedCharge, "a background refresh keeps focus and the in-progress value in the editor");
  assert.equal(proposedCharge.value, "30");
  await press(t("common.edit"), true);
  assert.equal(document.activeElement, proposalHeading());
  const cancelCorrection = document.querySelector<HTMLButtonElement>('[data-time-source-editor] [data-slot=dialog-footer] button[type="button"]');
  assert.ok(cancelCorrection);
  await act(async () => { cancelCorrection.focus(); cancelCorrection.click(); });
  assert.equal(document.activeElement, proposalHeading());
  assert.equal(proposalPanel.querySelector('[data-column="charge"]'), proposedCharge);
  assert.equal(proposedCharge.value, "30", "returning from correction keeps the existing private edit mounted");
  await selectTab("chat");
  await selectTab("timeline");
  assert.equal(proposedCharge.value, "30", "switching tabs preserves the proposal editor and its contents");
  await moveTab("timeline", 1);
  assert.equal(paneOf("timeline"), paneOf("entries"));
  assert.equal(proposedCharge.value, "30", "docking the timeline preserves the selected editor and unsaved proposal edit");
  await moveTab("timeline", 2);
  assert.equal(writes.length, 0, "editing a proposal does not publish it");
  const acceptButton = proposalPanel.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(acceptButton);
  refreshProposalAtAcceptance = true;
  await act(async () => proposalPanel.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(writes.length, 0, "acceptance waits for review when the saved draft differs from the displayed suggestion");
  assert.equal(proposedText?.value, "Confirmed wording from the other window");
  await act(async () => {
    acceptButton.focus();
    proposalPanel.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 20 && block(capture); i++) await settle();
  assert.equal(writes.length, 1);
  assert.equal(block(capture), null);
  assert.equal(document.activeElement, block(recordedTimer), "accepting a focused proposal moves to the next surviving block");
  await selectTab("entries");
  assert.equal(document.querySelectorAll(`[data-time-row="${confirmedEntries[0]?.id}"]`).length, 1);
  await input(cell("new", "narrative"), "First profile's unfinished line");
  await act(async () => cell("new", "narrative").blur());
  assert.ok(privateWrites.some(action => action.type === "draft-patch" && action.changes?.narrative === "First profile's unfinished line"));
  await press("Next day");
  assert.equal(document.querySelector<HTMLInputElement>(".bo-workday-controls input[type=date]")?.value, "2026-11-13");
  assert.equal(cell("new", "narrative").value, "");
  await press("Previous day");
  assert.equal(cell("new", "narrative").value, "First profile's unfinished line");
  let acknowledgeDraft!: () => void;
  pauseDraft = new Promise(resolve => { acknowledgeDraft = resolve; });
  await input(cell("new", "narrative"), "First save in progress");
  await act(async () => cell("new", "narrative").blur());
  await input(cell("new", "narrative"), "Keep newer typing");
  await act(async () => acknowledgeDraft());
  assert.equal(cell("new", "narrative").value, "Keep newer typing", "acknowledgements retain typing made while a draft request is pending");
  changeNarrativeFromOtherWindow = true;
  await act(async () => cell("new", "narrative").blur());
  assert.equal(cell("new", "narrative").value, "Keep newer typing", "same-field conflicts retain the local input");
  assert.match(document.querySelector('[role="alert"].bo-error')?.textContent ?? "", /Other window wording/);
  await press("Use my edit");
  assert.ok(Object.values(workdayDrafts).some(item => item.values.narrative === "Keep newer typing"));
  changeNarrativeFromOtherWindow = true;
  await input(cell("new", "narrative"), "Another unsaved edit");
  await act(async () => cell("new", "narrative").blur());
  await press("Keep saved value");
  assert.equal(cell("new", "narrative").value, "Other window wording");
  await moveTab("chat", 1);
  assert.equal(paneOf("entries"), paneOf("chat"));
  captureProfileId = "profile-b";
  await act(async () => cache.invalidateQueries({ queryKey: ["back-office"] }));
  await settle();
  for (let i = 0; i < 20 && !document.querySelector('[data-time-row="new"]'); i++) await settle();
  assert.equal(cell("new", "narrative").value, "");
  assert.equal(panes().length, 2, "another capture profile starts with its own layout");
  assert.equal(paneOf("timeline"), paneOf("chat"), "another profile does not inherit the previous user’s tab move");
  await input(cell("new", "matter"), "Client · M · 26/12 · Project");
  await input(cell("new", "worked"), "30");
  const manualNarrative = cell("new", "narrative");
  await input(manualNarrative, "Manual untimed work");
  assert.equal(writes.length, 1, "typing a complete line keeps the active editor open");
  await act(async () => {
    tabNode("entries")?.querySelector<HTMLButtonElement>("button[aria-pressed]")?.focus();
  });
  for (let i = 0; i < 20 && writes.length < 2; i++) await settle();
  assert.equal(writes.length, 2, "leaving a complete manual line from its narrative cell books it once");
  const manual = writes.at(-1);
  assert.ok(manual?.type === "create");
  assert.equal(manual.entry.activity, "GEN");
  assert.equal(manual.entry.startAt, undefined);
  assert.equal(manual.entry.workedMinutes, 30);
  const accepted: TimeEntry = {
    ...base, status: "confirmed", source: "suggestion", groupId: capture.key,
    proposalDigest: capture.digest, authorId: state.userId,
  };
  await act(async () =>
    root.render(
      <MemoryRouter><BackOfficeTheme><TimesheetLedger
        state={{ ...state, supportsBillingComparisons: true, entries: [accepted] }}
        initialDate={base.date} onCommand={send} onOriginal={async () => capture}
      /></BackOfficeTheme></MemoryRouter>,
    ),
  );
  await press("Show revision history");
  await press("Compare with private proposal");
  assert.match(document.querySelector(".bo-time-original")?.textContent ?? "", new RegExp(capture.narrative));
  assert.equal(document.querySelector(".bo-time-original input"), null);
  await press("Submit period");
  assert.deepEqual(commands.at(-1), { type: "submit", entries: [{ id: base.id, revision: 4 }] });
  cache.clear();
  const nearestPolicy = {
    scope: "matter", targetId: "nearest", effectiveFrom: "2026-01-01", revision: 1, stopwatchRoundUp: false,
  } satisfies TimePolicy;
  const timerState = { ...state, entries: [], policies: [nearestPolicy], matters: [
    ...state.matters, { id: "nearest", name: "Nearest", reference: "", clientIds: ["client"] },
  ] };
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme><TimesheetLedger key="timer" state={timerState} onCommand={send}
      initialDraft={{ key: crypto.randomUUID(), source: "suggestion", captureSource: "stopwatch",
        proposalDigest: "b".repeat(64), entry: { ...base, workedMinutes: 10, billableMinutes: 20,
          endAt: "2026-11-12T09:10:01Z" } }}
    /></BackOfficeTheme></MemoryRouter>,
  ));
  assert.equal(cell("new", "charge").value, "20");
  await input(cell("new", "matter"), "Client · Nearest");
  assert.equal(cell("new", "charge").value, "10", "matter switch recalculates the stopwatch proposal");
  await input(cell("new", "matter"), "Client · M · 26/12");
  assert.equal(cell("new", "charge").value, "20", "seconds survive the matter switch");
  await key(cell("new", "narrative"), "Enter");
  const timed = commands.at(-1);
  assert.ok(timed?.type === "create");
  assert.equal(timed.entry.workedMinutes, 10);
  assert.equal(timed.entry.billableMinutes, 20);
  assert.equal(timed.entry.endAt, "2026-11-12T09:10:01Z");
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme><TimesheetLedger key="timer-edit" state={timerState} onCommand={send}
      initialDraft={{ key: crypto.randomUUID(), source: "suggestion", captureSource: "stopwatch",
        proposalDigest: "b".repeat(64), entry: { ...base, workedMinutes: 13, billableMinutes: 20,
          endAt: "2026-11-12T09:13:00Z" } }}
    /></BackOfficeTheme></MemoryRouter>,
  ));
  const addTimerPerson = button("Add person");
  assert.ok(addTimerPerson);
  await act(async () => addTimerPerson.click());
  const participantInputs = document.querySelectorAll<HTMLInputElement>(".bo-time-participant input");
  assert.equal(participantInputs.length, 3);
  await input(participantInputs[0], "21");
  assert.equal(participantInputs[2].value, "30");
  await input(cell("new", "matter"), "Client · Nearest");
  assert.equal(participantInputs[2].value, "20");
  await input(participantInputs[2], "40");
  await input(cell("new", "matter"), "Client · M · 26/12");
  assert.equal(participantInputs[2].value, "40");
  await input(cell("new", "billableWork"), "21");
  assert.equal(cell("new", "charge").value, "30");
  await input(cell("new", "charge"), "40");
  await input(cell("new", "matter"), "Client · Nearest");
  await input(cell("new", "billableWork"), "13");
  assert.equal(cell("new", "charge").value, "40", "explicit charge edits remain intentional");
  await input(cell("new", "nonBillable"), "4");
  await input(cell("new", "billableWork"), "0");
  assert.equal(cell("new", "charge").value, "0", "non-billable work is never rounded into a charge");
  const { BillingPreferences } = await import("../../src/react-app/domains/back-office/billing-preferences");
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme><BillingPreferences state={timerState} onCommand={send}
      initialMatterId="matter" initialDate={base.date}
    /></BackOfficeTheme></MemoryRouter>,
  ));
  const roundSwitch = document.querySelector<HTMLElement>('[role="switch"][aria-label="Round stopwatch time up"]');
  assert.ok(roundSwitch);
  assert.equal(roundSwitch.getAttribute("aria-checked"), "true");
  assert.equal(roundSwitch.dataset.size, "default");
  await act(async () => roundSwitch.click());
  const savePolicy = button("Save billing settings");
  assert.ok(savePolicy);
  await act(async () => savePolicy.click());
  const savedPolicy = commands.at(-1);
  assert.ok(savedPolicy?.type === "policy");
  assert.equal(savedPolicy.policy.scope, "matter");
  assert.equal(savedPolicy.policy.targetId, "matter");
  assert.equal(savedPolicy.policy.stopwatchRoundUp, false);

  const { TimesheetWorkday } = await import("../../src/react-app/domains/back-office/timesheet-workday");
  const { TimeWorkflowProposal } = await import("../../src/react-app/domains/back-office/time-workflow-proposal");
  const otherDate = "2026-11-11";
  const at = (day: string, clock: string) => new Date(day + "T" + clock).toISOString();
  const booked = { ...base, id: crypto.randomUUID(), date: otherDate,
    startAt: at(otherDate, "10:00:00"), endAt: at(otherDate, "10:34:00") };
  const exact: CaptureProposal = { ...capture, key: crypto.randomUUID(), digest: "1".repeat(64),
    narrative: "Already recorded interval", date: otherDate, startAt: booked.startAt, endAt: booked.endAt,
    matterId: booked.matterId };
  const partial: CaptureProposal = { ...exact, key: crypto.randomUUID(), digest: "2".repeat(64),
    narrative: "Adjustable interval", parentDigest: exact.digest, startAt: at(otherDate, "10:30:00"),
    endAt: at(otherDate, "10:50:00"), workedMinutes: 20 };
  const inlineTimer: CaptureProposal = { ...exact, key: crypto.randomUUID(), digest: "3".repeat(64), activity: "",
    source: "stopwatch", date: base.date, startAt: at(base.date, "09:00:00"),
    endAt: at(base.date, "09:10:01"), workedMinutes: 10 };
  const unedited: CaptureProposal = { ...exact, key: crypto.randomUUID(), digest: "7".repeat(64),
    startAt: null, endAt: null, narrative: "Untimed item", projectId: null, matterId: undefined };
  const workdayDirectory: BackOfficeState = {
    scope: "local", directoryId: "second-synthetic-directory", model: defaultBackOfficeModel(), views: [],
    records: [{
      id: booked.id, objectId: "timeEntries", ownerId: state.userId, revision: 7, schemaRevision: 1,
      access: "org", members: [], sourceId: undefined, createdAt: booked.startAt, updatedAt: booked.startAt, archivedAt: null,
      values: { name: booked.narrative, matter: booked.matterId, serviceDate: booked.date, recordedMinutes: booked.workedMinutes },
    }],
    permissions: { userId: state.userId, edit: true, model: false, finance: false },
    sync: { enabled: false, cursor: 0, pending: 0, error: null },
  };
  const selectedModel = { workspaceId: "synthetic", providerID: "eigenwelt", modelID: "test-haiku" };
  const workdayActions: CaptureAction[] = [];
  const suggestionDates: string[] = [];
  let workdayProposals = [exact, partial, inlineTimer, unedited];
  let workdaySettings: CaptureSettings = { calendar: true, tasks: false, aiSuggestions: false, intervalMinutes: 0 };
  let modelStatus: NonNullable<CaptureState["status"]>["type"] = "ready";
  let modelReason: NonNullable<CaptureState["status"]>["reason"];
  let reportFailedSource = true;
  let failSuggestionRequest = false;
  const liveDraft: CaptureProposal = { ...inlineTimer, key: crypto.randomUUID(), digest: "f".repeat(64),
    source: "documents", suggested: true, narrative: "Prepare client briefing from the reviewed activity" };
  const guidelines: CaptureState["guidelines"] = [];
  const privateDrafts: CaptureState["drafts"] = {};
  const workdayClient = { ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
    calendarOccurrences: async () => ({ occurrences: [] }),
    connectorSavedStatus: async (provider?: string) => ({ configured: true, requiresSignIn: false, connectors: provider ? [{
      id: provider, name: provider, configured: true, active: true, connections: [{ id: "me", createdAt: null, needsReconnect: false }],
    }] : [] }),
    callExtensionAction: async (call: LegalworkExtensionActionCall): Promise<LegalworkExtensionActionResult> => {
      const event = { id: "one", title: call.extensionId + " appointment", start: base.date + "T10:00:00Z",
        end: base.date + "T10:25:00Z", allDay: false, status: "confirmed", webUrl: null };
      const result = call.action === "list_calendars" ? { calendars: [{ id: "primary", name: "My calendar" }] } :
        { events: [event, { ...event, id: "gone", status: "cancelled" }, { ...event, id: "later", start: "2031-04-21T10:00:00Z", end: "2031-04-21T10:25:00Z" }] };
      return { ok: true, extensionId: call.extensionId, action: call.action, result };
    },
    privateGuidelineRules: async (_context: unknown, text: string) => text.includes("at least ten minutes")
      ? { rules: { minimumMinutes: 10, incrementMinutes: 6, enforceIncrement: true },
          evidence: { minimumMinutes: "at least ten minutes", incrementMinutes: "six-minute units", enforceIncrement: "six-minute units" }, notes: [] }
      : { rules: {}, evidence: {}, notes: [] },
    privateGuidelineText: async (_context: unknown, file: Blob) => file instanceof window.File && file.name === "scan.pdf"
      ? { text: "", textlessPages: [1] } : { text: "Use approved concise descriptions.", textlessPages: [2] },
    privateWorkday: async (context: { date: string }, action?: CaptureAction, signal?: AbortSignal): Promise<CaptureState> => {
      if (action) workdayActions.push(action);
      if (action?.type === "suggest") {
        suggestionDates.push(context.date);
        assert.match(action.runId ?? "", /^[0-9a-f-]{36}$/i);
        if (failSuggestionRequest) throw Error("Rejected request");
        modelStatus = "ready";
        modelReason = undefined;
      }
      if (action?.type === "settings") workdaySettings = action.settings;
      if (action?.type === "settings-patch") {
        const { change } = action;
        if (change.field === "model") workdaySettings = { ...workdaySettings, model: change.value ?? undefined };
        else if (change.field !== "account") workdaySettings = { ...workdaySettings, [change.field]: change.value };
      }
      if (action?.type === "reconcile" || action?.type === "dismiss")
        workdayProposals = workdayProposals.filter(proposal => proposal.key !== action.key);
      if (action?.type === "correct") workdayProposals = workdayProposals.map(proposal => proposal.key === action.key
        ? { ...proposal, digest: "4".repeat(64), startAt: action.startAt, endAt: action.endAt, workedMinutes: action.workedMinutes }
        : proposal);
      if (action?.type === "draft") {
        if (action.values) privateDrafts[action.key] = { date: context.date, values: action.values, proposalDigest: action.proposalDigest };
        else delete privateDrafts[action.key];
      }
      if (action?.type === "draft-patch") {
        if (action.changes) privateDrafts[action.key] = { date: context.date, values: { ...(privateDrafts[action.key]?.values ?? action.initial), ...action.changes },
          proposalDigest: action.proposalDigest, revision: (privateDrafts[action.key]?.revision ?? 0) + 1 };
        else delete privateDrafts[action.key];
      }
      if (action?.type === "guideline") guidelines.push({ ...action.guideline, revision: action.guideline.revision + 1 });
      return {
        settings: workdaySettings, modelReady: false, connections: [{ provider: "gmail", account: "g".repeat(64), name: "Synthetic mailbox" }], guidelines: [...guidelines],
        status: { type: modelStatus, reason: modelReason, message: "Raw internal status must stay private",
          failedSources: modelStatus === "failed" && reportFailedSource ? [{ provider: "gmail", account: "a".repeat(64), name: "review@example.test" }] : undefined },
        drafts: Object.fromEntries(Object.entries(privateDrafts).filter(([, draft]) => draft.date === context.date)),
        proposals: workdayProposals.filter(proposal => proposal.date === context.date
          && (workdaySettings.calendar || proposal.source !== "calendar")),
      };
    },
  };
  const weeklyState = { ...timerState, entries: [booked], policies: [{ ...nearestPolicy, effectiveFrom: base.date }] };
  const renderWorkday = () => act(async () => root.render(
    <QueryClientProvider client={cache}><MemoryRouter><BackOfficeTheme>
      <TimesheetWorkday client={workdayClient} directory={workdayDirectory} state={weeklyState}
        initialDate={base.date} onDateChange={() => {}}>
        {(captureSheet, workspace) => workspace(
          <TimesheetLedger capture={captureSheet} state={weeklyState} onCommand={send} />,
          proposal => <TimeWorkflowProposal key={proposal.digest} proposal={proposal} state={weeklyState}
            capture={captureSheet} onCommand={send} canEdit />,
        )}
      </TimesheetWorkday>
    </BackOfficeTheme></MemoryRouter></QueryClientProvider>,
  ));
  const selectedPeriod = () => document.querySelector(".bo-time-period [aria-pressed=true]")?.textContent;
  const dayInput = () => document.querySelector<HTMLInputElement>('.bo-workday-controls input[type=date]')?.value;
  const selectNative = async (element: HTMLSelectElement, value: string) => {
    await act(async () => { element.value = value; element.dispatchEvent(new window.Event("change", { bubbles: true })); });
  };
  const until = async (ready: () => unknown) => { for (let i = 0; i < 25 && !ready(); i++) await settle(); };
  const proposalForm = (proposal: CaptureProposal) => document.querySelector<HTMLFormElement>(`[data-time-proposal="${proposal.key}"]`);
  const acceptFor = (proposal: CaptureProposal) => proposalForm(proposal)?.querySelector<HTMLButtonElement>('button[type="submit"]');
  const submit = async (form: HTMLFormElement | null) => {
    assert.ok(form);
    await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  };

  await renderWorkday();
  const maximize = document.querySelector('button[aria-label="' + t("timeWorkspace.expandTimeline") + '"]');
  assert.ok(maximize?.previousElementSibling?.querySelector('button[aria-label="' + t("calendar.zoom_in") + '"]'), "zoom is immediately to the left of maximize");
  await until(() => Boolean(block(inlineTimer)));
  assert.equal(workdayActions.some(action => action.type === "suggest"), false,
    "opening the workday reads its private state without starting a reconstruction");
  assert.ok(block(inlineTimer), "the default mode keeps the stopped timer visible");
  const appointments = () => [...document.querySelectorAll<HTMLButtonElement>("[data-workday-appointment]")];
  await until(() => appointments().length === 2);
  assert.deepEqual(appointments().map(item => item.textContent?.match(/^Calendar.*? appointment/)?.[0]).sort(), ["Calendargoogle-calendar appointment", "Calendaroutlook-calendar appointment"]);
  assert.ok(appointments().every(item => !item.hasAttribute("data-proposal-id")));
  const expand = document.querySelector<HTMLButtonElement>('[aria-label="Expand day timeline"]')!;
  const panesBefore = [...document.querySelectorAll("[data-document-pane]")].map(pane => pane.getAttribute("data-document-pane"));
  await act(async () => expand.click());
  assert.equal(document.querySelectorAll("[data-document-pane]").length, 1);
  assert.equal(expand.getAttribute("aria-pressed"), "true");
  assert.ok(!document.fullscreenElement);
  await act(async () => appointments()[0].click());
  const meetingDetails = document.querySelector('[data-workspace-tab="timeline"] [role="dialog"][data-open]');
  assert.ok(meetingDetails?.textContent?.includes("My calendar"));
  assert.ok(!meetingDetails?.querySelector("[data-calendar-proposal-actions]"));
  await act(async () => meetingDetails!.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  await act(async () => expand.click());
  assert.deepEqual([...document.querySelectorAll("[data-document-pane]")].map(pane => pane.getAttribute("data-document-pane")), panesBefore);

  assert.doesNotMatch(document.body.textContent ?? "", /Unchecked/);
  assert.ok(button(t("timeWorkspace.runSuggestions")));
  const { TimeTrackingSettingsView } = await import("../../src/react-app/domains/settings/pages/time-tracking-view");
  const settingsClient = { ...workdayClient, activityProfile: async () => ({
    profileId: "synthetic", directoryId: workdayDirectory.directoryId!, scope: workdayDirectory.scope, user: weeklyState.userId,
    principal: "", enabled: workdaySettings.enabled !== false, workspaceActivity: true,
  }), backOffice: async (path: string) =>
    path.startsWith("/timesheet") ? weeklyState : workdayDirectory };
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/settings/time-tracking"]}>
    <TimeTrackingSettingsView client={settingsClient} /></MemoryRouter></QueryClientProvider>));
  await until(() => document.querySelector(".time-workspace-guidelines"));
  const enableSwitch = document.querySelector<HTMLElement>('[role="switch"][aria-label="' + t("timeWorkspace.suggestionsEnabled") + '"]');
  assert.ok(enableSwitch);
  const scheduleTimes = () => Array.from(document.querySelectorAll<HTMLInputElement>('ul[aria-label="Run times"] li input[type="time"]')).map(input => input.value);
  assert.deepEqual(scheduleTimes(), ["18:00"]);
  await selectPopup(t("timeWorkspace.frequency"), t("timeWorkspace.hourly"));
  assert.deepEqual(workdaySettings.schedule, { frequency: "hourly" });
  await act(async () => enableSwitch.click());
  await until(() => enableSwitch.getAttribute("aria-checked") === "false" && !enableSwitch.hasAttribute("disabled"));
  assert.equal(workdaySettings.enabled, false);
  assert.equal(document.querySelector('[role="combobox"][aria-label="' + t("timeWorkspace.frequency") + '"]'), null);
  await act(async () => enableSwitch.click());
  await until(() => enableSwitch.getAttribute("aria-checked") === "true" && !enableSwitch.hasAttribute("disabled"));
  assert.equal(workdaySettings.enabled, true);
  await until(() => document.querySelector(".time-workspace-guidelines"));
  await press(t("timeWorkspace.guidelineNew"));
  const guidelineForm = document.querySelector<HTMLFormElement>(".time-workspace-guidelines form");
  const guidelineText = guidelineForm?.querySelector<HTMLTextAreaElement>("textarea");
  const guidelineFile = guidelineForm?.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(guidelineForm && guidelineText && guidelineFile);
  const file = async (content: string | ArrayBuffer, name: string) => {
    Object.defineProperty(guidelineFile, "files", { configurable: true, value: [new window.File([content], name)] });
    await act(async () => guidelineFile.dispatchEvent(new window.Event("change", { bubbles: true })));
  };
  await file("Use approved action verbs.", "local-guideline.txt");
  await until(() => guidelineText.value === "Use approved action verbs.");
  assert.equal(guidelineText.value, "Use approved action verbs.");
  const { default: JSZip } = await import("jszip");
  const sampleDocx = new JSZip();
  sampleDocx.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Use short descriptions.</w:t></w:r></w:p></w:body></w:document>`);
  await file(await sampleDocx.generateAsync({ type: "arraybuffer" }), "sample.docx");
  await until(() => guidelineText.value === "Use short descriptions.");
  assert.equal(guidelineText.value, "Use short descriptions.");
  await file("synthetic PDF", "scan.pdf");
  await until(() => guidelineForm.textContent?.includes("no searchable text"));
  assert.match(guidelineForm.textContent ?? "", /no searchable text/);
  await file("synthetic PDF with text", "guideline.pdf");
  await until(() => guidelineText.value === "Use approved concise descriptions.");
  assert.equal(guidelineText.value, "Use approved concise descriptions.");
  assert.equal(guidelines.length, 0, "extracting and reviewing the guideline does not save it");
  await file("Record at least ten minutes, in six-minute units.", "numeric-rules.txt");
  const minimumInput = () => [...guidelineForm.querySelectorAll<HTMLInputElement>('input[type=number]')][0];
  await until(() => minimumInput()?.value === "10");
  assert.equal(guidelines.length, 0, "extracted numerical rules remain private form values until reviewed and saved");
  const advancedRules = guidelineForm.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + t("timeWorkspace.guidelineRules") + '"]');
  assert.ok(advancedRules);
  await input(advancedRules, JSON.stringify({ minimumMinutes: 10, incrementMinutes: 6, rounding: "up" }));
  assert.doesNotMatch(guidelineForm.textContent ?? "", /Minimum minutes: at least ten minutes/,
    "editing advanced rules clears quotes for the old model values");
  await input(minimumInput(), "0");
  assert.equal(minimumInput().value, "10", "invalid numbers do not corrupt all simple rule fields");
  await input(minimumInput(), "12");
  await input(guidelineText, "Reviewed: use approved concise descriptions.");
  await press(t("timeWorkspace.guidelineExtract"));
  await until(() => !guidelineForm.textContent?.includes(t("timeWorkspace.guidelineExtracting")));
  assert.equal(minimumInput().value, "12", "extraction without a minimum preserves the reviewed rule");
  assert.equal(JSON.parse(advancedRules.value).rounding, "up", "extraction preserves omitted numerical options");
  await input(advancedRules, "{");
  await press(t("timeWorkspace.guidelineExtract"));
  assert.equal(advancedRules.value, "{", "extraction does not replace invalid unsaved JSON with defaults");
  await input(advancedRules, JSON.stringify({ minimumMinutes: 12, incrementMinutes: 6, rounding: "up" }));
  await submit(guidelineForm);
  await until(() => guidelines.length === 1);
  assert.equal(guidelines[0]?.rules.instructions, "Reviewed: use approved concise descriptions.");
  assert.equal(guidelines[0]?.rules.minimumMinutes, 12, "the user can correct extracted rules before saving");
  assert.equal(guidelines[0]?.rules.incrementMinutes, 6);
  assert.equal(guidelines[0]?.scope, "firm");
  assert.equal(guidelines[0]?.effectiveFrom, new Date().toLocaleDateString("en-CA"));
  await press(t("timeWorkspace.effectiveRules"));
  const rulesPanel = document.querySelector<HTMLElement>('.time-workspace-guidelines [data-slot="collapsible-content"]');
  const matterLookup = rulesPanel?.querySelector<HTMLInputElement>('input[role="combobox"]');
  const serviceDate = rulesPanel?.querySelector<HTMLInputElement>('input[type="date"]');
  assert.ok(rulesPanel && matterLookup && serviceDate);
  assert.equal(rulesPanel.querySelector(`label[for="${matterLookup.id}"]`)?.textContent, "Matter");
  assert.equal(rulesPanel.querySelector("dl"), null);
  await act(async () => matterLookup.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await input(matterLookup, "26/12");
  const foundMatter = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.includes("26/12"));
  await until(foundMatter);
  assert.ok(foundMatter());
  await act(async () => foundMatter()!.click());
  const values = () => [...rulesPanel.querySelectorAll("dd")].map(item => item.textContent);
  assert.equal(values().length, 4);
  assert.equal(values()[0], "12 min");
  assert.match(rulesPanel.textContent ?? "", /LegalWork defaults/);
  await input(serviceDate, "2025-01-01");
  assert.notEqual(values()[0], "12 min", "the displayed rule follows the selected service date");

  assert.equal(document.querySelector('[role="combobox"][aria-label="Stopwatch"]'), null);
  assert.doesNotMatch(document.body.textContent ?? "", /Synthetic mailbox/);
  assert.equal([...document.querySelectorAll("a")].find(link => link.textContent === t("catalog.manage_integrations"))?.getAttribute("href"), "/settings/extensions");
  {
    const { Routes, Route } = await import("react-router-dom");
    const clientRecord = { ...workdayDirectory.records[0], id: crypto.randomUUID(), objectId: "clients",
      values: { name: "Review client" } };
    const matterRecord = { ...clientRecord, id: crypto.randomUUID(), objectId: "matters",
      values: { name: "Review matter", clients: [clientRecord.id] } };
    const directory = { ...workdayDirectory, records: [clientRecord, matterRecord] };
    const targets = { ...weeklyState,
      clients: [...weeklyState.clients, { id: clientRecord.id, name: clientRecord.values.name }],
      matters: [...weeklyState.matters, { id: matterRecord.id, name: matterRecord.values.name, clientIds: [clientRecord.id], reference: "" }] };
    const linkedClient = { ...settingsClient, backOffice: async (path: string) => {
      if (path.startsWith("/timesheet?")) return targets;
      if (path === "/projects") return { projects: [] };
      if (path.startsWith("/native-linked/")) return { links: [] };
      assert.ok(path.startsWith("?manifest="), path);
      return directory;
    } };
    const linkedCache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
    let visit = 0;
    const openMatterRecord = async () => {
      await act(async () => root.render(<QueryClientProvider client={linkedCache}>
        <MemoryRouter key={++visit} initialEntries={["/back-office/matters?record=" + matterRecord.id]}>
          <Routes>
            <Route path="/back-office/:object" element={<BackOfficePage client={linkedClient} />} />
            <Route path="/settings/time-tracking" element={<TimeTrackingSettingsView client={linkedClient} />} />
          </Routes>
        </MemoryRouter></QueryClientProvider>));
      await until(() => document.querySelector('a[href^="/settings/time-tracking?"]'));
    };
    const followGuidelineLink = async (scope: string, recordId: string) => {
      const link = document.querySelector<HTMLAnchorElement>('a[href^="/settings/time-tracking?"]');
      assert.ok(link);
      const params = new URL(link.href).searchParams;
      assert.equal(params.get(scope), recordId);
      assert.equal(params.get("directory"), directory.directoryId);
      await act(async () => link.click());
      await until(() => document.querySelector(".time-workspace-guidelines"));
    };
    const openRelatedClient = async () => {
      const chip = [...document.querySelectorAll<HTMLElement>(".bo-detail-fields span")]
        .find(el => !el.children.length && el.textContent === clientRecord.values.name);
      assert.ok(chip, "the matter links to the client in its record detail");
      await act(async () => chip.click());
      await until(() => document.querySelector('a[href*="client=' + clientRecord.id + '"]'));
    };
    const form = () => document.querySelector<HTMLFormElement>(".time-workspace-guidelines form");
    const linkedTarget = () => form()?.querySelector<HTMLAnchorElement>(".time-guideline-target a");
    await openMatterRecord();
    await openRelatedClient();
    await followGuidelineLink("client", clientRecord.id);
    assert.equal(linkedTarget()?.getAttribute("href"), "/back-office/clients?record=" + clientRecord.id);
    const guidelineName = "Client narrative requirements";
    const wording = "Use the document title in each draft narrative.";
    await input(form()!.querySelector("input")!, guidelineName);
    await input(form()!.querySelector("textarea")!, wording);
    await submit(form());
    await until(() => !form());
    const saved = guidelines.find(item => item.name === guidelineName);
    assert.equal(saved?.scope, "client");
    assert.equal(saved?.targetId, clientRecord.id);
    const savedButton = () => [...document.querySelectorAll<HTMLButtonElement>(".time-workspace-guidelines button")]
      .find(el => el.textContent?.includes(guidelineName));
    await openMatterRecord();
    await followGuidelineLink("matter", matterRecord.id);
    assert.equal(linkedTarget()?.getAttribute("href"), "/back-office/matters?record=" + matterRecord.id);
    assert.equal(savedButton(), undefined, "the matter settings show only that matter's guidelines");
    await openMatterRecord();
    await openRelatedClient();
    await followGuidelineLink("client", clientRecord.id);
    assert.equal(form(), null, "returning to the same client opens its saved guidelines");
    const savedVersion = savedButton();
    assert.ok(savedVersion?.textContent?.includes(clientRecord.values.name));
    await act(async () => savedVersion!.click());
    assert.equal(form()?.querySelector("textarea")?.value, wording);
    assert.equal(linkedTarget()?.getAttribute("href"), "/back-office/clients?record=" + clientRecord.id);
    assert.equal(form()?.querySelector('[role="combobox"][aria-label="Scope"]'), null);
  }
  await renderWorkday();
  await until(() => document.querySelector("[data-calendar-day-header] [role=combobox]"));
  await until(() => Boolean(block(inlineTimer)));
  assert.ok(block(inlineTimer), "the stopped timer remains visible after suggestions are ready");
  modelStatus = "failed";
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await until(() => Boolean(block(inlineTimer)));
  assert.ok(block(inlineTimer), "a failed model leaves the manual timer accessible");
  const namedSourceFailure = t("timeWorkspace.sourcesFailed", { sources: t("timesheets.source.gmail") + " (review@example.test)" });
  const workdayAlert = () => document.querySelector('.time-workspace-note[role="alert"]')?.textContent ?? "";
  await until(() => workdayAlert() === namedSourceFailure);
  assert.equal(workdayAlert(), namedSourceFailure, "a saved source-only error without a reason stays readable");
  for (const [reason, label] of [
    ["timeout", "timeWorkspace.suggestionsTimedOut"], ["invalid_output", "timeWorkspace.suggestionsInvalid"],
    ["model_unavailable", "timeWorkspace.unavailable"], ["provider_failed", "timeWorkspace.suggestionsModelFailed"],
  ] as const) {
    modelReason = reason;
    await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
    await until(() => workdayAlert().includes(t(label)));
    assert.ok(workdayAlert().includes(namedSourceFailure), "the named account failure remains visible with a model error");
  }
  modelReason = "sources_failed";
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await until(() => workdayAlert() === namedSourceFailure);
  reportFailedSource = false;
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await until(() => workdayAlert() === t("timeWorkspace.suggestionsSourcesFailed"));
  modelReason = undefined;
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await until(() => workdayAlert() === t("timeWorkspace.failed"));
  const suggestionCalls = () => workdayActions.filter(action => action.type === "suggest");
  const confirmationDialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-suggestion-confirmation]');
  const confirmationButton = (label: string) => [...confirmationDialog()?.querySelectorAll<HTMLButtonElement>("button") ?? []]
    .find(button => button.textContent === label);
  async function confirmSuggestions() {
    assert.ok(confirmationDialog()?.textContent?.includes("which drafts to book"));
    const submit = confirmationButton(t("timeWorkspace.createSuggestions"));
    assert.ok(submit);
    await act(async () => submit.click());
  }
  const gapAction = button(t("timeWorkspace.runSuggestions"));
  assert.equal(document.querySelector("[data-workday-unchecked]"), null);
  assert.ok(gapAction);
  const beforeCheck = suggestionCalls().length;
  await act(async () => { gapAction.focus(); gapAction.click(); });
  const modal = confirmationDialog();
  assert.ok(modal);
  assert.equal(modal.closest('[data-workspace-tab]')?.getAttribute("data-workspace-tab"), "timeline");
  const pane = modal.closest<HTMLElement>('[data-workspace-tab="timeline"]')!;
  const overlay = pane.querySelector('[data-slot="dialog-overlay"]');
  assert.ok(overlay?.classList.contains("absolute"), "the backdrop is positioned inside only the timeline");
  assert.ok(!overlay.classList.contains("lw-overlay") && !overlay.className.includes("backdrop-blur"),
    "tab dialogs preserve the original calendar colors and clarity");
  assert.ok(gapAction.closest("[inert]"), "keyboard input cannot reach calendar items behind the dialog");
  assert.equal(modal.closest("[inert]"), null);
  assert.equal(suggestionCalls().length, beforeCheck, "opening the dialog cannot start a run");
  const cancelConfirm = confirmationButton(t("common.cancel"));
  const submitConfirm = confirmationButton(t("timeWorkspace.createSuggestions"));
  assert.ok(cancelConfirm && submitConfirm);
  await until(() => document.activeElement === cancelConfirm);
  assert.equal(document.activeElement, cancelConfirm, "keyboard focus starts on cancel");
  await act(async () => cancelConfirm.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, submitConfirm);
  await act(async () => submitConfirm.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, cancelConfirm);
  const outside = document.querySelector<HTMLInputElement>('[data-workspace-tab="entries"] input:not([type="checkbox"]):not([type="hidden"])');
  assert.ok(outside && !outside.closest("[inert]"));
  await act(async () => { outside.focus(); outside.click(); });
  assert.equal(document.activeElement, outside);
  assert.ok(confirmationDialog(), "working in Time entries leaves the timeline confirmation available");
  await act(async () => outside.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.ok(confirmationDialog(), "Escape in another pane belongs to that pane");
  await act(async () => {
    cancelConfirm.focus();
    cancelConfirm.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await until(() => !confirmationDialog() && document.activeElement === gapAction);
  assert.equal(confirmationDialog(), null);
  assert.ok(document.activeElement === gapAction, "closing with Escape restores the Run suggestions button");
  assert.equal(suggestionCalls().length, beforeCheck);
  const openButton = button(t("timeWorkspace.runSuggestions"));
  assert.ok(openButton);
  await act(async () => { openButton.focus(); openButton.click(); });
  await until(() => document.activeElement === confirmationButton(t("common.cancel")));
  await act(async () => confirmationButton(t("common.cancel"))?.click());
  await until(() => !confirmationDialog() && document.activeElement === openButton);
  assert.ok(document.activeElement === openButton, "cancel restores the header button when it opened the confirmation");
  assert.equal(suggestionCalls().length, beforeCheck);
  await act(async () => gapAction.click());
  failSuggestionRequest = true;
  await confirmSuggestions();
  await until(() => document.querySelector(".time-workspace-status")?.textContent === t("timeWorkspace.failed"));
  assert.equal(suggestionCalls().length, beforeCheck + 1);
  assert.doesNotMatch(document.body.textContent ?? "", /Raw internal status/);
  failSuggestionRequest = false;
  await press(t("timeWorkspace.runSuggestions"));
  await confirmSuggestions();
  assert.equal(suggestionCalls().length, beforeCheck + 2);
  assert.ok(!document.querySelector("progress"));
  assert.equal(tabNode("timeline")?.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed"), "true",
    "starting suggestions keeps the timeline selected");
  assert.equal(tabNode("chat")?.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed"), "false");
  workdayProposals.push(liveDraft);
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await until(() => Boolean(block(liveDraft)));
  assert.ok(block(liveDraft), "a draft published by the chat appears in the timeline");

  await press("Week");
  const weekDays = [...document.querySelectorAll<HTMLButtonElement>(".bo-time-week button")];
  assert.equal(weekDays.length, 7);
  const wednesday = weekDays[2];
  assert.equal(wednesday.querySelector("time")?.dateTime, otherDate);
  assert.equal(wednesday.querySelector("span")?.textContent, "34 · 30");
  assert.equal(block(partial), null, "the timeline stays on the selected date in the weekly view");
  await act(async () => wednesday.click());
  await until(() => Boolean(block(partial)));
  assert.equal(selectedPeriod(), "Day");
  assert.equal(dayInput(), otherDate);
  assert.equal(block(inlineTimer), null, "a different day's timer stays out of the timeline");
  assert.equal(document.querySelectorAll("[data-calendar-column]").length, 1);
  await selectPopup("Timeline layout", "By matter");
  assert.equal(document.querySelectorAll("[data-calendar-column]").length, 2);
  assert.match(document.querySelector("[data-calendar-time-grid]")?.textContent ?? "", /Unassigned matter/);
  assert.ok(document.querySelector(`[data-calendar-untimed] [data-proposal-id="${unedited.key}"]`));
  await openProposal(exact);
  assert.equal(acceptFor(exact)?.disabled, false, "the worker may link an existing entry or review independently supported simultaneous work");
  await selectPopup(t("timesheets.sheet.reconcile"), booked.narrative + " · " + booked.workedMinutes);
  await until(() => !block(exact));
  assert.deepEqual(workdayActions.find(action => action.type === "reconcile"), {
    type: "reconcile", key: exact.key, digest: exact.digest, recordId: booked.id, recordRevision: 7, draftRevision: 1,
  });
  assert.equal(block(exact), null);
  assert.equal(document.activeElement, block(partial), "linking also returns focus to a surviving timeline block");
  await openProposal(partial);
  assert.equal(acceptFor(partial)?.disabled, false, "a different activity remains bookable during previously recorded time");
  await selectPopup(t("timesheets.ledger.activity"), t("timeWorkspace.noActivity"));
  await press(t("common.edit"), true);
  assert.equal(document.activeElement, proposalHeading());
  const correctionForm = document.querySelector<HTMLFormElement>("[data-time-source-editor]");
  const correctedStart = correctionForm?.querySelector<HTMLInputElement>('input[type="time"]');
  assert.ok(correctedStart);
  await input(correctedStart, "10:34");
  await submit(correctionForm);
  const savedCorrection = workdayActions.find(action => action.type === "correct" && action.key === partial.key);
  assert.ok(savedCorrection?.type === "correct");
  assert.equal(savedCorrection.activity, null, "correcting an interval preserves a code cleared in the proposal editor");
  assert.equal(savedCorrection.draftRevision, privateDrafts[partial.key]?.revision);
  await until(() => acceptFor(partial)?.disabled === false);
  assert.equal(acceptFor(partial)?.disabled, false, "reviewing the interval preserves the booking action");
  assert.equal(proposalForm(partial)?.querySelector<HTMLInputElement>('[data-column="billableWork"]')?.value, "16");

  const closeEdited = document.querySelector<HTMLButtonElement>(".time-workspace-editor [data-slot=dialog-close]");
  assert.ok(closeEdited);
  await act(async () => closeEdited.click());
  await calendarAction(unedited, t("timesheets.sheet.decline"));
  await until(() => !block(unedited));
  assert.equal(block(unedited), null);
  assert.equal(document.activeElement, block(partial), "dismissing a focused proposal restores a useful neighbor");
  assert.deepEqual(workdayActions.find(action => action.type === "dismiss"),
    { type: "dismiss", key: unedited.key, digest: unedited.digest });
  const remaining = workdayProposals.find(proposal => proposal.key === partial.key);
  assert.ok(remaining);
  await openProposal(remaining);
  const dayField = document.querySelector<HTMLInputElement>(".bo-workday-controls input[type=date]");
  assert.ok(dayField);
  await act(async () => {
    dayField.focus();
    workdayProposals = workdayProposals.filter(proposal => proposal.key !== remaining.key);
    await cache.invalidateQueries({ queryKey: ["back-office"] });
  });
  await until(() => !block(remaining));
  assert.equal(document.activeElement, dayField, "removing an editor after the user navigates elsewhere does not move focus");
  workdayProposals.push(remaining);
  await act(async () => cache.invalidateQueries({ queryKey: ["back-office"] }));
  await openProposal(remaining);
  const declineInEditor = proposalForm(remaining)?.querySelector<HTMLButtonElement>(`button[title="${t("timesheets.sheet.decline")}"]`);
  assert.ok(declineInEditor);
  await act(async () => { declineInEditor.focus(); declineInEditor.click(); });
  await until(() => !block(remaining));
  assert.equal(document.activeElement?.getAttribute("data-workspace-tab"), "timeline", "dismissing the last suggestion focuses the timeline");

  await selectTab("chat");
  assert.ok(document.querySelector('[data-workspace-tab="chat"]'));
  assert.equal(document.querySelector("form[data-workday-chat-composer]"), null);
  await selectTab("entries");
  await press("Month");
  assert.equal(document.querySelectorAll(".bo-time-month button").length, 30);
  const firstWeek = document.querySelector(".bo-time-month tbody tr");
  assert.equal(firstWeek?.children[6].querySelector("time")?.dateTime, "2026-11-01", "November begins under Sunday");
  const day = document.querySelector<HTMLButtonElement>(`.bo-time-month button:has(time[datetime="${base.date}"])`);
  assert.ok(day);
  await act(async () => day.click());
  assert.equal(selectedPeriod(), "Day");
  assert.equal(dayInput(), base.date);
  await selectTab("chat");
  const remount = async () => {
    await act(async () => root.render(null));
    await renderWorkday();
    await settle();
  };
  const originalDirectoryId = workdayDirectory.directoryId;
  workdayDirectory.directoryId = "migration-synthetic-directory";
  await remount();
  assert.equal(panes().length, 2, "a new directory opens the standard workspace layout");
  workdayDirectory.directoryId = originalDirectoryId;
  await remount();
  await newTab("Reset workspace layout");
  assert.deepEqual(paneOrder(strips()[0]), ["entries"]);
  assert.deepEqual(paneOrder(strips()[1]), ["timeline", "chat"]);
  assert.equal(separator().getAttribute("aria-valuenow"), "67");
  const timelineTab = tabNode("timeline")?.querySelector<HTMLButtonElement>("button[aria-pressed]");
  assert.ok(timelineTab);
  await act(async () => {
    timelineTab.focus();
    timelineTab.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(paneOrder(strips()[1]), ["chat", "timeline"]);
  assert.equal(document.activeElement, timelineTab);
  await selectTab("chat");
  await moveTab("chat", 1);
  assert.equal(paneOf("chat"), paneOf("entries"));
  await remount();
  assert.deepEqual(paneOrder(strips()[0]), ["entries", "chat"]);
  assert.deepEqual(paneOrder(strips()[1]), ["timeline"]);
  await tabMenu("chat", "Split right");
  assert.equal(panes().length, 3);
  assert.notEqual(paneOf("chat"), paneOf("entries"));
  assert.notEqual(paneOf("chat"), paneOf("timeline"));
  for (const id of ["entries", "chat", "timeline"]) {
    const close = tabNode(id)?.querySelector<HTMLButtonElement>('button[aria-label^="Close tab"]');
    assert.ok(close, id);
    await act(async () => close.click());
  }
  assert.equal(document.querySelectorAll("[data-panel-tab-id]").length, 0);
  await remount();
  assert.equal(document.querySelectorAll("[data-panel-tab-id]").length, 0, "closing the last tab survives reopening the workspace");
  await newTab("Time entries");
  assert.deepEqual(paneOrder(strips()[0]), ["entries"]);
  await newTab("Reset workspace layout");
  await act(async () => {
    workspaceWidth = 540;
    for (const resize of workspaceObservers) resize([], new window.ResizeObserver(() => {}));
  });
  await newTab("Day timeline");
  await selectTab("chat");
  assert.equal(panes().length, 1, "the private chat shares the narrow timeline pane");
  assert.equal(dayInput(), base.date);
  for (const [id, label] of [["entries", "Time entries"], ["timeline", "Day timeline"]]) {
    await newTab(label);
    assert.equal(panes().length, 1, "only the selected workspace pane is rendered at narrow width");
    assert.equal(tabNode(id)?.querySelector("[aria-pressed]")?.getAttribute("aria-pressed"), "true");
    assert.equal(dayInput(), base.date);
  }
  await remount();
  assert.equal(tabNode("timeline")?.querySelector("[aria-pressed]")?.getAttribute("aria-pressed"), "true");
  privateDrafts[inlineTimer.key] = {
    date: inlineTimer.date, proposalDigest: inlineTimer.digest,
    values: { workflow: true, charge: "37" },
  };
  await act(async () => { await cache.invalidateQueries({ queryKey: ["back-office"] }); });
  await openProposal(inlineTimer);
  assert.equal(proposalForm(inlineTimer)?.querySelector<HTMLInputElement>('[data-column="charge"]')?.value,
    "37", "an older stopwatch draft keeps its manually adjusted billable minutes");

  // A disabled source never calls the desktop bridge. Opting out cancels an outstanding sample.
  const { useDesktopTimeActivity } = await import("../../src/react-app/shell/desktop-time-activity");
  type DesktopSample = import("@legalwork/types/time-capture").DesktopActivitySample;
  const observedSample: DesktopSample = { platform: "darwin", permission: "granted", state: "active", application: "Preview",
    documentName: "Synthetic brief.pdf", idleSeconds: 1, observedAt: Date.now() };
  let reads = 0;
  let pendingRead: ((sample: DesktopSample) => void) | undefined;
  const posted: DesktopSample[] = [];
  const desktopClient = { ...workdayClient, recordDesktopTimeActivity: async (_identity: unknown, sample: DesktopSample) => {
    posted.push(sample); return { ok: true };
  } };
  const oldBridge = Object.getOwnPropertyDescriptor(window, "__LEGALWORK_ELECTRON__");
  Object.defineProperty(window, "__LEGALWORK_ELECTRON__", { configurable: true, value: { system: {
    sampleWorkdayDesktopActivity: async () => ++reads === 1 ? observedSample : new Promise<DesktopSample>(resolve => { pendingRead = resolve; }),
  } } });
  function DesktopObserver({ enabled }: { enabled: boolean }) {
    useDesktopTimeActivity(desktopClient, { scope: "local", user: "synthetic", principal: "", profileId: "synthetic",
      directoryId: "test-directory", enabled: true, workspaceActivity: false, desktopActivity: enabled });
    return null;
  }
  const observeDesktop = (enabled: boolean) => act(async () => root.render(<QueryClientProvider client={cache}>
    <DesktopObserver enabled={enabled} /></QueryClientProvider>));
  try {
    await observeDesktop(false);
    assert.equal(reads, 0);
    await observeDesktop(true);
    await until(() => posted.length === 1);
    assert.deepEqual(posted, [observedSample]);
    window.dispatchEvent(new window.Event("focus"));
    await until(() => Boolean(pendingRead));
    await observeDesktop(false);
    pendingRead?.(observedSample);
    await settle();
    window.dispatchEvent(new window.Event("focus"));
    assert.equal(reads, 2, "turning the source off removes its listeners");
    assert.equal(posted.length, 1);
  } finally {
    if (oldBridge) Object.defineProperty(window, "__LEGALWORK_ELECTRON__", oldBridge);
    else Reflect.deleteProperty(window, "__LEGALWORK_ELECTRON__");
  }

  const { DesktopActivitySetting } = await import("../../src/react-app/domains/settings/pages/desktop-activity-setting");
  Object.defineProperty(window, "__LEGALWORK_ELECTRON__", { configurable: true, value: { meta: { platform: "darwin" }, system: {
    workdayDesktopStatus: async () => ({ platform: "darwin", permission: "needed" }),
  } } });
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}>
      <DesktopActivitySetting profileId="synthetic" checked disabled={false} onChange={() => {}} /></QueryClientProvider>));
    await until(() => button(t("timeWorkspace.desktopGrant")));
    assert.ok(button(t("timeWorkspace.desktopGrant")));
    assert.equal(document.querySelector('input[type=date]'), null);
    assert.doesNotMatch(document.body.textContent ?? "", /folder/i);

    workdayDirectory.captureProfileId = "synthetic";
    workdaySettings = { ...workdaySettings, desktopActivity: true };
    await renderWorkday();
    await newTab("Day timeline");
    const daySelector = document.querySelector<HTMLInputElement>('.bo-workday-controls input[type=date]');
    assert.ok(daySelector);
    await input(daySelector, "2025-04-14");
    await until(() => button(t("timeWorkspace.runSuggestions")));
    await press(t("timeWorkspace.runSuggestions"));
    const dialog = confirmationDialog();
    assert.ok(dialog);
    assert.doesNotMatch(dialog.textContent ?? "", /folder/i);
    assert.equal(dialog.querySelector('input[type=date]'), null);
    await confirmSuggestions();
    assert.equal(suggestionDates.at(-1), "2025-04-14");
  } finally {
    if (oldBridge) Object.defineProperty(window, "__LEGALWORK_ELECTRON__", oldBridge);
    else Reflect.deleteProperty(window, "__LEGALWORK_ELECTRON__");
  }

  // Creating a query while rendering Back Office must not synchronously notify an unrelated sidebar subscription.
  const { getReactQueryClient } = await import("../../src/react-app/infra/query-client");
  const { useQueryCacheState } = await import("../../src/react-app/infra/query-cache-state");
  const { useQuery } = await import("@tanstack/react-query");
  const { spyOn } = await import("bun:test");
  const sharedCache = getReactQueryClient();
  const watchedKey = ["synthetic-sidebar-interaction"];
  const observed = () => document.querySelector("output")?.textContent;
  function CacheSubscriber() { return <output>{useQueryCacheState(watchedKey, "empty")}</output>; }
  let readsDuringMount = 0;
  function QueryMount() {
    const reads = spyOn(sharedCache, "getQueryData");
    useQuery({ queryKey: ["synthetic-back-office-directory"], queryFn: async () => [], enabled: false });
    readsDuringMount += reads.mock.calls.filter(([key]) => key === watchedKey).length;
    reads.mockRestore();
    return null;
  }
  const mount = (withDirectory: boolean) => act(async () => root.render(<QueryClientProvider client={sharedCache}>
    <CacheSubscriber />{withDirectory && <QueryMount />}</QueryClientProvider>));
  await mount(false);
  await mount(true);
  assert.equal(readsDuringMount, 0, "subscribers read their own key when it changes");
  assert.equal(observed(), "empty");
  await act(async () => { sharedCache.setQueryData(watchedKey, "updated"); });
  await until(() => observed() === "updated");
  assert.equal(observed(), "updated");
  await act(async () => sharedCache.removeQueries({ queryKey: watchedKey, exact: true }));
  await until(() => observed() === "empty");
  assert.equal(observed(), "empty", "removing the observed query restores its fallback");
  await act(async () => root.render(null));
  sharedCache.clear();
  cache.clear();
  console.log("Timesheet ledger passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
