import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { TimesheetCommand, TimesheetState, TimeEntry } from "@legalwork/types/timesheet";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><body><div id='root'></div></body></html>");
Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  CSS: window.CSS,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
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
  canReview: true,
  entries: [base],
  policies: [],
  invoices: [],
  matters: [{ id: "matter", name: "M", reference: "26/12", clientIds: ["client"] }],
  clients: [{ id: "client", name: "Client" }],
  projects: [{ id: "p1", name: "Project", matterIds: ["matter"] }],
  people: [
    { id: "anna", name: "Anna" },
    { id: "ben", name: "Ben" },
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
  await clip(cell("new", "narrative"), "paste", clipboard);
  assert.equal(cell("new", "narrative").value, "Edited copy");
  failOnce = true;
  await key(cell("new", "billable"), "Tab");
  assert.equal(cell("new", "narrative").value, "Edited copy");
  await key(cell("new", "billable"), "Tab");
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
  await input(cell("new", "worked"), "20");
  await input(cell("new", "product"), "Memo");
  const beforeDuplicate = commands.length;
  await key(cell("new", "billable"), "Enter");
  assert.equal(commands.length, beforeDuplicate);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Several work products/);
  const productOptions = Array.from(cell("new", "product").list?.querySelectorAll("option") ?? []);
  const chosenProduct = productOptions.find((o) => o.value.includes("Ben") && o.value.includes("wp2"));
  assert.ok(chosenProduct);
  await input(cell("new", "product"), chosenProduct.value);
  await key(cell("new", "billable"), "Enter");
  const modified = commands.at(-1);
  assert.ok(modified?.type === "create");
  assert.equal(modified.entry.workProductId, "wp2");
  await input(cell("new", "activity"), "DFT");
  await input(cell("new", "narrative"), "Separate brief");
  await input(cell("new", "worked"), "20");
  await input(cell("new", "product"), "Memo");
  const separate = area("new").querySelector<HTMLButtonElement>(
    'button[aria-label="Create a separate work product"]',
  );
  assert.ok(separate);
  await act(async () => separate.click());
  await key(cell("new", "billable"), "Enter");
  const fresh = commands.at(-1);
  assert.ok(fresh?.type === "create");
  assert.equal(fresh.entry.workProductId, undefined);
  assert.equal(fresh.entry.createWorkProduct, true);
  assert.equal(fresh.entry.workProductTitle, "Memo");
  for (let i = 0; i < 14; i++) {
    await input(cell("new", "activity"), "RES");
    await input(cell("new", "narrative"), "Research " + i);
    await input(cell("new", "worked"), "20");
    await key(cell("new", "billable"), "Tab");
    assert.equal(document.activeElement, cell("new", "matter"));
  }
  await input(cell("new", "activity"), "RES");
  await input(cell("new", "narrative"), "Long session");
  await input(cell("new", "worked"), "150");
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
  const entry: TimeEntry = { ...base, status: "confirmed" };
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
  await input(cell(base.id, "narrative"), "Corrected");
  await key(cell(base.id, "billable"), "Tab");
  const update = commands.at(-1);
  assert.ok(update?.type === "update");
  assert.equal(update.revision, 4);
  assert.equal(update.entry.narrative, "Corrected");
  assert.equal(update.entry.startAt, base.startAt);
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="worked"]')?.click());
  await input(cell(base.id, "worked"), "55");
  await key(cell(base.id, "billable"), "Tab");
  const resized = commands.at(-1);
  assert.ok(resized?.type === "update");
  assert.equal(resized.entry.startAt, undefined);
  // A shared meeting can be logged for both workers in a weekly list.
  const period = document.querySelector<HTMLSelectElement>(".bo-time-toolbar select");
  assert.ok(period);
  await act(async () => {
    period.value = "week";
    period.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.equal(document.querySelectorAll(".bo-time-week button").length, 7);
  await input(cell("new", "matter"), "26/12 · Project");
  await input(cell("new", "workers"), "Anna + Ben");
  await input(cell("new", "activity"), "INM");
  await input(cell("new", "narrative"), "Meeting");
  await input(cell("new", "worked"), "20");
  await key(cell("new", "billable"), "Tab");
  const meeting = commands.at(-1);
  assert.ok(meeting?.type === "create");
  assert.deepEqual(meeting.workerIds, ["anna", "ben"]);
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
  await act(async () => area(base.id).querySelector<HTMLElement>('[data-column="worked"]')?.click());
  assert.equal(area(base.id).querySelector('[data-column="worked"] input'), null);
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
  console.log("Timesheet ledger passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.abort();
}
