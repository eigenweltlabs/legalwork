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
  window, document: window.document, navigator: window.navigator,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element, Node: window.Node, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

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
const state = TimesheetStateSchema.parse({
  userId: "worker", scope: "fixture", service: "records", canManage: true, canReview: true,
  entries: [], matters: [{ id: matter, name: "Research matter", reference: "", clientIds: [] }],
  clients: [], projects: [], people: [], products: [], policies: [], invoices: [],
});
const proposal = captureProposalSchema.parse({
  key: crypto.randomUUID(), digest: "b".repeat(64), date: first, source: "calendar", matterId: matter, projectId: null,
  activity: "RES", narrative: "Private suggestion", startAt: null, endAt: null, workedMinutes: 15, dismissed: false,
});
const savedRow = BackOfficeRecordSchema.parse({
  id: crypto.randomUUID(), objectId: "timeEntries", revision: 1, schemaRevision: 1, ownerId: "worker",
  values: { name: "Before refresh", billingNarrative: "Before refresh", matter, timekeeper: workerContact.id, serviceDate: first,
    startedAt: first + "T11:00:00Z", endedAt: first + "T11:15:00Z", recordedMinutes: 15, billableMinutes: 15,
    hourlyRate: { amountMinor: 12000, currency: "EUR" }, invoice, status: "Invoiced" },
  createdAt: first + "T00:00:00Z", updatedAt: first + "T00:00:00Z", archivedAt: null,
});
let current = savedRow;
let rejectUpdate = false;
const writeSchema = z.object({
  id: z.string(), revision: z.number(), values: z.record(z.string(), BackOfficeValueSchema), create: z.boolean().optional(),
  timekeeperUserId: z.string().optional(), expectedValues: z.record(z.string(), BackOfficeValueSchema).optional(),
  privateProposal: z.object({ key: z.string(), digest: z.string(), profileId: z.string() }).optional(),
});
const writes: z.infer<typeof writeSchema>[] = [];
const privateActions: CaptureAction[] = [];
const client = createLegalworkServerClient({ baseUrl: "http://localhost" });
client.backOffice = async (path, options) => {
  if (path === "/time-members") return { members: [{ userId: "worker", name: "Worker", email: null }] };
  assert.equal(path, "/records");
  const write = writeSchema.parse(options?.body);
  writes.push(write);
  if (write.create) {
    return { record: BackOfficeRecordSchema.parse({ ...savedRow, id: write.id, values: { ...write.values, timekeeper: workerContact.id } }) };
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
  proposals: [], drafts: {}, date: first, dates: [first], overlaps: new Set(), selectDate: () => {}, showSuggestions: true,
  privateAvailable: false, act: async action => { privateActions.push(action); return true; }, openSource: () => {}, ...values,
});
const render = async (capture: TimeCaptureSheet, records = directory.records) => {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><BackOfficeTheme>
    <TimeRecordSheet client={client} directory={{ ...directory, records }} state={state} capture={capture} />
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
  const result = [...host.querySelectorAll<HTMLElement>("[data-record-id]")].at(-1);
  assert.ok(result);
  return result;
}
async function enter(container: HTMLElement, column: number, text: string) {
  const target = cell(container, column);
  await act(async () => target.click());
  const input = target.querySelector<HTMLInputElement>("input");
  assert.ok(input, "Enter did not open an input");
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

try {
  // A refresh that removes the source must not send a private row to the directory.
  const active = capture({ proposals: [proposal], privateAvailable: true });
  await render(active);
  const privateInput = await enter(row(proposal.key), 3, "Edited privately");
  await render(capture({ privateAvailable: true }));
  assert.equal(privateInput.isConnected, false);
  assert.equal(visible(proposal.key), false);
  assert.equal(writes.length, 0);
  assert.ok(privateActions.some(action => action.type === "draft" && action.key === proposal.key && action.proposalDigest === proposal.digest));
  await render({ ...active, overlaps: new Set([proposal.key]) });
  assert.ok(button(row(proposal.key), t("timesheets.sheet.accept")).disabled);
  await render(active);
  await act(async () => button(row(proposal.key), t("timesheets.sheet.accept")).click());
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].privateProposal, { key: proposal.key, digest: proposal.digest, profileId: directory.captureProfileId });
  assert.equal(writes[0].values.billingNarrative, "Edited privately");
  assert.equal(row(proposal.key).querySelector("button[aria-label='" + t("timesheets.sheet.accept") + "']"), null);

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
  assert.deepEqual(writes[1].expectedValues, { recordedMinutes: 15 });
  assert.deepEqual(writes[1].values, { recordedMinutes: 25 });
  assert.match(row(savedRow.id).textContent ?? "", /Colleague's narrative/);
  await act(async () => button(row(savedRow.id), t("back_office.conflict.apply")).click());
  assert.equal(writes[2].revision, 2);
  assert.deepEqual(writes[2].expectedValues, { recordedMinutes: 30 });
  assert.equal(current.values.billingNarrative, "Colleague's narrative");
  assert.equal(current.values.recordedMinutes, 25);

  // A synthetic member chip opens no directory record.
  const memberCell = cell(row(savedRow.id), 1);
  assert.ok(memberCell.textContent?.includes(t("timesheets.ledger.me")));
  assert.equal(memberCell.querySelector("button"), null);

  const reconcile = { ...proposal, key: crypto.randomUUID() };
  await render(capture({ proposals: [reconcile], privateAvailable: true }), [workerContact, current]);
  const matchingEntries = row(reconcile.key).querySelector("select");
  assert.ok(matchingEntries);
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
  await act(async () => cell(blank(), 3).dispatchEvent(paste));
  assert.ok(paste.defaultPrevented);
  const copied = [...host.querySelectorAll<HTMLElement>("[data-record-id]")].find(element => element !== blank() && /Before refresh/.test(element.textContent ?? ""));
  assert.ok(copied);
  await act(async () => cell(copied, 3).click());
  await act(async () => cell(copied, 3).querySelector("input")?.blur());
  assert.equal(writes.length, 4);
  assert.notEqual(writes[3].id, savedRow.id);
  assert.equal(writes[3].values.startedAt, second);
  assert.equal(writes[3].values.serviceDate, second);
  assert.equal(writes[3].values.endedAt, null);
  assert.equal(writes[3].values.invoice, null);
  assert.equal(writes[3].values.status, "Draft");
  assert.deepEqual(writes[3].values.hourlyRate, { amountMinor: 12000, currency: "EUR" });
  console.log("Time record sheet regressions passed");
} finally {
  await act(async () => root.unmount());
  queryClient.clear();
  await window.happyDOM.close();
}
