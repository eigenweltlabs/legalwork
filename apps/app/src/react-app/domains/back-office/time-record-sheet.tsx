import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X, Plus, Timer, Sparkles, Info, CopyPlus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { z, BackOfficeRecordSchema, BackOfficeViewSchema, type BackOfficeRecord, type BackOfficeValue } from "@legalwork/types/back-office";
import type { CaptureAction, CaptureProposal, CaptureState } from "@legalwork/types/time-capture";
import type { TimesheetState } from "@legalwork/types/timesheet";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { applySavedRecord, writeBackOfficeRecord, type BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordGrid } from "./record-grid";
import { ValueDisplay } from "./record-values";
import { sourceKeys } from "./timesheet-labels";
import { proposalValues, timeRecordDate } from "./time-record-values";
import { conflictingTimeFields, copyTimeRecordValues, differentTimeValues, timeCellChanges, timeRecordConflictSchema, timeRecordEdits, timeRowClipboardSchema, type TimeRecordEdit, type TimeRecordValues, type TimeRowDraft } from "./time-record-edits";
import { useBookingReceipt } from "./time-booking-receipt";
import { periodTimeTotals } from "./timesheet-row";
import { TimesheetWeekTotals } from "./timesheet-week-totals";
import { useNavigate } from "react-router-dom";

const memberPrefix = "member:";
const memberSource = (id: string) => "eigenwelt-member:" + id;
const membersSchema = z.object({ members: z.array(z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable(), canRecordTimeFor: z.boolean().optional() })) });
const responseSchema = z.object({ record: BackOfficeRecordSchema });
const billingFields = ["matter", "client", "billableMinutes"];
const changesBilling = (values: TimeRecordValues) => billingFields.some(field => Object.hasOwn(values, field));
const columnIds = ["startedAt", "timekeeper", "matter", "billingNarrative", "recordedMinutes", "billableMinutes", "status"];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const serviceDate = (values: TimeRecordValues) => timeRecordDate(values.startedAt, values.serviceDate);

export type TimeCaptureSheet = {
  proposals: CaptureProposal[];
  wording?: CaptureState["wording"];
  drafts: CaptureState["drafts"];
  date: string;
  dates: string[];
  selectDate: (date: string, openDay?: boolean) => void;
  overlaps: ReadonlySet<string>;
  linkableRecords?: readonly BackOfficeRecord[];
  privateAvailable: boolean;
  act: (action: CaptureAction) => Promise<boolean>;
  openSource: (proposal: CaptureProposal) => void;
};

type Props = { client: LegalworkServerClient; directory: BackOfficeState; state: TimesheetState; capture: TimeCaptureSheet };

export function TimeRecordSheet(props: Props) {
  const { client, directory } = props;
  const scope = JSON.stringify([client.baseUrl, directory.scope, directory.directoryId, directory.permissions.userId, directory.permissions.principalKey, directory.captureProfileId]);
  return <TimeRecordSheetGrid key={scope} {...props} edits={timeRecordEdits(scope)} />;
}

function TimeRecordSheetGrid({ client, directory, state, capture, edits }: Props & { edits: ReturnType<typeof timeRecordEdits> }) {
  const cache = useQueryClient();
  const navigate = useNavigate();
  useSyncExternalStore(edits.subscribe, edits.snapshot, () => 0);
  const roster = useQuery({ queryKey: ["back-office", client.baseUrl, "time-members", directory.directoryId, directory.permissions.principalKey],
    queryFn: async () => membersSchema.parse(await client.backOffice("/time-members")), retry: false, refetchInterval: 60000 });
  const members = (roster.data?.members ?? []).filter(member => member.userId === directory.permissions.userId || member.canRecordTimeFor === true);
  const self = memberPrefix + directory.permissions.userId;
  const [hiddenProposals, hideProposals] = useState<Set<string>>(new Set());
  const [source, setSource] = useState<string>();
  const [filter, setPerson] = useState(self);
  const person = members.length > 1 && (!filter || members.some(member => memberPrefix + member.userId === filter)) ? filter : self;
  const [composerId, setComposerId] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => setComposerId(undefined), [capture.date]);
  const { showBooking, bookings, receipt } = useBookingReceipt(capture.date, (target, worker) => {
    if (person && person !== worker) setPerson("");
    capture.selectDate(target, true);
  });
  const copied = useRef<TimeRecordValues>(undefined);
  const blankIds = useRef(new Map<string, string>());
  const order = useRef(new Map<string, number>());
  const candidateOrigins = useRef(new WeakMap<BackOfficeRecord, CaptureProposal>());
  const currentCapture = useRef(capture);
  const currentRecords = useRef(new Map<string, BackOfficeRecord>());
  currentCapture.current = capture;
  const blankId = blankIds.current.get(capture.date) ?? crypto.randomUUID();
  blankIds.current.set(capture.date, blankId);
  useLayoutEffect(() => {
    if (composerId === blankId) grid.current?.querySelector<HTMLElement>('[data-sheet-blank] [data-col="0"]')?.focus();
  }, [composerId, blankId]);
  const raw = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);
  useEffect(() => {
    for (const record of directory.records) {
      if (record.revision >= (edits.confirmed.get(record.id)?.revision ?? Infinity)) edits.confirmed.delete(record.id);
    }
  }, [directory.records, edits]);
  if (!raw) return <p role="alert">{t("timesheets.unavailable")}</p>;

  const labeled = displayBackOfficeObject(raw);
  const object = { ...labeled, fields: labeled.fields.filter(field => field.id !== "serviceDate").map(field => {
    if (field.id === "timekeeper") return { ...field, target: "@time-member" };
    if (field.id === "client") return { ...field, label: t("timesheets.sheet.bill_to") };
    if (field.id === "startedAt") return { ...field, type: "date", label: t("timesheets.ledger.date") };
    return field;
  }) } satisfies typeof raw;
  const fieldIds = new Set(raw.fields.map(field => field.id));
  const rosterBySource = new Map(members.map(member => [memberSource(member.userId), memberPrefix + member.userId]));
  const rosterIds = new Set(rosterBySource.values());
  const contacts = new Map<string, string>();
  for (const [member, contact] of edits.memberContacts) if (rosterIds.has(member)) contacts.set(contact, member);
  for (const contact of directory.records) {
    if (contact.objectId !== "people") continue;
    const member = contact.sourceId ? rosterBySource.get(contact.sourceId) : undefined;
    if (member && !contact.archivedAt && contact.values.active !== false) contacts.set(contact.id, member);
    else contacts.delete(contact.id);
  }
  function row(id: string, values: TimeRecordValues): BackOfficeRecord {
    const now = new Date().toISOString();
    return { id, objectId: "timeEntries", values, revision: 0, schemaRevision: directory.model.revision, ownerId: directory.permissions.userId,
      access: "org", members: [], sourceId: undefined, createdAt: now, updatedAt: now, archivedAt: null };
  }
  function fieldValue(record: BackOfficeRecord, id: string) {
    const value = record.values[id];
    if (id === "startedAt") return serviceDate(record.values);
    if (id === "timekeeper") {
      if (typeof value === "string") return contacts.get(value) ?? value;
      const owner = memberPrefix + record.ownerId;
      if (!value && rosterIds.has(owner)) return owner;
    }
    return value;
  }
  function isOwn(record: BackOfficeRecord) {
    return fieldValue(record, "timekeeper") === self || (!record.values.timekeeper && record.ownerId === directory.permissions.userId);
  }
  function isVisible(record: BackOfficeRecord) {
    return capture.dates.includes(serviceDate(record.values)) &&
      (person ? fieldValue(record, "timekeeper") === person || (person === self && isOwn(record))
        : isOwn(record) || rosterIds.has(String(fieldValue(record, "timekeeper"))));
  }
  const known = new Map(directory.records.filter(record => record.objectId === "timeEntries").map(record => [record.id, record]));
  for (const [id, saved] of edits.confirmed) {
    if ((known.get(id)?.revision ?? -1) < saved.revision) known.set(id, saved);
  }
  currentRecords.current = known;
  const stored = [...known.values()].filter(record => !record.archivedAt);
  const visible = stored.filter(isVisible);
  const proposals = capture.proposals.filter(proposal => {
    const worker = edits.drafts.get(proposal.key)?.record.values.timekeeper ?? capture.drafts[proposal.key]?.values.timekeeper ?? self;
    return (!person || person === self || worker === person) && !known.has(proposal.key) && !hiddenProposals.has(proposal.key);
  });
  const proposalMap = new Map(proposals.map(proposal => [proposal.key, proposal]));
  const createdIds = new Set(bookings.map(item => item.id));
  const entries = new Map(visible.map(record => [record.id, record]));
  for (const record of stored) {
    const pending = edits.updates.get(record.id);
    if (!pending) continue;
    const overlay = { ...record, values: Object.assign({}, record.values, ...pending.map(edit => edit.values)) };
    if (entries.has(record.id) || createdIds.has(record.id) || isVisible(overlay)) entries.set(record.id, overlay);
  }
  for (const [id, draft] of Object.entries(capture.drafts)) {
    if ((!person || (draft.values.timekeeper ?? self) === person || id === blankId) && !draft.proposalDigest && !draft.values.workflow && !known.has(id) && capture.dates.includes(draft.date)) {
      entries.set(id, row(id, { timekeeper: self, ...draft.values, startedAt: draft.values.startedAt ?? draft.date }));
    }
  }
  for (const [id, draft] of edits.drafts) {
    if ((!person || (draft.record.values.timekeeper ?? self) === person || id === blankId) && !draft.proposal && !known.has(id) && capture.dates.includes(draft.date)) entries.set(id, draft.record);
  }
  for (const proposal of proposals) {
    const draft = edits.drafts.get(proposal.key);
    const savedDraft = capture.drafts[proposal.key];
    const suggested = capture.wording?.[proposal.digest];
    const candidate = draft?.proposal?.digest === proposal.digest ? draft.record : row(proposal.key, {
      ...proposalValues(suggested ? { ...proposal, ...suggested } : proposal, state), timekeeper: self, ...(savedDraft?.proposalDigest === proposal.digest ? savedDraft.values : {}),
    });
    candidateOrigins.current.set(candidate, proposal);
    entries.set(proposal.key, candidate);
  }
  const blank = row(blankId, { name: "", billingNarrative: "", status: "Draft", timekeeper: person || self, recordedMinutes: null, billableMinutes: null, startedAt: capture.date, serviceDate: capture.date });
  const showBlank = composerId === blankId || entries.has(blankId);
  const blankRow = entries.get(blankId) ?? blank;
  entries.delete(blankId);
  for (const id of entries.keys()) if (!order.current.has(id)) order.current.set(id, order.current.size);
  const rows = [...entries.values()].filter(record => !createdIds.has(record.id)).sort((a, b) => (order.current.get(a.id) ?? 0) - (order.current.get(b.id) ?? 0));
  const choices = members.map(member => ({ ...row(memberPrefix + member.userId, { name: member.userId === directory.permissions.userId ? t("timesheets.ledger.me") : member.name || member.email || member.userId }), objectId: "@time-member" }));
  const records = [...directory.records.filter(record => record.objectId !== "timeEntries"), ...choices, ...rows, ...(showBlank ? [blankRow] : [])];
  const openRecord = (record: BackOfficeRecord) => { if (!record.objectId.startsWith("@")) navigate("/back-office/" + record.objectId + "?record=" + record.id); };

  function enqueue(id: string, task: () => Promise<void>) {
    const next = (edits.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(task);
    edits.queues.set(id, next);
    void next.catch(error => {
      edits.draftErrors.set(id, errorMessage(error));
      edits.changed();
    }).finally(() => {
      if (edits.queues.get(id) === next) edits.queues.delete(id);
      edits.prune();
    });
  }
  const availableClients = new Set(directory.records.filter(record => record.objectId === "clients" && !record.archivedAt).map(record => record.id));
  function billingClients(matterId: BackOfficeValue | undefined) {
    return state.matters.find(matter => matter.id === matterId)?.clientIds.filter(id => availableClients.has(id)) ?? [];
  }
  function billingError(values: TimeRecordValues) {
    if (typeof values.billableMinutes !== "number" || values.billableMinutes <= 0) return undefined;
    if (!values.matter) return "timesheets.ledger.choose_matter";
    const eligible = billingClients(values.matter);
    if (eligible.some(id => id === values.client)) return undefined;
    return eligible.length ? "timesheets.sheet.choose_bill_to" : "timesheets.sheet.no_bill_to";
  }
  function valid(draft: TimeRowDraft) {
    const values = draft.record.values;
    return Boolean(String(values.name ?? "").trim() && values.matter && values.timekeeper && !billingError(values) &&
      typeof values.recordedMinutes === "number" && (values.recordedMinutes > 0 ||
      (values.recordedMinutes === 0 && values.billableMinutes === 0 && proposalMap.get(draft.record.id)?.source === "stopwatch")) &&
      typeof values.billableMinutes === "number" && values.billableMinutes >= 0 && serviceDate(values));
  }
  async function privateDraft(draft: TimeRowDraft) {
    if (draft.privateSaved || !currentCapture.current.privateAvailable) return;
    const key = draft.record.id;
    if (!await currentCapture.current.act({ type: "draft", key, date: draft.date, values: draft.record.values,
      ...(draft.proposal ? { proposalDigest: draft.proposal.digest } : {}) })) throw new Error(t("back_office.save_failed"));
    if (edits.drafts.get(key) === draft) {
      draft.privateSaved = true;
      edits.draftErrors.delete(key);
      edits.changed();
    }
  }
  function timeRecordBody(values: TimeRecordValues) {
    const fields = allowedValues(values);
    const member = fields.timekeeper;
    if (typeof member === "string" && member.startsWith(memberPrefix)) {
      delete fields.timekeeper;
      return { values: fields, timekeeperUserId: member.slice(memberPrefix.length) };
    }
    return { values: fields };
  }
  function allowedValues(values: TimeRecordValues) {
    return Object.fromEntries(Object.entries(values).filter(([id]) => fieldIds.has(id)));
  }
  function rememberMember(input: TimeRecordValues, saved: BackOfficeRecord) {
    const chosen = input.timekeeper, contact = saved.values.timekeeper;
    if (typeof chosen === "string" && chosen.startsWith(memberPrefix) && typeof contact === "string") edits.memberContacts.set(chosen, contact);
  }
  async function acknowledge(saved: BackOfficeRecord) {
    edits.confirmed.set(saved.id, saved);
    edits.changed();
    await applySavedRecord(cache, client.baseUrl, directory, saved);
  }
  function prepareBillingEdit(queue: TimeRecordEdit[], current: BackOfficeRecord) {
    const first = queue[0];
    if (!changesBilling(first.values) || !billingError({ ...current.values, ...first.values })) return true;
    // Wait for related input while retaining each field’s original editing base.
    const values = { ...first.values }, expected = { ...first.base.values };
    const related: number[] = [];
    for (let index = 1; index < queue.length; index++) {
      const later = queue[index];
      if (!changesBilling(later.values)) continue;
      for (const key of Object.keys(later.values)) {
        if (!Object.hasOwn(values, key)) expected[key] = later.base.values[key] ?? null;
      }
      Object.assign(values, later.values);
      related.push(index);
      if (billingError({ ...current.values, ...values })) continue;
      first.values = values;
      first.base = { ...first.base, values: expected };
      for (const consumed of related.reverse()) queue.splice(consumed, 1);
      return true;
    }
    return false;
  }
  async function flushUpdates(id: string) {
    const queue = edits.updates.get(id);
    if (!queue) return;
    while (queue[0] && !queue[0].error && !queue[0].conflict) {
      const edit = queue[0];
      const known = currentRecords.current.get(id);
      const confirmed = edits.confirmed.get(id);
      const current = confirmed && confirmed.revision > (known?.revision ?? 0) ? confirmed : known ?? edit.base;
      if (!prepareBillingEdit(queue, current)) return;
      const expectedValues = Object.fromEntries(Object.keys(allowedValues(edit.values)).map(key => [key, edit.base.values[key] ?? null]));
      const expectedMember = expectedValues.timekeeper;
      if (typeof expectedMember === "string" && expectedMember.startsWith(memberPrefix)) {
        expectedValues.timekeeper = edits.memberContacts.get(expectedMember) ?? [...contacts].find(([, member]) => member === expectedMember)?.[0] ?? null;
      }
      edits.saving.add(id);
      edits.changed();
      try {
        const saved = responseSchema.parse(await writeBackOfficeRecord(client, directory, {
          id, objectId: "timeEntries", revision: edit.base.revision, ...timeRecordBody(edit.values), expectedValues,
        })).record;
        rememberMember(edit.values, saved);
        queue.shift();
        await acknowledge(saved);
      } catch (error) {
        const conflict = error instanceof LegalworkServerError && error.code === "back_office_field_conflict"
          ? timeRecordConflictSchema.safeParse(error.details) : undefined;
        if (conflict?.success) edit.conflict = conflict.data;
        else edit.error = errorMessage(error);
      } finally {
        if (!queue.length) edits.updates.delete(id);
        edits.saving.delete(id);
        edits.changed();
      }
    }
  }
  function addUpdate(base: BackOfficeRecord, values: TimeRecordValues) {
    if (!Object.keys(values).length) return;
    const id = base.id;
    const queue = edits.updates.get(id) ?? [];
    queue.push({ base, values });
    edits.updates.set(id, queue);
    edits.changed();
    enqueue(id, () => flushUpdates(id));
  }
  function resolveUpdate(id: string, edit: TimeRecordEdit, mine: boolean | null) {
    const queue = edits.updates.get(id);
    if (!queue || queue[0] !== edit) return;
    if (edit.conflict) {
      const { record, fields } = edit.conflict;
      if (!mine) {
        const collisions = conflictingTimeFields(edit.values, fields);
        edit.values = Object.fromEntries(Object.entries(edit.values).filter(([key]) => !collisions.has(key)));
      }
      edit.base = record;
      edit.conflict = undefined;
      void acknowledge(record);
    } else if (mine === false) edit.values = {};
    edit.error = undefined;
    if (!Object.keys(edit.values).length) queue.shift();
    if (!queue.length) edits.updates.delete(id);
    edits.changed();
    enqueue(id, () => flushUpdates(id));
  }
  async function persistDraft(id: string, accepted?: CaptureProposal) {
    const pending = edits.drafts.get(id);
    if (!pending) return;
    if (pending.proposal) {
      if (!accepted) { await privateDraft(pending); return; }
      const active = currentCapture.current;
      if (pending.proposal.digest !== accepted.digest || !active.proposals.some(proposal => proposal.key === id && proposal.digest === accepted.digest))
        throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
      if (active.overlaps.has(id)) throw new Error(t("timesheets.workday.overlap"));
    } else if (accepted) return;
    if (!valid(pending)) {
      await privateDraft(pending);
      if (accepted) throw new Error(t(billingError(pending.record.values) ?? "timesheets.sheet.complete"));
      return;
    }
    edits.saving.add(id);
    edits.changed();
    try {
      const saved = responseSchema.parse(await writeBackOfficeRecord(client, directory, {
        id, objectId: "timeEntries", revision: 0, create: true, ...timeRecordBody(pending.record.values),
        ...(accepted ? { privateProposal: { key: id, digest: accepted.digest, profileId: directory.captureProfileId } } : {}),
      })).record;
      rememberMember(pending.record.values, saved);
      const later = edits.drafts.get(id);
      edits.drafts.delete(id);
      edits.draftErrors.delete(id);
      if (accepted) hideProposals(previous => new Set(previous).add(id));
      const worker = fieldValue(pending.record, "timekeeper");
      showBooking({ id: saved.id, date: serviceDate(saved.values), worker: typeof worker === "string" ? worker : undefined,
        description: String(saved.values.billingNarrative ?? saved.values.name) });
      await acknowledge(saved);
      if (later && later !== pending && !pending.proposal) addUpdate(saved, differentTimeValues(pending.record.values, later.record.values));
      if (!accepted && currentCapture.current.privateAvailable) await currentCapture.current.act({ type: "draft", key: id, date: pending.date, values: null });
    } finally {
      edits.saving.delete(id);
      edits.changed();
    }
  }
  async function edit(record: BackOfficeRecord, patch: TimeRecordValues) {
    const id = record.id;
    const values = timeCellChanges(record.values, patch, capture.date, fieldValue(record, "timekeeper"), matterId => {
      const matter = state.matters.find(matter => matter.id === matterId);
      return matter?.clientIds.length === 1 ? matter.clientIds[0] : null;
    });
    const proposal = proposalMap.get(id);
    const priorDraft = edits.drafts.get(id);
    const previousSource = candidateOrigins.current.get(record);
    if (previousSource && proposal && previousSource.digest !== proposal.digest) throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
    const origin = previousSource ?? proposal ?? priorDraft?.proposal;
    const matchingDraft = priorDraft?.proposal?.digest === origin?.digest ? priorDraft : undefined;
    const saved = record.revision ? record : edits.confirmed.get(id) ?? currentRecords.current.get(id);
    // A candidate identified by the private cache cannot become an ordinary row.
    if (!record.revision && ((origin && (saved || hiddenProposals.has(id) || edits.saving.has(id))) || (!origin && capture.drafts[id]?.proposalDigest))) return;
    if (saved) { addUpdate(saved, values); return; }
    if ((origin || (id === blankId && !matchingDraft)) && !Object.keys(values).length) return;
    const latest = matchingDraft?.record ?? record;
    const next = { ...latest, values: { ...latest.values, ...values } };
    const draft = { record: next, date: origin?.date ?? matchingDraft?.date ?? capture.drafts[id]?.date ?? capture.date, proposal: origin };
    edits.drafts.set(id, draft);
    if (id === blankId && valid(draft)) blankIds.current.delete(capture.date);
    edits.changed();
    enqueue(id, () => persistDraft(id));
  }
  function duplicate(input: TimeRecordValues) {
    if (person && person !== self) setPerson(self);
    const values = copyTimeRecordValues(input, object.fields, capture.date, self, directory.permissions.finance);
    const id = crypto.randomUUID();
    const draft = { record: row(id, values), date: capture.date };
    edits.drafts.set(id, draft);
    edits.changed();
    enqueue(id, () => privateDraft(draft));
  }
  function discardDraft(id: string) {
    enqueue(id, async () => {
      const local = edits.drafts.get(id);
      const current = currentCapture.current;
      const storedDraft = current.drafts[id];
      if ((local?.privateSaved || storedDraft) && !await current.act({ type: "draft", key: id, date: local?.date ?? storedDraft.date, values: null }))
        throw new Error(t("back_office.save_failed"));
      edits.drafts.delete(id);
      edits.draftErrors.delete(id);
      if (id === blankId) blankIds.current.delete(capture.date);
      edits.changed();
    });
  }
  function accept(record: BackOfficeRecord, proposal: CaptureProposal) {
    if (!edits.drafts.has(record.id) || edits.drafts.get(record.id)?.proposal?.digest !== proposal.digest)
      edits.drafts.set(record.id, { record, date: proposal.date, proposal });
    enqueue(record.id, () => persistDraft(record.id, proposal));
  }
  function finishProposal(proposal: CaptureProposal, action: CaptureAction) {
    enqueue(proposal.key, async () => {
      const active = currentCapture.current;
      if (!active.proposals.some(item => item.key === proposal.key && item.digest === proposal.digest))
        throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
      edits.saving.add(proposal.key);
      edits.changed();
      try {
        if (action.type === "reconcile") {
          const draft = edits.drafts.get(proposal.key);
          if (draft?.proposal?.digest === proposal.digest) await privateDraft(draft);
        }
        if (!await active.act(action)) return;
        edits.drafts.delete(proposal.key);
        edits.draftErrors.delete(proposal.key);
        hideProposals(previous => new Set(previous).add(proposal.key));
      } finally {
        edits.saving.delete(proposal.key);
        edits.changed();
      }
    });
  }

  const { totals: sums, byDate } = periodTimeTotals(visible.map(record => ({
    date: serviceDate(record.values),
    workedMinutes: Number(record.values.recordedMinutes || 0),
    billableMinutes: Number(record.values.billableMinutes || 0),
  })));
  const unsaved = edits.updates.size > 0 || [...edits.drafts.values()].some(draft => !draft.proposal && !known.has(draft.record.id)) ||
    Object.entries(capture.drafts).some(([id, draft]) => !draft.proposalDigest && !draft.values.workflow && !known.has(id));
  return <div ref={grid} className="time-record-sheet" onCopy={event => {
    if (!copied.current || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || window.getSelection()?.toString()) return;
    event.clipboardData.setData("text/plain", JSON.stringify({ legalworkTimeRow: 1, values: copyTimeRecordValues(copied.current, object.fields, capture.date, self, directory.permissions.finance) }));
    event.preventDefault();
  }} onPaste={event => {
    if (!directory.permissions.edit || !roster.data) return;
    try {
      const value = timeRowClipboardSchema.safeParse(JSON.parse(event.clipboardData.getData("text/plain")));
      if (value.success) { event.preventDefault(); duplicate(value.data.values); }
    } catch { /* Ordinary text remains available to the focused editor. */ }
  }}>
    <TimesheetWeekTotals dates={capture.dates} date={capture.date} totalsByDate={byDate} onDateChange={day => capture.selectDate(day, true)} />
    <div className="time-sheet-summary">
      {members.length > 1 ? <select aria-label={t("timesheets.ledger.workers")} value={person} onChange={event => { setPerson(event.target.value); setComposerId(undefined); }}>
        <option value="">{t("timesheets.sheet.all_people")}</option>
        {choices.map(member => <option key={member.id} value={member.id}>{String(member.values.name)}</option>)}
      </select> : <span title={t("timesheets.self_only")}>{t("timesheets.ledger.me")}</span>}
      <span>{t("timesheets.sheet.worked", { minutes: sums.worked })}</span><span>{t("timesheets.sheet.charge", { minutes: sums.charge })}</span>
      <span className="time-sheet-sync" role="status" title={t(unsaved ? "timesheets.sheet.edit_unsaved_hint" : directory.scope === "local" ? "timesheets.sheet.local" : "timesheets.sheet.sharing")}><Info size={12} />{edits.saving.size ? t("projects.saving") : unsaved ? t("timesheets.sheet.edit_unsaved") : directory.sync.error ? t("timesheets.sheet.sync_error") : directory.sync.pending ? t("timesheets.sheet.pending") : t("timesheets.sheet.synced")}</span>
    </div>
    {roster.error && <p className="bo-error" role="alert">{t("timesheets.sheet.members_error")} <Button size="xs" variant="outline" onClick={() => void roster.refetch()}>{t("timesheets.retry")}</Button></p>}
    <RecordGrid object={object} records={records} views={directory.views} editable={directory.permissions.edit && Boolean(roster.data)} finance={directory.permissions.finance}
      userId={directory.permissions.userId} archived={false} onArchivedChange={() => {}} lockedSchema
      onSave={edit} onCreate={() => {}} onOpen={openRecord}
      onSaveView={async (view, expected) => {
        const saved = z.object({ view: BackOfficeViewSchema }).parse(await client.backOffice("/views", { method: "POST", body: { ...view, expected } })).view;
        void cache.invalidateQueries({ queryKey: ["back-office", client.baseUrl] }); return saved;
      }}
      readOnlyFields={members.length <= 1 ? ["timekeeper"] : undefined}
      sheet={{ columns: columnIds, blankId, fieldValue, appendedRowCount: bookings.length,
        afterRows: render => <>
          {directory.permissions.edit && roster.data && !showBlank &&
            <Button size="sm" variant="ghost" className="time-new-entry" onClick={() => setComposerId(blankId)}><Plus size={14} />{t("timesheets.ledger.new")}</Button>}
          {receipt((item, index) => {
            const record = entries.get(item.id) ?? known.get(item.id);
            return record && render(record, index);
          }, item => {
            const record = entries.get(item.id) ?? known.get(item.id);
            return record ? serviceDate(record.values) : item.date;
          })}
        </>,
        allowedRelationIds: (record, field) => field === "client" ? billingClients(record.values.matter) : undefined, widths: { startedAt: 130, timekeeper: 140, matter: 200, client: 170, billingNarrative: 340, recordedMinutes: 120, billableMinutes: 120 },
        onFocus: record => { copied.current = record.revision > 0 ? record.values : undefined; },
        trailing: record => record.revision > 0 ? <>
          {directory.permissions.edit && <button type="button" title={t("timesheets.ledger.duplicate")} aria-label={t("timesheets.ledger.duplicate")}
            onClick={() => duplicate(record.values)}><CopyPlus size={13} /></button>}
          <button title={t("timesheets.ledger.history")} aria-label={t("timesheets.ledger.history")} onClick={() => openRecord(record)}><History size={13} /></button>
        </> : null,
        leading: record => {
          if (!directory.permissions.edit || !roster.data) return null;
          const proposal = proposalMap.get(record.id);
          if (proposal) {
            const blocked = capture.overlaps.has(record.id);
            return <div className="time-proposal-actions">
              <button aria-label={t("timesheets.sheet.decline")} title={t("timesheets.sheet.decline")} disabled={edits.saving.has(record.id)} onClick={() => finishProposal(proposal, { type: "dismiss", key: record.id })}><X size={14} /></button>
              <button aria-label={t("timesheets.sheet.accept")} title={t(blocked ? "timesheets.workday.overlap" : "timesheets.sheet.accept")} disabled={blocked || edits.saving.has(record.id)} onClick={() => accept(record, proposal)}><Check size={14} /></button>
            </div>;
          }
          return record.id === blankId ? <button aria-label={t("back_office.add_new")} onClick={event => event.currentTarget.closest("[role=row]")?.querySelector<HTMLElement>("[role=gridcell]")?.click()}><Plus size={14} /></button> : undefined;
        },
        details: (record, columns) => {
          const proposal = proposalMap.get(record.id), error = edits.draftErrors.get(record.id), change = edits.updates.get(record.id)?.[0];
          const draft = !proposal && record.revision === 0 && (edits.drafts.has(record.id) || Boolean(capture.drafts[record.id]));
          const clientError = billingError(record.values);
          const eligibleClients = !columns.includes("client") && directory.permissions.edit && roster.data &&
            Number(record.values.billableMinutes) > 0 ? billingClients(record.values.matter) : [];
          const chooseClient = eligibleClients.length > 1 || (eligibleClients.length === 1 && Boolean(clientError));
          if (!proposal && !draft && !chooseClient && !clientError && !error && !change?.error && !change?.conflict) return null;
          const matches = proposal && fieldValue(record, "timekeeper") === self && record.values.matter ? stored.filter(entry => isOwn(entry) &&
            serviceDate(entry.values) === serviceDate(record.values) && entry.values.matter === record.values.matter) : [];
          return <div className="time-proposal-details">
            {proposal && <><button className="time-proposal-source" onClick={() => setSource(source === record.id ? undefined : record.id)}>{proposal.source === "stopwatch" ? <Timer size={13} /> : <Sparkles size={13} />}{proposal.source === "stopwatch" ? t(sourceKeys.stopwatch) : t("timesheets.sheet.because", { source: t(sourceKeys[proposal.source]) })}{proposal.source === "documents" && " · " + proposal.activity}{proposal.workedMinutes !== null && " · " + proposal.workedMinutes + " min"}{proposal.projectId && " · " + (state.projects.find(project => project.id === proposal.projectId)?.name ?? "")}</button>
              {capture.overlaps.has(record.id) && <span className="bo-error">{t("timesheets.workday.overlap")} <Button size="xs" variant="ghost" onClick={() => capture.openSource(proposal)}>{t("timesheets.workday.correct")}</Button></span>}
              {directory.permissions.edit && matches.length > 0 && <select aria-label={t("timesheets.sheet.reconcile")} value="" disabled={edits.saving.has(record.id)} onChange={event => {
                const match = matches.find(entry => entry.id === event.target.value);
                if (match) finishProposal(proposal, { type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: match.id, recordRevision: match.revision });
              }}><option value="">{t("timesheets.sheet.reconcile")}</option>{matches.map(match => <option key={match.id} value={match.id}>{String(match.values.billingNarrative || match.values.name)} · {String(match.values.recordedMinutes)} min</option>)}</select>}
              {source === record.id && <div className="time-proposal-evidence"><p>{proposal.startAt && proposal.endAt ? new Date(proposal.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "–" + new Date(proposal.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("timesheets.sheet.no_duration")}</p><p>{proposal.narrative}</p><Button size="xs" variant="ghost" onClick={() => capture.openSource(proposal)}>{t("timesheets.workday.correct")}</Button></div>}</>}
            {chooseClient && <label>{t("timesheets.sheet.bill_to")} <select
              value={typeof record.values.client === "string" ? record.values.client : ""}
              onChange={event => { void edit(record, { client: event.currentTarget.value || null }).catch(error => {
                edits.draftErrors.set(record.id, errorMessage(error));
                edits.changed();
              }); }}>
              <option value="">{t("timesheets.sheet.choose_bill_to")}</option>
              {eligibleClients.map(id => <option key={id} value={id}>{state.clients.find(client => client.id === id)?.name ?? id}</option>)}
            </select></label>}
            {clientError && !chooseClient && <small>{t(clientError)}</small>}
            {clientError && change && !change.error && !change.conflict && changesBilling(change.values) && <button
              disabled={edits.saving.has(record.id)} onClick={() => resolveUpdate(record.id, change, false)}>{t("timesheets.sheet.edit_discard")}</button>}
            {draft && record.id !== blankId && <small>{t("timesheets.sheet.private_draft")}</small>}
            {draft && <button disabled={edits.saving.has(record.id)} onClick={() => discardDraft(record.id)}>{t("timesheets.sheet.edit_discard")}</button>}
            {error && <span role="alert" className="bo-error">{error} {!proposal && <button onClick={() => enqueue(record.id, () => persistDraft(record.id))}>{t("timesheets.retry")}</button>}</span>}
            {change?.error && <span role="alert" className="bo-error">{change.error} <button onClick={() => resolveUpdate(record.id, change, null)}>{t("timesheets.retry")}</button> <button onClick={() => resolveUpdate(record.id, change, false)}>{t("timesheets.sheet.edit_discard")}</button></span>}
            {change?.conflict && <div className="time-proposal-evidence" role="alert"><strong>{t("back_office.conflict.title")}</strong>
              {[...conflictingTimeFields(change.values, change.conflict.fields)].map(id => {
                const field = object.fields.find(field => field.id === id);
                if (!field || !change.conflict) return null;
                const show = (value: BackOfficeValue | undefined) => value == null || value === "" ? "∅" : <ValueDisplay field={field} value={value} records={records} onOpen={openRecord} />;
                const saved = fieldValue(change.conflict.record, id);
                const mine = fieldValue({ ...record, values: change.values }, id);
                return <div key={id}><strong>{field.label}</strong><dl><dt>{t("back_office.conflict.saved")}</dt><dd>{show(saved)}</dd><dt>{t("back_office.conflict.yours")}</dt><dd>{show(mine)}</dd></dl></div>;
              })}
              <Button size="xs" variant="outline" onClick={() => resolveUpdate(record.id, change, false)}>{t("back_office.conflict.keep")}</Button>
              <Button size="xs" variant="outline" onClick={() => resolveUpdate(record.id, change, true)}>{t("back_office.conflict.apply")}</Button>
            </div>}
          </div>;
        },
      }} />
  </div>;
}
