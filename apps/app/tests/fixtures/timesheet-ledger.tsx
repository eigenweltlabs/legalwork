import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { TimesheetCommand, TimesheetState, TimeEntry, TimePolicy } from "@legalwork/types/timesheet";
import type { BackOfficeState } from "../../src/react-app/domains/back-office/api";
import type { CaptureAction, CaptureProposal, CaptureSettings } from "@legalwork/types/time-capture";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><body><div id='root'></div></body></html>");
Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  CSS: window.CSS,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}).forEach(([key, value]) => Object.defineProperty(globalThis, key, { value, configurable: true }));

const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { WorkdayTimeline, WorkdayCorrectionForm, overlappingWorkdayRanges } = await import(
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
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    const write = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
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
  // Exercise the optional recorded-time allocations throughout the keyboard tests.
  localStorage.setItem("legalwork.timesheet.columns." + state.scope + ":" + state.userId, JSON.stringify(["worked"]));
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
  assert.deepEqual([...overlappingWorkdayRanges([capture, unknown], [base])], [capture.key]);
  assert.equal(
    overlappingWorkdayRanges(
      [capture, { ...capture, key: "adjacent", startAt: capture.endAt, endAt: "2026-11-12T10:00:00Z" }],
      [],
    ).size,
    0,
  );
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
            proposals={[capture, unknown]}
            state={directory}
            confirmed={[base]}
            onOpen={() => {}}
          />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  const axis = document.querySelector<HTMLElement>(".bo-workday-axis");
  assert.ok(axis);
  assert.equal(axis.querySelectorAll(".bo-workday-axis-event").length, 2);
  assert.ok(!axis.textContent?.includes("Unused matter"));
  assert.ok(!axis.textContent?.includes("Untimed"));
  let correctedMinutes: number | null | undefined;
  await act(async () =>
    root.render(
      <MemoryRouter>
        <BackOfficeTheme>
          <WorkdayCorrectionForm
            proposal={unknown}
            state={directory}
            pending={false}
            close={() => {}}
            save={async (action) => {
              correctedMinutes = action.workedMinutes;
              return true;
            }}
          />
        </BackOfficeTheme>
      </MemoryRouter>,
    ),
  );
  const correction = document.querySelector<HTMLFormElement>(".bo-workday-correction");
  assert.ok(correction);
  await act(async () =>
    correction.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  assert.equal(correctedMinutes, null);
  // A first visit from Workday must carry the proposal through the real Back Office route.
  const { defaultBackOfficeModel } = await import("@legalwork/types/back-office");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
  const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const writes: unknown[] = [];
  let captureProfileId = "profile-a";
  const overlayRunId = crypto.randomUUID();
  let stopped = false;
  let workdayReads = 0;
  const client = {
    ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
    privateStopwatch: async () => ({
      profileId: captureProfileId,
      active: null,
      lastStopped: stopped ? { id: overlayRunId, date: base.date, stoppedAt: base.date + "T12:00:00Z" } : null,
    }),
    privateWorkday: async (context: { profileId?: string }) => {
      assert.equal(context.profileId, "profile-a");
      workdayReads++;
      return {
        settings: { calendar: true, tasks: false, aiSuggestions: true, intervalMinutes: 0 as const },
        proposals: [capture],
        drafts: {},
        connections: [],
        modelReady: false,
      };
    },
    backOffice: async (path: string, options?: { body?: unknown }) => {
      if (path === "/projects") return { projects: [] };
      if (path.startsWith("/timesheet?")) {
        if (options?.body) {
          assert.equal(new URL(path, "http://localhost").searchParams.get("profileId"), "profile-a");
          writes.push(options.body);
        }
        return { ...state, entries: [] };
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
  for (let i = 0; i < 20 && !document.querySelector('[aria-label="Accept suggestion"]'); i++) await settle();
  const prepare = document.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
  assert.ok(prepare, document.body.textContent?.slice(-800));
  assert.equal(document.querySelector('header button[aria-label="Start stopwatch"]'), null);
  const initialReads = workdayReads;
  stopped = true;
  await act(async () => cache.invalidateQueries({ queryKey: ["private-stopwatch"] }));
  for (let i = 0; i < 20 && workdayReads === initialReads; i++) await settle();
  assert.ok(workdayReads > initialReads, "a stop in the desktop overlay refreshes the open workday");
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="AI suggestion settings"]')?.click());
  const sourceSwitch = document.querySelector<HTMLElement>('[data-slot="popover-content"] [role="switch"]');
  assert.ok(sourceSwitch);
  assert.equal(sourceSwitch.dataset.size, "default");
  assert.ok(sourceSwitch.closest('[data-slot="item-header-actions"]'));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="AI suggestion settings"]')?.click());
  const proposalRow = document.querySelector('[data-time-proposal]');
  assert.ok(proposalRow);
  const proposedText = proposalRow.querySelector<HTMLInputElement>('[data-column="narrative"]');
  const proposedCharge = proposalRow.querySelector<HTMLInputElement>('[data-column="charge"]');
  assert.equal(proposedText?.value, capture.narrative);
  assert.ok(proposedCharge);
  await input(proposedCharge, "30");
  assert.equal(writes.length, 0, "editing a proposal does not publish it");
  await act(async () => prepare.click());
  assert.equal(writes.length, 1);
  await input(cell("new", "narrative"), "First profile's unfinished line");
  captureProfileId = "profile-b";
  await act(async () => cache.invalidateQueries({ queryKey: ["back-office"] }));
  await settle();
  for (let i = 0; i < 20 && !document.querySelector('[data-time-row="new"]'); i++) await settle();
  assert.equal(cell("new", "narrative").value, "");
  const accepted: TimeEntry = {
    ...base, status: "confirmed", source: "suggestion", groupId: capture.key,
    proposalDigest: capture.digest, authorId: state.userId,
  };
  const renderSharing = async (revision: number) => act(async () =>
    root.render(
      <MemoryRouter><BackOfficeTheme><TimesheetLedger
        state={{ ...state, supportsBillingComparisons: true, entries: [{ ...accepted, revision }] }}
        initialDate={base.date} onCommand={send} onOriginal={async () => capture}
      /></BackOfficeTheme></MemoryRouter>,
    ),
  );
  await renderSharing(4);
  const submitPeriod = () => {
    const submit = button("Submit period");
    assert.ok(submit);
    return act(async () => submit.click());
  };
  const preview = async () => {
    const show = button("Compare with private proposal");
    assert.ok(show);
    await act(async () => show.click());
    const consent = document.querySelector<HTMLInputElement>("details.bo-time-original input");
    assert.ok(consent);
    assert.equal(consent.checked, false);
    await act(async () => consent.click());
  };
  await submitPeriod();
  assert.deepEqual(commands.at(-1), { type: "submit", entries: [{ id: base.id, revision: 4 }] });
  await preview();
  await submitPeriod();
  assert.deepEqual(commands.at(-1), { type: "submit", entries: [{
    id: base.id, revision: 4, shareOriginal: { key: capture.key, digest: capture.digest },
  }] });
  await renderSharing(5);
  await preview();
  await renderSharing(6);
  await submitPeriod();
  assert.deepEqual(commands.at(-1), { type: "submit", entries: [{ id: base.id, revision: 6 }] });
  cache.clear();
  const nearestPolicy = {
    scope: "project", targetId: "p2", effectiveFrom: "2026-01-01", revision: 1, stopwatchRoundUp: false,
  } satisfies TimePolicy;
  const timerState = { ...state, entries: [], policies: [nearestPolicy], projects: [
    ...state.projects, { id: "p2", name: "Nearest", matterIds: ["matter"] },
  ] };
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme><TimesheetLedger key="timer" state={timerState} onCommand={send}
      initialDraft={{ key: crypto.randomUUID(), source: "suggestion", captureSource: "stopwatch",
        proposalDigest: "b".repeat(64), entry: { ...base, workedMinutes: 10, billableMinutes: 20,
          endAt: "2026-11-12T09:10:01Z" } }}
    /></BackOfficeTheme></MemoryRouter>,
  ));
  assert.equal(cell("new", "charge").value, "20");
  await input(cell("new", "matter"), "Client · M · 26/12 · Nearest");
  assert.equal(cell("new", "charge").value, "10", "project switch recalculates the stopwatch proposal");
  await input(cell("new", "matter"), "Client · M · 26/12 · Project");
  assert.equal(cell("new", "charge").value, "20", "seconds survive the project switch");
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
  await input(cell("new", "matter"), "Client · M · 26/12 · Nearest");
  assert.equal(participantInputs[2].value, "20");
  await input(participantInputs[2], "40");
  await input(cell("new", "matter"), "Client · M · 26/12 · Project");
  assert.equal(participantInputs[2].value, "40");
  await input(cell("new", "billableWork"), "21");
  assert.equal(cell("new", "charge").value, "30");
  await input(cell("new", "charge"), "40");
  await input(cell("new", "matter"), "Client · M · 26/12 · Nearest");
  await input(cell("new", "billableWork"), "13");
  assert.equal(cell("new", "charge").value, "40", "explicit charge edits remain intentional");
  await input(cell("new", "nonBillable"), "4");
  await input(cell("new", "billableWork"), "0");
  assert.equal(cell("new", "charge").value, "0", "non-billable work is never rounded into a charge");
  const { BillingPreferences } = await import("../../src/react-app/domains/back-office/billing-preferences");
  await act(async () => root.render(
    <MemoryRouter><BackOfficeTheme><BillingPreferences state={timerState} onCommand={send}
      initialProjectId="p1" initialDate={base.date}
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
  assert.equal(savedPolicy.policy.scope, "project");
  assert.equal(savedPolicy.policy.targetId, "p1");
  assert.equal(savedPolicy.policy.stopwatchRoundUp, false);

  const { TimesheetWorkday } = await import("../../src/react-app/domains/back-office/timesheet-workday");
  const otherDate = "2026-11-11";
  const at = (day: string, clock: string) => new Date(day + "T" + clock).toISOString();
  const booked = { ...base, id: crypto.randomUUID(), date: otherDate,
    startAt: at(otherDate, "10:00:00"), endAt: at(otherDate, "10:34:00") };
  const exact: CaptureProposal = { ...capture, key: crypto.randomUUID(), digest: "1".repeat(64),
    date: otherDate, startAt: booked.startAt, endAt: booked.endAt };
  const partial: CaptureProposal = { ...exact, key: crypto.randomUUID(), digest: "2".repeat(64),
    parentDigest: exact.digest, startAt: at(otherDate, "10:30:00"), endAt: at(otherDate, "10:50:00"), workedMinutes: 20 };
  const inlineTimer: CaptureProposal = { ...exact, key: crypto.randomUUID(), digest: "3".repeat(64),
    source: "stopwatch", date: base.date, startAt: at(base.date, "09:00:00"), endAt: at(base.date, "09:10:01"), workedMinutes: 10 };
  const workdayDirectory: BackOfficeState = {
    scope: "local", directoryId: "synthetic", model: defaultBackOfficeModel(), views: [],
    records: [{
      id: booked.id, objectId: "timeEntries", ownerId: state.userId, revision: 7, schemaRevision: 1,
      access: "org", members: [], sourceId: undefined, createdAt: booked.startAt, updatedAt: booked.startAt, archivedAt: null,
      values: { name: booked.narrative, matter: booked.matterId, serviceDate: booked.date, recordedMinutes: booked.workedMinutes },
    }],
    permissions: { userId: state.userId, edit: true, model: false, finance: false },
    sync: { enabled: false, cursor: 0, pending: 0, error: null },
  };
  const { t } = await import("../../src/i18n");
  const selectedModel = { workspaceId: "synthetic", providerID: "eigenwelt", modelID: "test-haiku" };
  const workdayActions: CaptureAction[] = [];
  const unedited = { ...exact, key: crypto.randomUUID(), digest: "7".repeat(64), startAt: null, endAt: null };
  let workdayProposals = [exact, partial, inlineTimer, unedited];
  let workdaySettings: CaptureSettings = { calendar: true, tasks: false, aiSuggestions: false, intervalMinutes: 0 as const };
  const workdayClient = { ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
    privateWorkday: async (context: { date: string }, action?: CaptureAction) => {
      if (action) workdayActions.push(action);
      if (action?.type === "settings") workdaySettings = action.settings;
      if (action?.type === "reconcile") workdayProposals = workdayProposals.filter(proposal => proposal.key !== action.key);
      if (action?.type === "correct") workdayProposals = workdayProposals.map(proposal => proposal.key === action.key
        ? { ...proposal, digest: "4".repeat(64), startAt: action.startAt, endAt: action.endAt, workedMinutes: action.workedMinutes }
        : proposal);
      return { settings: workdaySettings, wording: action?.type === "refresh" && action.model && workdaySettings.aiSuggestions ? { [unedited.digest]: { activity: "EXM", narrative: "Generated meeting wording" } } : undefined,
        modelReady: false, connections: [],
        drafts: context.date === partial.date && workdaySettings.calendar ? {
          [partial.key]: { date: partial.date, proposalDigest: partial.digest, values: { workflow: true, worked: "99" } },
        } : {},
        proposals: workdayProposals.filter(proposal => proposal.date === context.date && (workdaySettings.calendar || proposal.source !== "calendar")) };
    },
  };
  const weeklyState = { ...timerState, entries: [booked], policies: [{ ...nearestPolicy, effectiveFrom: base.date }] };
  const renderWorkday = () => act(async () => root.render(
    <QueryClientProvider client={cache}><MemoryRouter><BackOfficeTheme>
      <TimesheetWorkday client={workdayClient} models={[{ ...selectedModel, label: "Haiku" }, { ...selectedModel, modelID: "luna", label: "Luna" }]} directory={workdayDirectory} state={weeklyState}
        initialDate={base.date} onDraft={() => {}}>
        {captureSheet => <TimesheetLedger capture={captureSheet} state={weeklyState} onCommand={send} />}
      </TimesheetWorkday>
    </BackOfficeTheme></MemoryRouter></QueryClientProvider>,
  ));
  await renderWorkday();
  const aiSwitch = () => {
    const control = document.querySelector<HTMLButtonElement>('.bo-workday-controls [role="switch"]');
    assert.ok(control);
    return control;
  };
  for (let i = 0; i < 20 && aiSwitch().disabled; i++) await settle();
  assert.equal(aiSwitch().getAttribute("aria-checked"), "false");
  assert.equal(workdayActions.some(action => action.type === "refresh"), false);
  assert.equal(workdayActions.some(action => action.type === "refresh" && action.model), false);
  await act(async () => aiSwitch().click());
  assert.equal(aiSwitch().getAttribute("aria-checked"), "true");
  const modelRefreshes = () => workdayActions.filter(action => action.type === "refresh" && action.model).length;
  const initialRefreshes = modelRefreshes();
  assert.equal(initialRefreshes, 1);
  await act(async () => root.render(null));
  await renderWorkday();
  for (let i = 0; i < 20 && modelRefreshes() === initialRefreshes; i++) await settle();
  assert.equal(aiSwitch().getAttribute("aria-checked"), "true");
  assert.equal(modelRefreshes(), initialRefreshes + 1);
  const navigateDay = async (label: string) => {
    const arrow = document.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]');
    assert.ok(arrow);
    await act(async () => arrow.click());
  };
  await navigateDay(t("calendar.next_day"));
  await navigateDay(t("calendar.previous_day"));
  assert.equal(document.querySelector<HTMLInputElement>('.bo-workday-controls input[type=date]')?.value, base.date);
  const weekly = button("Week");
  assert.ok(weekly);
  await act(async () => weekly.click());
  const suggestionRow = (proposal: CaptureProposal) => document.querySelector<HTMLElement>(
    `[data-time-proposal="${proposal.key}"]`,
  );
  for (let i = 0; i < 20 && !suggestionRow(partial); i++) await settle();
  const weekDays = [...document.querySelectorAll<HTMLButtonElement>(".bo-time-week button")];
  assert.equal(weekDays.length, 7);
  const weekdayHeaders = [...document.querySelectorAll(".bo-time-week th[scope=col]")].map(cell => cell.textContent);
  assert.deepEqual(weekdayHeaders, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const wednesday = weekDays[2];
  assert.equal(wednesday.querySelector("time")?.dateTime, otherDate);
  assert.deepEqual([...wednesday.querySelectorAll("span")].map(item => item.textContent),
    [t("timesheets.sheet.worked", { minutes: 34 }), t("timesheets.sheet.charge", { minutes: 30 })]);
  assert.equal(wednesday.getAttribute("aria-pressed"), "false");
  const acceptFor = (proposal: CaptureProposal) => suggestionRow(proposal)?.querySelector<HTMLButtonElement>('[aria-label="Accept suggestion"]');
  assert.equal(acceptFor(exact)?.disabled, true);
  assert.equal(acceptFor(partial)?.disabled, true, "a previously corrected proposal can still conflict");
  const proposalCell = (proposal: CaptureProposal, field: string) => {
    const result = suggestionRow(proposal)?.querySelector<HTMLInputElement>(`[data-column="${field}"]`);
    assert.ok(result);
    return result;
  };
  const beforeConflict = commands.length;
  await act(async () => proposalCell(partial, "narrative").dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Enter", ctrlKey: true, bubbles: true,
  })));
  assert.equal(commands.length, beforeConflict, "the keyboard shortcut cannot accept an overlapping proposal");
  const link = suggestionRow(exact)?.parentElement?.querySelector<HTMLSelectElement>("select");
  assert.ok(link);
  await act(async () => {
    link.value = booked.id;
    link.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  for (let i = 0; i < 20 && suggestionRow(exact); i++) await settle();
  assert.deepEqual(workdayActions.find(action => action.type === "reconcile"), {
    type: "reconcile", key: exact.key, digest: exact.digest, recordId: booked.id, recordRevision: 7,
  });
  assert.equal(suggestionRow(exact), null);
  assert.equal(acceptFor(partial)?.disabled, true, "recorded work still overlaps the remaining proposal");
  await act(async () => wednesday.click());
  assert.deepEqual(workdayActions.find(action => action.type === "refresh" && action.model), { type: "refresh", model: selectedModel });
  assert.equal(proposalCell(unedited, "narrative").value, "Generated meeting wording");
  assert.equal(workdayActions.some(action => action.type === "draft" && action.key === unedited.key), false);
  assert.equal(commands.length, beforeConflict);
  await act(async () => aiSwitch().click());
  assert.equal(suggestionRow(unedited), null);
  assert.ok(suggestionRow(inlineTimer));
  await act(async () => aiSwitch().click());
  assert.equal(proposalCell(unedited, "narrative").value, "Generated meeting wording");
  assert.equal(wednesday.getAttribute("aria-pressed"), "true");
  const correctPartial = [...(suggestionRow(partial)?.parentElement?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find(button => button.textContent === "Correct");
  assert.ok(correctPartial);
  await act(async () => correctPartial.click());
  const correctionForm = document.querySelector<HTMLFormElement>(".bo-workday-correction");
  assert.ok(correctionForm);
  const correctedStart = correctionForm.querySelector<HTMLInputElement>('input[type="time"]');
  assert.ok(correctedStart);
  await input(correctedStart, "10:34");
  await act(async () => correctionForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  for (let i = 0; i < 20 && acceptFor(partial)?.disabled; i++) await settle();
  assert.equal(acceptFor(partial)?.disabled, false, "touching the booking boundary clears the overlap");
  assert.equal(proposalCell(partial, "billableWork").value, "16", "the corrected suggestion ignores the old draft");
  assert.equal(proposalCell(inlineTimer, "charge").value, "20");
  await input(proposalCell(inlineTimer, "matter"), "Client · M · 26/12 · Nearest");
  assert.equal(proposalCell(inlineTimer, "charge").value, "10");
  await input(proposalCell(inlineTimer, "date"), otherDate);
  assert.equal(proposalCell(inlineTimer, "charge").value, "20", "the exact interval uses the new effective date's policy");
  await input(proposalCell(inlineTimer, "charge"), "");
  assert.equal(proposalCell(inlineTimer, "charge").value, "", "deleting an automatic charge leaves the input blank for editing");
  await input(proposalCell(inlineTimer, "charge"), "40");
  await input(proposalCell(inlineTimer, "date"), base.date);
  await input(proposalCell(inlineTimer, "nonBillable"), "3");
  assert.equal(proposalCell(inlineTimer, "charge").value, "40", "an explicit charge survives date and allocation changes");
  await input(proposalCell(inlineTimer, "billableWork"), "0");
  assert.equal(proposalCell(inlineTimer, "charge").value, "0");
  const thursday = document.querySelectorAll<HTMLButtonElement>(".bo-time-week button")[3];
  assert.ok(thursday);
  await act(async () => thursday.click());
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="AI suggestion settings"]')?.click());
  const modelSelect = document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model"]');
  assert.ok(modelSelect);
  assert.match(modelSelect.textContent ?? "", /Automatic.*Haiku/);
  await act(async () => modelSelect.click());
  const luna = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent === "Luna");
  assert.ok(luna);
  await act(async () => {
    luna.dispatchEvent(new window.PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    luna.click();
  });
  await settle();
  assert.deepEqual(workdaySettings.model, { providerID: "eigenwelt", modelID: "luna" });
  assert.ok(workdayActions.some(action => action.type === "refresh" && action.model?.modelID === "luna"));
  const calendarSwitch = document.querySelector<HTMLElement>('[data-slot="popover-content"] [role="switch"]');
  assert.ok(calendarSwitch);
  await act(async () => calendarSwitch.click());
  for (let i = 0; i < 20 && suggestionRow(partial); i++) await settle();
  assert.equal(suggestionRow(partial), null, "a source disabled on Thursday disappears from Wednesday");
  assert.ok(suggestionRow(inlineTimer), "the stopwatch source stays available");
  const settingsButton = document.querySelector<HTMLButtonElement>('[aria-label="AI suggestion settings"]');
  await act(async () => settingsButton?.click());
  const month = [...document.querySelectorAll<HTMLButtonElement>(".time-sheet-period button")].find(button => button.textContent === "Month");
  assert.ok(month);
  await act(async () => month.click());
  assert.equal(document.querySelectorAll(".bo-time-month button").length, 30);
  const firstWeek = document.querySelector(".bo-time-month tbody tr");
  assert.equal(firstWeek?.children.length, 7);
  assert.equal(firstWeek?.children[6].querySelector("time")?.dateTime, "2026-11-01", "November begins under Sunday");
  assert.equal(firstWeek?.querySelectorAll("button").length, 1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Next month"]')?.click());
  assert.equal(document.querySelectorAll(".bo-time-month button").length, 31);
  cache.clear();
  console.log("Timesheet ledger passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
