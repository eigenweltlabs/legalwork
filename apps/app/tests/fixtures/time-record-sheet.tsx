import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BackOfficeRecord } from "@legalwork/types/back-office";
import type { CaptureAction } from "@legalwork/types/time-capture";
import type { TimeCaptureSheet } from "../../src/react-app/domains/back-office/time-record-sheet";
import type { BackOfficeState } from "../../src/react-app/domains/back-office/api";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, sessionStorage: window.sessionStorage, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element, Node: window.Node, Event: window.Event, DOMRect: window.DOMRect,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

// Initialize Lexical after the test DOM exists and before the shared composer is loaded.
await import("lexical");
// The Bun DOM fixture has no asset bundler. Panel avatar URLs are supplied by Vite in the app.
const { mock } = await import("bun:test");
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-animation", () => ({ assistantAvatarAnimations: {} }));
mock.module("../../src/react-app/domains/session/sidebar/assistant-avatar-assets", () => ({
  assistantAvatarImages: {}, assistantAvatarIcon: () => "flower",
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { BackOfficeRecordSchema, BackOfficeValueSchema, defaultBackOfficeModel, z } = await import("@legalwork/types/back-office");
const { captureProposalSchema } = await import("@legalwork/types/time-capture");
const { TimesheetStateSchema } = await import("@legalwork/types/timesheet");
const { TimeRecordSheet } = await import("../../src/react-app/domains/back-office/time-record-sheet");
const { BackOfficeTheme } = await import("../../src/react-app/domains/back-office/twenty-controls");
const { createLegalworkServerClient, LegalworkServerError } = await import("../../src/app/lib/legalwork-server");
const { t } = await import("../../src/i18n");
const first = "2026-11-17";
const second = "2026-11-18";
const matter = crypto.randomUUID();
const invoice = crypto.randomUUID();
const workerContact = BackOfficeRecordSchema.parse({
  id: crypto.randomUUID(), objectId: "people", revision: 1, schemaRevision: 1, ownerId: "worker",
  sourceId: "eigenwelt-member:worker", values: { name: "Worker", active: true },
  createdAt: first + "T00:00:00Z", updatedAt: first + "T00:00:00Z", archivedAt: null,
});
const directory: BackOfficeState = {
  scope: "fixture", directoryId: "directory", captureProfileId: "a".repeat(64), model: defaultBackOfficeModel(),
  records: [workerContact], views: [], permissions: { userId: "worker", principalKey: "principal", edit: true, model: false, finance: true },
  sync: { enabled: true, cursor: 0, pending: 0, error: null },
};
const primary = crypto.randomUUID(), secondary = crypto.randomUUID(), unrelated = crypto.randomUUID(), noClients = crypto.randomUUID(), secondMatter = crypto.randomUUID();
const linkedClients = [primary, secondary, unrelated].map((id, index) => ({ id, name: ["Primary client", "Secondary client", "Unrelated client"][index] }));
const clientRecords = linkedClients.map(item => BackOfficeRecordSchema.parse({ ...workerContact, id: item.id, objectId: "clients", values: { name: item.name } }));
const newMatter = BackOfficeRecordSchema.parse({ ...workerContact, id: secondMatter, objectId: "matters", values: { name: "Second matter" } });
const singleClientMatter = BackOfficeRecordSchema.parse({ ...newMatter, id: crypto.randomUUID(), values: { name: "Single client matter" } });
const state = TimesheetStateSchema.parse({
  userId: "worker", scope: "fixture", service: "records", canManage: true, canReview: true,
  entries: [], matters: [{ id: matter, name: "Research matter", reference: "", clientIds: [primary, secondary] }, { id: noClients, name: "Unlinked matter", reference: "", clientIds: [] }, { id: secondMatter, name: "Second matter", reference: "", clientIds: [primary, secondary] }, { id: singleClientMatter.id, name: "Single client matter", reference: "", clientIds: [primary] }],
  clients: linkedClients, projects: [], people: [], products: [], policies: [], invoices: [],
});
const proposal = captureProposalSchema.parse({
  key: crypto.randomUUID(), digest: "b".repeat(64), date: first, source: "calendar", matterId: matter, projectId: null,
  activity: "RES", narrative: "Private suggestion", startAt: null, endAt: null, workedMinutes: 15, dismissed: false,
});
const savedRow = BackOfficeRecordSchema.parse({
  id: crypto.randomUUID(), objectId: "timeEntries", revision: 1, schemaRevision: 1, ownerId: "worker",
  values: { name: "Before refresh", billingNarrative: "Before refresh", matter, client: primary, timekeeper: workerContact.id, serviceDate: first,
    startedAt: first + "T11:00:00Z", endedAt: first + "T11:15:00Z", recordedMinutes: 15, billableMinutes: 15,
    hourlyRate: { amountMinor: 12000, currency: "EUR" }, invoice, status: "Invoiced" },
  createdAt: first + "T00:00:00Z", updatedAt: first + "T00:00:00Z", archivedAt: null,
});
let current = savedRow;
let rejectUpdate = false;
let rejectCreate = false;
let canDelegate = false;
let rosterOffline = true;
const createdRows = new Map<string, BackOfficeRecord>();
const writeSchema = z.object({
  id: z.string(), revision: z.number(), values: z.record(z.string(), BackOfficeValueSchema), create: z.boolean().optional(),
  timekeeperUserId: z.string().optional(), expectedValues: z.record(z.string(), BackOfficeValueSchema).optional(),
  privateProposal: z.object({ key: z.string(), digest: z.string(), profileId: z.string(), draftRevision: z.number().optional() }).optional(),
});
const writes: z.infer<typeof writeSchema>[] = [];
const privateActions: CaptureAction[] = [];
const client = createLegalworkServerClient({ baseUrl: "http://localhost" });
client.backOffice = async (path, options) => {
  if (path === "/time-members" && rosterOffline) throw new Error("Roster unavailable");
  if (path === "/time-members") return { members: [{ userId: "worker", name: "Worker", email: null }, { userId: "other", name: "Other worker", email: null, canRecordTimeFor: canDelegate }] };
  assert.equal(path, "/records");
  const write = writeSchema.parse(options?.body);
  writes.push(write);
  if (write.create) {
    if (rejectCreate) {
      rejectCreate = false;
      throw new Error("Billing service temporarily unavailable");
    }
    const record = BackOfficeRecordSchema.parse({ ...savedRow, id: write.id, values: { ...write.values, timekeeper: workerContact.id } });
    createdRows.set(write.id, record);
    return { record };
  }
  const created = createdRows.get(write.id);
  if (created) {
    const record = { ...created, revision: created.revision + 1, values: { ...created.values, ...write.values } };
    createdRows.set(write.id, record);
    return { record };
  }
  if (rejectUpdate) {
    rejectUpdate = false;
    throw new LegalworkServerError(409, "back_office_field_conflict", "Field conflict", { record: current, fields: ["recordedMinutes"] });
  }
  current = { ...current, revision: current.revision + 1, values: { ...current.values, ...write.values } };
  return { record: current };
};
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const capture = (values: Partial<TimeCaptureSheet> = {}): TimeCaptureSheet => ({
  proposals: [], drafts: {}, date: first, dates: [first], overlaps: new Set(), selectDate: () => {},
  privateAvailable: false, act: async action => { privateActions.push(action); return true; }, openSource: () => {}, ...values,
});
const render = async (capture: TimeCaptureSheet, records = directory.records) => {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><BackOfficeTheme>
    <TimeRecordSheet client={client} directory={{ ...directory, records: [...records, ...clientRecords, newMatter, singleClientMatter] }} state={state} capture={capture}
      workspace={(entries, renderProposal) => <>{entries}<aside>{capture.proposals.map(proposal => {
        const details = renderProposal(proposal);
        return details && <div key={proposal.key} data-private-proposal={proposal.key}>{details}</div>;
      })}</aside></>} />
  </BackOfficeTheme></QueryClientProvider></MemoryRouter>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
};
function row(id: string) {
  const result = host.querySelector<HTMLElement>('[data-record-id="' + id + '"]');
  assert.ok(result, "Missing row " + id);
  return result;
}
function cell(container: HTMLElement, column: number) {
  const result = container.querySelector<HTMLElement>('[data-col="' + column + '"]');
  assert.ok(result, "Missing column " + column);
  return result;
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
  assert.ok(result, "Missing button " + label);
  return result;
}
function blank() {
  if (!host.querySelector("[data-sheet-blank]")) {
    const add = host.querySelector<HTMLButtonElement>(".time-new-entry");
    assert.ok(add);
    act(() => add.click());
  }
  const result = host.querySelector<HTMLElement>("[data-sheet-blank]");
  assert.ok(result);
  return result;
}
async function enter(container: HTMLElement, column: number, text: string) {
  const target = cell(container, column);
  await act(async () => target.click());
  const input = target.querySelector<HTMLInputElement>("input");
  assert.ok(input, "Enter did not open " + column + " for " + text + " (connected: " + target.isConnected + ")");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    input.focus();
    setter.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  return input;
}
function visible(id: string) { return Boolean(host.querySelector('[data-record-id="' + id + '"]')); }
function proposalDetails(id: string) {
  const details = host.querySelector<HTMLElement>('[data-private-proposal="' + id + '"]');
  assert.ok(details, "Missing private suggestion " + id);
  return details;
}
function selectField(root: HTMLElement, label: string) {
  const element = [...root.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))?.querySelector("select");
  assert.ok(element, label);
  return element;
}
async function editProposal(id: string, field: "textarea" | 'input[data-field="recordedMinutes"]' | 'input[data-field="billableMinutes"]', value: string) {
  const input = proposalDetails(id).querySelector(field);
  assert.ok(input instanceof window.HTMLInputElement || input instanceof window.HTMLTextAreaElement);
  await act(async () => {
    input.focus();
    input.value = value;
    input.blur();
  });
  return input;
}

try {
  // A refresh that removes the source must not send a private row to the directory.
  const active = capture({ proposals: [proposal], privateAvailable: true,
    wording: { [proposal.digest]: { narrative: "Generated private wording", activity: "RES" } } });
  const { weekDates } = await import("../../src/react-app/domains/back-office/timesheet-row");
  const additional = { ...savedRow, id: crypto.randomUUID(), values: { ...savedRow.values, recordedMinutes: 5, billableMinutes: 15 } };
  await render({ ...active, dates: weekDates(first) }, [workerContact, savedRow, additional]);
  const calendarMetrics = (day: string) => [...host.querySelectorAll(`.bo-time-week button:has(time[datetime="${day}"]) span`)].map(item => item.textContent);
  assert.deepEqual(calendarMetrics(first), ["20 · 30"]);
  assert.deepEqual(calendarMetrics(second), ["0 · 0"]);
  assert.match(cell(row(savedRow.id), 6).textContent ?? "", /Invoiced/);
  const documentSave = { ...proposal, key: crypto.randomUUID(), digest: "c".repeat(64), source: "documents" as const, activity: "MOD", narrative: "Reply.docx" };
  await render({ ...active, proposals: [documentSave] });
  assert.equal(visible(documentSave.key), false);
  assert.equal(proposalDetails(documentSave.key).querySelector("textarea")?.value, documentSave.narrative);
  await render(active);
  assert.equal(host.querySelector(".bo-time-week"), null);
  assert.ok(![...host.querySelectorAll('[role="columnheader"]')].some(header => header.textContent?.includes(t("timesheets.sheet.bill_to"))));
  assert.equal(host.querySelector("[data-sheet-blank]"), null);
  assert.ok(host.querySelector(".time-new-entry"));
  assert.equal(visible(proposal.key), false);
  assert.ok(button(proposalDetails(proposal.key), t("timesheets.sheet.decline")));
  assert.ok(button(proposalDetails(proposal.key), t("timesheets.sheet.accept")));
  assert.equal(proposalDetails(proposal.key).querySelector("textarea")?.value, "Generated private wording");
  assert.equal(privateActions.length, 0);
  assert.equal(writes.length, 0);
  const privateInput = await editProposal(proposal.key, "textarea", "Edited privately");
  await render(capture({ privateAvailable: true }));
  assert.equal(privateInput.isConnected, false);
  assert.equal(visible(proposal.key), false);
  assert.equal(writes.length, 0);
  assert.ok(privateActions.some(action => action.type === "draft" && action.key === proposal.key && action.proposalDigest === proposal.digest));
  await render({ ...active, overlaps: new Set([proposal.key]) });
  assert.ok(button(proposalDetails(proposal.key), t("timesheets.sheet.accept")).disabled);
  await render(active);
  await act(async () => button(proposalDetails(proposal.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, 0, "chargeable time needs a linked client");
  async function chooseBillingClient(id: string, value: string) {
    const selector = selectField(visible(id) ? row(id) : proposalDetails(id), t("timesheets.sheet.bill_to"));
    assert.equal([...selector.options].some(option => option.value === unrelated), false);
    await act(async () => {
      selector.value = value;
      selector.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }
  await chooseBillingClient(proposal.key, secondary);
  assert.equal(writes.length, 0, "choosing a client does not accept a suggestion");
  await act(async () => button(proposalDetails(proposal.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].values.client, secondary);
  assert.deepEqual(writes[0].privateProposal, { key: proposal.key, digest: proposal.digest, profileId: directory.captureProfileId });
  assert.equal(writes[0].values.billingNarrative, "Edited privately");
  assert.ok(visible(proposal.key));
  assert.equal(host.querySelector('[data-private-proposal="' + proposal.key + '"]'), null);

  // A remote-only draft survives leaving the date and unmounting the page.
  await render(capture());
  const draftId = blank().dataset.recordId;
  assert.ok(draftId);
  await enter(blank(), 3, "Incomplete remote draft");
  await render(capture({ date: second, dates: [second] }));
  assert.equal(visible(draftId), false);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(capture());
  assert.match(cell(row(draftId), 3).textContent ?? "", /Incomplete remote draft/);
  assert.equal(host.querySelector(".time-sheet-sync")?.textContent, t("timesheets.sheet.edit_unsaved"));
  assert.equal(writes.length, 1);
  const beforeClose = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(beforeClose);
  assert.ok(beforeClose.defaultPrevented);
  await act(async () => button(row(draftId), t("timesheets.sheet.edit_discard")).click());
  assert.equal(visible(draftId), false);

  // Peer changes preserve the open edit baseline and unrelated server fields.
  await render(capture(), [workerContact, savedRow]);
  const minutesInput = await enter(row(savedRow.id), 4, "25");
  current = { ...savedRow, revision: 2, values: { ...savedRow.values, recordedMinutes: 30, billingNarrative: "Colleague's narrative" } };
  rejectUpdate = true;
  await render(capture(), [workerContact, current]);
  assert.equal(minutesInput.value, "25");
  await act(async () => minutesInput.blur());
  assert.equal(writes.length, 2);
  assert.equal(writes[1].revision, 1);
  assert.deepEqual(writes[1].expectedValues, { recordedMinutes: 15, startedAt: savedRow.values.startedAt, endedAt: savedRow.values.endedAt });
  assert.deepEqual(writes[1].values, { recordedMinutes: 25, startedAt: first, endedAt: null });
  assert.match(row(savedRow.id).textContent ?? "", /Colleague's narrative/);
  await act(async () => button(row(savedRow.id), t("back_office.conflict.apply")).click());
  assert.equal(writes[2].revision, 2);
  assert.deepEqual(writes[2].expectedValues, { recordedMinutes: 30, startedAt: savedRow.values.startedAt, endedAt: savedRow.values.endedAt });
  assert.equal(current.values.billingNarrative, "Colleague's narrative");
  assert.equal(current.values.recordedMinutes, 25);

  // A synthetic member chip opens no directory record.
  const memberCell = cell(row(savedRow.id), 1);
  assert.ok(memberCell.textContent?.includes(t("timesheets.ledger.me")));
  assert.equal(memberCell.querySelector("button"), null);

  const reconcile = { ...proposal, key: crypto.randomUUID() };
  await render(capture({ proposals: [reconcile], privateAvailable: true }), [workerContact, current]);
  const matchingEntries = selectField(proposalDetails(reconcile.key), t("timesheets.sheet.reconcile"));
  await act(async () => {
    matchingEntries.value = current.id;
    matchingEntries.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(privateActions.at(-1), { type: "reconcile", key: reconcile.key, digest: reconcile.digest, recordId: current.id, recordRevision: current.revision });
  assert.equal(visible(reconcile.key), false);
  assert.equal(writes.length, 3);

  // Structured clipboard data copies into the selected day and clears billing links.
  await render(capture({ date: second, dates: [first, second] }), [workerContact, current]);
  const transfer = new window.DataTransfer();
  transfer.setData("text/plain", JSON.stringify({ legalworkTimeRow: 1, values: savedRow.values }));
  const paste = new window.ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
  const pasteTarget = cell(blank(), 3);
  await act(async () => pasteTarget.dispatchEvent(paste));
  assert.ok(paste.defaultPrevented);
  const copied = [...host.querySelectorAll<HTMLElement>("[data-record-id]")].find(element => element !== blank() && /Before refresh/.test(element.textContent ?? ""));
  assert.ok(copied);
  assert.match(copied.textContent ?? "", /Private draft/);
  const copyId = copied.dataset.recordId;
  assert.ok(copyId);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(capture({ date: second, dates: [first, second] }), [workerContact, current]);
  assert.notEqual(blank().dataset.recordId, copyId);
  assert.match(row(copyId).textContent ?? "", /Private draft/);
  await act(async () => cell(row(copyId), 3).click());
  await act(async () => cell(row(copyId), 3).querySelector("input")?.blur());
  assert.equal(writes.length, 4);
  assert.notEqual(writes[3].id, savedRow.id);
  assert.equal(writes[3].values.startedAt, second);
  assert.equal(writes[3].values.serviceDate, second);
  assert.equal(writes[3].values.endedAt, null);
  assert.equal(writes[3].values.invoice, null);
  assert.equal(writes[3].values.status, "Draft");
  assert.deepEqual(writes[3].values.hourlyRate, { amountMinor: 12000, currency: "EUR" });
  const unlinked = { ...proposal, key: crypto.randomUUID(), matterId: noClients };
  const uncharged = { ...proposal, key: crypto.randomUUID() };
  await render(capture({ proposals: [unlinked, uncharged], privateAvailable: true }), [workerContact, current]);
  await act(async () => button(proposalDetails(unlinked.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, 4);
  assert.match(proposalDetails(unlinked.key).textContent ?? "", /Add a client to this matter/);
  await editProposal(uncharged.key, 'input[data-field="billableMinutes"]', "0");
  await act(async () => button(proposalDetails(uncharged.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, 5);
  assert.equal(writes[4].values.client, null);
  assert.equal(writes[4].values.billableMinutes, 0);
  const firstCell = host.querySelector<HTMLElement>('[role="gridcell"]');
  assert.ok(firstCell);
  const reverseTab = () => new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  const fromCell = reverseTab();
  await act(async () => firstCell.dispatchEvent(fromCell));
  assert.equal(fromCell.defaultPrevented, false);
  await act(async () => firstCell.click());
  const firstInput = firstCell.querySelector("input");
  assert.ok(firstInput);
  const fromEditor = reverseTab();
  await act(async () => firstInput.dispatchEvent(fromEditor));
  assert.equal(fromEditor.defaultPrevented, false);
  blank();
  const finalRow = [...host.querySelectorAll<HTMLElement>("[data-record-id]")].at(-1);
  assert.ok(finalRow);
  const lastInput = await enter(finalRow, 5, cell(finalRow, 5).textContent?.trim() ?? "");
  const forwardTab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => lastInput.dispatchEvent(forwardTab));
  assert.equal(forwardTab.defaultPrevented, true, "Tab moves from Billable to Status");
  const lastTab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await act(async () => cell(finalRow, 6).dispatchEvent(lastTab));
  assert.equal(lastTab.defaultPrevented, false, "Tab at the last column leaves the grid");
  // Editing a booked row must never send a chargeable matter change without its bill-to.
  await render(capture(), [workerContact, current]);
  const choose = async (column: number, label: string) => {
    await act(async () => cell(row(savedRow.id), column).click());
    const option = [...document.querySelectorAll<HTMLButtonElement>(".bo-choices button")].find(button => button.textContent?.includes(label));
    assert.ok(option, label);
    await act(async () => option.click());
  };
  const before = current;
  await choose(2, "Second matter");
  assert.equal(writes.length, 5);
  assert.match(row(savedRow.id).textContent ?? "", /Choose a billing client/);
  const narrative = await enter(row(savedRow.id), 3, "Unrelated queued narrative");
  await act(async () => narrative.blur());
  assert.equal(writes.length, 5);
  current = { ...current, revision: current.revision + 1, values: { ...current.values, privateNote: "Remote update" } };
  await render(capture(), [workerContact, current]);
  await chooseBillingClient(savedRow.id, secondary);
  assert.equal(writes.length, 7);
  assert.equal(writes[5].revision, before.revision);
  assert.deepEqual(writes[5].expectedValues, { matter, client: primary });
  assert.deepEqual(writes[5].values, { matter: secondMatter, client: secondary });
  assert.deepEqual(writes[6].values, { billingNarrative: "Unrelated queued narrative", name: "Unrelated queued narrative" });
  assert.equal(current.values.privateNote, "Remote update");

  await chooseBillingClient(savedRow.id, "");
  assert.equal(writes.length, 7, "clearing a billing client waits while the row has a positive charge");
  const zeroCharge = await enter(row(savedRow.id), 5, "0");
  await act(async () => zeroCharge.blur());
  assert.equal(writes.length, 8);
  assert.deepEqual(writes[7].expectedValues, { client: secondary, billableMinutes: 15 });
  assert.deepEqual(writes[7].values, { client: null, billableMinutes: 0 });
  // A date edit keeps the draft on its originating day. Only the completed record belongs to the target day.
  let openedDate = "";
  const origin = capture({ privateAvailable: true, selectDate: value => { openedDate = value; } });
  await render(origin, [workerContact, current]);
  const previousCreations = host.querySelectorAll(".time-created-entry").length;
  const summaryValues = () => [...host.querySelectorAll(".time-sheet-summary > span:not(.time-sheet-sync)")].map(item => item.textContent);
  const originTotals = summaryValues();
  const offDayId = blank().dataset.recordId;
  assert.ok(offDayId);
  const workDate = await enter(blank(), 0, second);
  await act(async () => workDate.blur());
  assert.equal(blank().dataset.recordId, offDayId);
  assert.ok(privateActions.some(action => action.type === "draft" && action.key === offDayId && action.date === first && action.values?.startedAt === second));
  assert.equal(host.querySelectorAll(".time-created-entry").length, previousCreations);
  const description = await enter(row(offDayId), 3, "Off-day work");
  await act(async () => description.blur());
  await act(async () => cell(row(offDayId), 2).click());
  const option = [...document.querySelectorAll<HTMLButtonElement>(".bo-choices button")].find(button => button.textContent?.includes("Single client matter"));
  assert.ok(option);
  await act(async () => option.click());
  const worked = await enter(row(offDayId), 4, "10");
  await act(async () => worked.blur());
  assert.equal(writes.length, 9, "the completed manual row needs no clock or separate charge input");
  assert.equal(writes.at(-1)?.values.startedAt, second);
  assert.equal(writes.at(-1)?.values.client, primary, "the only billing client was assigned without user input");
  assert.equal(writes.at(-1)?.timekeeperUserId, directory.permissions.userId);
  assert.ok(row(offDayId).closest(".time-created-entry"), "a saved off-day row stays editable in its receipt");
  assert.equal(host.querySelectorAll(`[data-record-id="${offDayId}"]`).length, 1);
  const billable = await enter(row(offDayId), 5, "8");
  await act(async () => billable.blur());
  assert.equal(writes.at(-1)?.id, offDayId);
  assert.deepEqual(writes.at(-1)?.values, { billableMinutes: 8 });
  assert.match(cell(row(offDayId), 5).textContent ?? "", /8/);
  assert.deepEqual(summaryValues(), originTotals, "off-day receipts stay outside the selected date totals");
  assert.notEqual(blank().dataset.recordId, offDayId);
  assert.equal(host.querySelectorAll(".time-created-entry").length, previousCreations + 1);
  const receipt = host.querySelector<HTMLButtonElement>(".time-created-entry .time-created-date");
  assert.ok(receipt);
  assert.match(receipt.parentElement?.textContent ?? "", /Off-day work/);
  await act(async () => receipt.click());
  assert.equal(openedDate, second);
  await render(capture({ date: second, dates: [second] }));
  assert.equal(visible(offDayId), true);
  assert.equal(host.querySelector(".time-booking-receipt"), null);
  assert.equal(host.querySelector(".time-sheet-summary select"), null, "membership alone does not enable delegation");
  rosterOffline = false;
  canDelegate = true;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["back-office"] }); });
  const currentWorkersProposal = { ...proposal, key: crypto.randomUUID(), digest: "d".repeat(64) };
  const workerView = { ...active, proposals: [currentWorkersProposal] };
  const otherContact = { ...workerContact, id: crypto.randomUUID(), sourceId: "eigenwelt-member:other" };
  const otherEntry = { ...current, id: crypto.randomUUID(), values: { ...current.values, timekeeper: otherContact.id } };
  const workerRecords = [workerContact, current, otherContact, otherEntry];
  await render(workerView, workerRecords);
  const filter = host.querySelector<HTMLSelectElement>(".time-sheet-summary select");
  assert.ok(filter);
  await act(async () => { filter.value = "member:other"; filter.dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.ok(visible(otherEntry.id));
  assert.equal(visible(currentWorkersProposal.key), false, "a worker filter cannot turn a private suggestion into a ledger row");
  assert.ok(proposalDetails(currentWorkersProposal.key), "the private side remains scoped to the current user");
  const chosenWorker = cell(blank(), 1);
  assert.match(chosenWorker.textContent ?? "", /Other worker/);
  await act(async () => chosenWorker.click());
  const chooseSelf = [...document.querySelectorAll<HTMLButtonElement>(".bo-choices button")].find(item => item.textContent?.includes(t("timesheets.ledger.me")));
  assert.ok(chooseSelf);
  await act(async () => chooseSelf.click());
  assert.match(cell(blank(), 1).textContent ?? "", new RegExp(t("timesheets.ledger.me")));

  rosterOffline = true;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["back-office"] }); });
  await render(workerView, workerRecords);
  assert.equal(host.querySelector(".time-sheet-summary select"), null, "a roster error removes cached delegation");
  assert.equal(visible(otherEntry.id), false);
  assert.ok(visible(savedRow.id), "the authenticated member's contact entries remain visible");
  assert.ok(!button(proposalDetails(currentWorkersProposal.key), t("timesheets.sheet.accept")).disabled);
  rosterOffline = false;
  canDelegate = false;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["back-office"] }); });
  await render(active, [workerContact, current]);
  assert.equal(host.querySelector(".time-sheet-summary select"), null);

  // A poll applies another window's stored draft while this editor still owns focus.
  for (const { field, valueKey, typed, original, remote } of [
    { field: "textarea", valueKey: "billingNarrative", typed: "Window A wording", original: "Before typing", remote: "Window B saved" },
    { field: 'input[data-field="billableMinutes"]', valueKey: "billableMinutes", typed: "24", original: 15, remote: 19 },
    { field: 'input[data-field="recordedMinutes"]', valueKey: "recordedMinutes", typed: "24", original: 15, remote: 19 },
  ]) {
    const candidate = { ...proposal, key: crypto.randomUUID() };
    const initial = { date: first, proposalDigest: candidate.digest, revision: 1, values: { [valueKey]: original } };
    const latest = { ...initial, revision: 2, values: { [valueKey]: remote } };
    const attempts: Array<{ revision: number; value: unknown }> = [];
    const typing = capture({ proposals: [candidate], privateAvailable: true, drafts: { [candidate.key]: initial },
      writeDraft: async action => {
        attempts.push({ revision: action.revision, value: action.changes?.[valueKey] });
        throw new LegalworkServerError(409, "private_draft_conflict", "Private edit conflict", { draft: latest });
      },
    });
    const beforeWrites = writes.length;
    await render(typing);
    const control = proposalDetails(candidate.key).querySelector(field);
    assert.ok(control instanceof window.HTMLInputElement || control instanceof window.HTMLTextAreaElement);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
    assert.ok(setter);
    await act(async () => {
      control.focus();
      setter.call(control, typed);
      control.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await render({ ...typing, drafts: { [candidate.key]: latest } });
    assert.equal(proposalDetails(candidate.key).querySelector(field), control, "refresh must keep the same editing field");
    assert.equal(document.activeElement, control);
    assert.equal(control.value, typed);
    assert.deepEqual(attempts, [], "typing remains local until blur");
    await act(async () => control.blur());
    assert.deepEqual(attempts, [{ revision: 1, value: valueKey === "billingNarrative" ? typed : Number(typed) }]);
    assert.match(proposalDetails(candidate.key).querySelector('[role="alert"]')?.textContent ?? "", /Private edit conflict/);
    assert.equal(writes.length, beforeWrites);
  }

  const { TimesheetWorkday } = await import("../../src/react-app/domains/back-office/timesheet-workday");
  const beforeDirectoryRefresh = captureProposalSchema.parse({
    ...proposal, key: crypto.randomUUID(), digest: "e".repeat(64),
    narrative: "Book before directory refresh", matterId: singleClientMatter.id,
  });
  const nextSuggestion = captureProposalSchema.parse({
    ...beforeDirectoryRefresh, key: crypto.randomUUID(), digest: "f".repeat(64), narrative: "Other private work",
  });
  const pendingDirectory = { ...directory, records: [workerContact, singleClientMatter, ...clientRecords] };
  client.privateStopwatch = async () => ({ profileId: directory.captureProfileId ?? "", active: null, lastStopped: null, projects: [] });
  const workdayDrafts: TimeCaptureSheet["drafts"] = {};
  let sameProposalWasEdited = true;
  client.privateWorkday = async (_context, action) => {
    if (action?.type === "draft-patch") {
      if (action.changes) workdayDrafts[action.key] = { date: action.date, proposalDigest: action.proposalDigest,
        values: { ...(workdayDrafts[action.key]?.values ?? action.initial), ...action.changes }, revision: action.revision + 1 };
      else delete workdayDrafts[action.key];
      if (sameProposalWasEdited && action.key === beforeDirectoryRefresh.key) {
        sameProposalWasEdited = false;
        const values = workdayDrafts[action.key].values;
        values.name = values.billingNarrative = "Saved in another window";
      }
    }
    return ({
    settings: { calendar: true, tasks: false, aiSuggestions: true, intervalMinutes: 0 },
    drafts: workdayDrafts, proposals: [beforeDirectoryRefresh, nextSuggestion], modelReady: false,
    connections: [], chat: [], instructions: [], guidelines: [],
  }); };
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><BackOfficeTheme>
    <TimesheetWorkday client={client} directory={pendingDirectory} state={state} initialDate={first} onDateChange={() => {}}>
      {(capture, workspace) => <TimeRecordSheet client={client} directory={pendingDirectory} state={state}
        capture={capture} workspace={workspace} />}
    </TimesheetWorkday>
  </BackOfficeTheme></QueryClientProvider></MemoryRouter>));
  function timelineButton(id: string) {
    return host.querySelector<HTMLButtonElement>('[data-proposal-id="' + id + '"]');
  }
  for (let i = 0; i < 20 && !timelineButton(beforeDirectoryRefresh.key); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const toBook = timelineButton(beforeDirectoryRefresh.key);
  assert.ok(toBook);
  assert.equal(host.querySelector(".time-workspace-editor"), null);
  const actions = toBook.parentElement?.querySelector<HTMLElement>("[data-calendar-proposal-actions]");
  assert.ok(actions, "a records proposal can be booked directly from its calendar block");
  const acceptFromTimeline = button(actions, t("timesheets.sheet.accept"));
  const countBeforeBooking = writes.length;
  await act(async () => { acceptFromTimeline.focus(); acceptFromTimeline.click(); });
  assert.equal(writes.length, countBeforeBooking, "direct acceptance must show an intervening private edit before booking");
  assert.ok(timelineButton(beforeDirectoryRefresh.key));
  assert.match(host.querySelector(".time-workspace-editor")?.textContent ?? "", /The suggestion changed/);
  await act(async () => { acceptFromTimeline.focus(); acceptFromTimeline.click(); });
  assert.equal(writes.at(-1)?.values.billingNarrative, "Saved in another window");
  assert.equal(writes.at(-1)?.privateProposal?.draftRevision, workdayDrafts[beforeDirectoryRefresh.key].revision);
  assert.equal(timelineButton(beforeDirectoryRefresh.key), null, "the locally acknowledged proposal leaves the timeline before directory refresh");
  assert.equal(host.querySelector(".time-workspace-editor"), null);
  assert.equal(document.activeElement, timelineButton(nextSuggestion.key), "the Records editor restores focus on local acknowledgement");
  const untimed = { ...proposal, key: crypto.randomUUID(), digest: "f".repeat(64),
    source: "documents" as const, matterId: singleClientMatter.id, narrative: "Drafting a response", workedMinutes: null };
  await render(capture({ proposals: [untimed], privateAvailable: true }));
  const recorded = proposalDetails(untimed.key).querySelector<HTMLInputElement>('input[data-field="recordedMinutes"]');
  assert.ok(recorded && !recorded.readOnly && !recorded.disabled, "an untimed document suggestion accepts recorded minutes directly");
  const beforeMinutes = writes.length;
  await editProposal(untimed.key, 'input[data-field="recordedMinutes"]', "25");
  assert.equal(writes.length, beforeMinutes, "entering recorded minutes only updates the private draft");
  assert.equal(proposalDetails(untimed.key).querySelector<HTMLInputElement>('input[data-field="recordedMinutes"]')?.value, "25");
  assert.equal(proposalDetails(untimed.key).querySelector<HTMLInputElement>('input[data-field="billableMinutes"]')?.value, "25");
  await act(async () => button(proposalDetails(untimed.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, beforeMinutes + 1);
  assert.equal(writes.at(-1)?.values.recordedMinutes, 25);
  assert.equal(writes.at(-1)?.values.billableMinutes, 25);
  assert.equal(writes.at(-1)?.values.startedAt, first);
  assert.equal(writes.at(-1)?.values.endedAt, null);
  assert.equal(untimed.workedMinutes, null, "reviewed minutes do not rewrite the original source evidence");

  const retryable = { ...untimed, key: crypto.randomUUID(), workedMinutes: 17, chargeMinutes: 18 };
  await render(capture({ proposals: [retryable], privateAvailable: true }));
  rejectCreate = true;
  await act(async () => button(proposalDetails(retryable.key), t("timesheets.sheet.accept")).click());
  assert.equal(createdRows.has(retryable.key), false);
  assert.match(proposalDetails(retryable.key).textContent ?? "", /Billing service temporarily unavailable/);
  await act(async () => button(proposalDetails(retryable.key), t("timesheets.retry")).click());
  assert.equal(createdRows.get(retryable.key)?.values.recordedMinutes, 17, "retry repeats the failed acceptance, not just a private save");
  assert.equal(createdRows.get(retryable.key)?.values.billableMinutes, 18);

  const privateRetry = { ...retryable, key: crypto.randomUUID() };
  let failPrivate = true;
  await render(capture({ proposals: [privateRetry], privateAvailable: true, act: async action => {
    if (action.type === "draft" && failPrivate) { failPrivate = false; throw new Error("Private save unavailable"); }
    return true;
  } }));
  await editProposal(privateRetry.key, "textarea", "Still private after retry");
  assert.match(proposalDetails(privateRetry.key).textContent ?? "", /Private save unavailable/);
  const beforePrivateRetry = writes.length;
  await act(async () => button(proposalDetails(privateRetry.key), t("timesheets.retry")).click());
  assert.equal(writes.length, beforePrivateRetry, "retrying an edit must not accept the proposal");
  assert.equal(proposalDetails(privateRetry.key).querySelector('[role="alert"]'), null);
  console.log("Time record sheet regressions passed");
} finally {
  await act(async () => root.unmount());
  queryClient.clear();
  await window.happyDOM.close();
}
