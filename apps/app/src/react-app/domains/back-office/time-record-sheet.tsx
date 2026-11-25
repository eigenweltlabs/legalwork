import { TimeEntryInput, useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration } from "./time-duration";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Info, CopyPlus, History, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProposalDecisionReceiver, TimeProposalActions } from "./time-proposal-actions";
import { z, BackOfficeFieldSchema, BackOfficeRecordSchema, type BackOfficeRecord, type BackOfficeValue } from "@legalwork/types/back-office";
import { draftRules, effectiveWorkdayGuidelines, workdayBillableMinutes } from "@legalwork/types/time-capture";
import type { CaptureAction, CaptureProposal, CaptureState, PrivateBookingRevision, PrivateDraftPatch } from "@legalwork/types/time-capture";
import { assignedTimeReviewer, proposedCharge, resolveTimePolicy, soleMatterClient, timeActivities, timePolicyError, TimeDraftSchema, type TimeDraft, type TimeEntry, type TimesheetCommand, type TimesheetState } from "@legalwork/types/timesheet";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { applySavedRecord, loadBackOfficeState, writeBackOfficeRecord, type BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { TimeHeaderContent, TimekeeperControlTarget } from "./time-workspace-header";
import { TimeRecordPicker, TimeSelect } from "./time-settings-controls";
import { RecordHistorySidebar } from "./history-panel";
import { RecordGrid, type SaveBackOfficeView } from "./record-grid";
import { ValueDisplay } from "./record-values";
import type { RenderTimeWorkspace } from "./timesheet-workday";
import { localRecordInstant, proposalAssignment, proposalValues, timeRecordDate } from "./time-record-values";
import { conflictingTimeFields, copyTimeRecordValues, differentTimeValues, privateDraftConflict, timeCellChanges, timeRecordConflictSchema, timeRecordEdits, timeRowClipboardSchema, type TimeRecordEdit, type TimeRecordValues, type TimeRowDraft } from "./time-record-edits";
import { useBookingReceipt } from "./time-booking-receipt";
import { periodTimeTotals } from "./timesheet-row";
import { TimesheetWeekTotals } from "./timesheet-week-totals";
import { Link, useNavigate } from "react-router-dom";

const memberPrefix = "member:";
const memberSource = (id: string) => "eigenwelt-member:" + id;
const membersSchema = z.object({ members: z.array(z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable(), canRecordTimeFor: z.boolean().optional() })) });
const responseSchema = z.object({ record: BackOfficeRecordSchema });
const columnIds = ["startedAt", "timekeeper", "matter", "billingNarrative", "recordedMinutes", "billableMinutes", "status"];
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const serviceDate = (values: TimeRecordValues) => timeRecordDate(values.startedAt, values.serviceDate);

export type TimeCaptureSheet = {
  proposals: CaptureProposal[];
  wording?: CaptureState["wording"];
  guidelines?: CaptureState["guidelines"];
  drafts: CaptureState["drafts"];
  date: string;
  dates: string[];
  selectDate: (date: string, openDay?: boolean) => void;
  linkableRecords?: readonly BackOfficeRecord[];
  privateAvailable: boolean;
  act: (action: CaptureAction) => Promise<boolean>;
  writeDraft?: (action: PrivateDraftPatch) => Promise<CaptureState["drafts"][string] | null>;
  openSource: (proposal: CaptureProposal, draftRevision?: number) => void;
  visible?: boolean;
};

type Props = { onSaveView: SaveBackOfficeView; client: LegalworkServerClient; directory: BackOfficeState; state: TimesheetState; capture: TimeCaptureSheet; workspace: RenderTimeWorkspace;
  firmCommand?: (command: TimesheetCommand, draft?: PrivateBookingRevision) => Promise<TimesheetState>;
  submit?: (ids: readonly string[]) => Promise<void>;
  reviewLink?: string;
};

function RecordProposalField({ record, revision, field, disabled, errorId, onCommit }: {
  errorId?: string;
  record: BackOfficeRecord;
  revision: number;
  field: "billingNarrative" | "recordedMinutes" | "billableMinutes";
  disabled: boolean;
  onCommit: (patch: TimeRecordValues, base: BackOfficeRecord, baseRevision: number) => void;
}) {
  const saved = String(record.values[field] ?? "");
  const [typed, setTyped] = useState<string>();
  const base = useRef<{ record: BackOfficeRecord; revision: number; value: string }>(undefined);
  function change(value: string) {
    base.current ??= { record, revision, value: saved };
    setTyped(value);
  }
  function commit(value: string) {
    const original = base.current ?? { record, revision, value: saved };
    base.current = undefined;
    setTyped(undefined);
    if (value !== original.value) {
      const next = field === "billingNarrative" ? value : value === "" ? null : Number(value);
      onCommit({ [field]: next }, original.record, original.revision);
    }
  }
  return field === "billingNarrative"
    ? <Textarea aria-invalid={errorId ? true : undefined} aria-describedby={errorId} value={typed ?? saved} maxLength={2000} rows={3} disabled={disabled}
        onChange={event => change(event.currentTarget.value)} onBlur={event => commit(event.currentTarget.value)} />
    : <TimeEntryInput aria-invalid={errorId ? true : undefined} aria-describedby={errorId} data-field={field} value={typed ?? saved} disabled={disabled}
        onValueChange={change} onBlur={() => commit(typed ?? saved)} />;
}

export function TimeRecordSheet(props: Props) {
  const { client, directory } = props;
  const scope = JSON.stringify([client.baseUrl, directory.scope, directory.directoryId, directory.permissions.userId, directory.permissions.principalKey, directory.captureProfileId]);
  return <TimeRecordSheetGrid key={scope} scope={scope} {...props} edits={timeRecordEdits(scope)} />;
}

function TimeRecordSheetGrid({ client, directory, state, capture, workspace, onSaveView, edits, scope, firmCommand, submit, reviewLink }: Props & { scope: string; edits: ReturnType<typeof timeRecordEdits> }) {
  const cache = useQueryClient();
  const durationFormat = useTimeDurationFormat();
  const navigate = useNavigate();
  useSyncExternalStore(edits.subscribe, edits.snapshot, () => 0);
  const [validationAttempts, setValidationAttempts] = useState<Set<string>>(() => new Set());
  const userId = directory.permissions.userId;
  const latestState = useRef(state);
  latestState.current = state;
  const [submitting, setSubmitting] = useState(false);
  const [submitNotice, setSubmitNotice] = useState<{ message: string; error?: boolean }>();
  const roster = useQuery({ queryKey: ["back-office", client.baseUrl, "time-members", directory.scope, directory.directoryId, userId, directory.permissions.principalKey],
    queryFn: async () => membersSchema.parse(await client.backOffice("/time-members")), retry: false, refetchInterval: 60000 });
  const [archived, setArchived] = useState(false);
  const archiveKey = ["back-office", client.baseUrl, "time-entry-archive", scope, directory.permissions.replicaId, directory.permissions.finance, directory.permissions.model];
  const archiveQuery = useQuery({
    queryKey: archiveKey,
    enabled: archived,
    queryFn: ({ signal }) => loadBackOfficeState(client, cache.getQueryData<BackOfficeState>(archiveKey), signal, "timeEntries"),
  });
  const self = memberPrefix + userId;
  const members = [
    { userId, name: null, email: null },
    ...(!firmCommand && roster.isSuccess ? roster.data.members.filter(member => member.userId !== userId && member.canRecordTimeFor === true) : []),
  ];
  const editable = directory.permissions.edit && Boolean(userId);
  const [hiddenProposals, hideProposals] = useState<Set<string>>(new Set());
  const [filter, setPerson] = useState(self);
  const person = members.length > 1 && (!filter || members.some(member => memberPrefix + member.userId === filter)) ? filter : self;
  const [composerId, setComposerId] = useState<string>();
  const grid = useRef<HTMLDivElement>(null);
  const [historyId, setHistoryId] = useState<string>();
  useEffect(() => setComposerId(undefined), [capture.date]);
  const { showBooking, bookings, receipt } = useBookingReceipt(capture.date, (target, worker) => {
    if (person && person !== worker) setPerson("");
    capture.selectDate(target, true);
  }, capture.visible);
  const copied = useRef<TimeRecordValues>(undefined);
  const blankIds = useRef(new Map<string, string>());
  const order = useRef(new Map<string, number>());
  const candidateOrigins = useRef(new WeakMap<BackOfficeRecord, CaptureProposal>());
  const currentCapture = useRef(capture);
  const currentRecords = useRef(new Map<string, BackOfficeRecord>());
  const currentAccess = useRef<{ editable: boolean; rosterIds: Set<string>; contacts: Map<string, string> }>(undefined);
  currentCapture.current = capture;
  const blankKey = JSON.stringify([capture.date, person]);
  const blankId = blankIds.current.get(blankKey) ?? crypto.randomUUID();
  blankIds.current.set(blankKey, blankId);
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
  const extraFields = firmCommand ? [
    BackOfficeFieldSchema.parse({ id: "activity", label: t("timesheets.ledger.activity"), type: "relation", target: "timeActivityChoices" }),
    BackOfficeFieldSchema.parse({ id: "project", label: t("back_office.billing.scope_project"), type: "relation", target: "timeProjectChoices" }),
  ] : [];
  const object = { ...labeled, fields: [...labeled.fields.filter(field => field.id !== "serviceDate" && !extraFields.some(extra => extra.id === field.id)).map(field => {
    if (field.id === "timekeeper") return { ...field, target: "@time-member" };
    if (field.id === "client") return { ...field, label: t("timesheets.sheet.bill_to") };
    if (field.id === "startedAt") return { ...field, type: "date" as const, label: t("timesheets.ledger.date") };
    return field;
  }), ...extraFields] } satisfies typeof raw;
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
  function workflowRecord(entry: TimeEntry, original = row(entry.id, {})): BackOfficeRecord {
    return {
      ...original, revision: entry.revision, ownerId: entry.workerId,
      values: { ...original.values, name: entry.narrative.slice(0, 240), billingNarrative: entry.narrative,
        matter: entry.matterId, client: entry.clientId || null, project: entry.projectId ?? null, activity: entry.activity,
        serviceDate: entry.date, startedAt: entry.startAt ?? entry.date, endedAt: entry.endAt ?? null,
        recordedMinutes: entry.workedMinutes, billableMinutes: entry.billableMinutes,
        status: entry.status === "invoiced" ? "Invoiced" : entry.status === "approved" ? "Approved" : entry.status === "submitted" ? "Submitted" : "Draft" },
    };
  }
  function workflowDraft(values: TimeRecordValues, existing?: TimeEntry): TimeDraft {
    const date = serviceDate(values);
    const matter = latestState.current.matters.find(item => item.id === values.matter);
    const clientId = typeof values.client === "string" ? values.client : soleMatterClient(matter, latestState.current.clients);
    const projectId = typeof values.project === "string" ? values.project : undefined;
    const activity = String(values.activity || existing?.activity || "Other");
    const minimum = matter ? draftRules(latestState.current, currentCapture.current.guidelines ?? [], matter, date, projectId, clientId).minimumMinutes : 0;
    const startAt = typeof values.startedAt === "string" && values.startedAt.includes("T") ? values.startedAt : undefined;
    const entry = TimeDraftSchema.parse({
      date, matterId: values.matter, clientId, projectId, activity, startAt,
      endAt: startAt && typeof values.endedAt === "string" ? values.endedAt : undefined,
      narrative: values.billingNarrative || values.name, workedMinutes: values.recordedMinutes,
      billable: Number(values.billableMinutes) > 0, billableMinutes: values.billableMinutes,
      minimumBillableMinutes: Math.max(minimum, existing?.minimumBillableMinutes ?? 0) || undefined,
    });
    const policy = resolveTimePolicy(latestState.current.policies, clientId, entry.matterId, date, projectId);
    const error = timePolicyError(entry, policy);
    if (error) throw new Error(error);
    return entry;
  }
  async function createWorkflowEntry(requestId: string, entry: TimeDraft, proposal?: CaptureProposal, privateRevision?: number) {
    if (!firmCommand) throw new Error(t("timesheets.unavailable"));
    const next = await firmCommand({ type: "create", requestId, entry,
      ...(proposal ? { source: "suggestion", proposalDigest: proposal.digest } : {}) },
      privateRevision === undefined ? undefined : { date: entry.date, revision: privateRevision });
    const saved = next.entries.find(item => item.groupId === requestId && item.workerId === userId);
    if (!saved) throw new Error(t("back_office.save_failed"));
    return workflowRecord(saved);
  }
  function fieldValue(record: BackOfficeRecord, id: string) {
    const value = record.values[id];
    if (id === "startedAt") return serviceDate(record.values);
    if (id === "status" && firmCommand && record.revision > 0 && value === "Draft") {
      const entry = state.entries.find(item => item.id === record.id);
      if (entry?.status === "confirmed" && !entry.legacy) {
        const policy = resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId);
        if (assignedTimeReviewer(policy, entry.workerId)) return t("invoiceReview.ready_to_submit");
        if (entry.billable) return t("invoiceReview.no_review_needed");
        return t("timesheets.ledger.status.confirmed");
      }
    }
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
  function matchesPerson(record: BackOfficeRecord) {
    return person ? fieldValue(record, "timekeeper") === person || (person === self && isOwn(record))
      : isOwn(record) || rosterIds.has(String(fieldValue(record, "timekeeper")));
  }
  const known = new Map(directory.records.filter(record => record.objectId === "timeEntries").map(record => [record.id, record]));
  const archivedDirectory = archived && !archiveQuery.isError ? archiveQuery.data : undefined;
  if (archivedDirectory?.directoryId === directory.directoryId && archivedDirectory?.permissions.userId === userId &&
    archivedDirectory.permissions.principalKey === directory.permissions.principalKey) {
    for (const record of archivedDirectory.records) {
      if (record.objectId === "timeEntries" && record.revision > (known.get(record.id)?.revision ?? -1)) known.set(record.id, record);
    }
  }
  for (const [id, saved] of edits.confirmed) {
    if ((known.get(id)?.revision ?? -1) < saved.revision) known.set(id, saved);
  }
  if (firmCommand) for (const entry of state.entries) {
    if (entry.legacy || entry.workerId !== userId || entry.status === "declined") continue;
    const previous = known.get(entry.id);
    if (!previous || previous.revision <= entry.revision) known.set(entry.id, workflowRecord(entry, previous));
  }
  currentRecords.current = known;
  const stored = [...known.values()].filter(record => Boolean(record.archivedAt) === archived);
  const visible = stored.filter(record => capture.dates.includes(serviceDate(record.values)) && matchesPerson(record));
  const receiptBookings = archived ? [] : bookings.filter(item => {
    const record = known.get(item.id);
    return record && !record.archivedAt && matchesPerson(record) && !capture.dates.includes(serviceDate(record.values));
  });
  currentAccess.current = { editable, rosterIds, contacts };
  const selectedPeriodIds = new Set(visible.map(record => record.id));
  const ready = state.entries.filter(entry => selectedPeriodIds.has(entry.id) && entry.workerId === userId &&
    entry.status === "confirmed" && assignedTimeReviewer(
      resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId), entry.workerId));
  const needsReview = state.policies.some(policy => assignedTimeReviewer(policy, userId));

  async function submitPeriod() {
    if (!submit) return;
    setSubmitting(true);
    setSubmitNotice(undefined);
    try {
      await submit(ready.map(record => record.id));
      setSubmitNotice({ message: t("timesheets.ledger.submitted") });
    } catch (error) {
      setSubmitNotice({ message: errorMessage(error), error: true });
    } finally {
      setSubmitting(false);
    }
  }
  function canWrite(record: BackOfficeRecord, patch: TimeRecordValues = {}) {
    const access = currentAccess.current;
    if (!access?.editable) return false;
    const workflow = firmCommand && latestState.current.entries.find(entry => entry.id === record.id);
    if (workflow) return workflow.workerId === userId && ["confirmed", "submitted"].includes(workflow.status) &&
      !("status" in patch) && !("timekeeper" in patch);
    const permitted = (value: BackOfficeValue | undefined) =>
      typeof value === "string" && access.rosterIds.has(access.contacts.get(value) ?? value);
    const assigned = record.values.timekeeper;
    if (directory.scope !== "local" && record.revision > 0 && !isOwn(record)) return false;
    return permitted(assigned || memberPrefix + record.ownerId) &&
      (!patch.timekeeper || permitted(patch.timekeeper));
  }
  const proposals = capture.proposals.filter(proposal => !known.has(proposal.key) && !hiddenProposals.has(proposal.key));
  const proposalMap = new Map(proposals.map(proposal => [proposal.key, proposal]));
  const createdIds = new Set(receiptBookings.map(item => item.id));
  const entries = new Map(visible.map(record => [record.id, record]));
  for (const record of stored) {
    const pending = !archived && edits.updates.get(record.id);
    if (!pending) continue;
    const overlay = { ...record, values: Object.assign({}, record.values, ...pending.filter(edit => canWrite(record, edit.values)).map(edit => edit.values)) };
    if (entries.has(record.id) || createdIds.has(record.id) || (capture.dates.includes(serviceDate(overlay.values)) && matchesPerson(overlay))) entries.set(record.id, overlay);
  }
  for (const [id, draft] of Object.entries(capture.drafts)) {
    if (archived || draft.proposalDigest || draft.values.workflow || known.has(id) || !capture.dates.includes(draft.date)) continue;
    const record = row(id, { timekeeper: self, ...draft.values, startedAt: draft.values.startedAt ?? draft.date });
    if (matchesPerson(record) || (id === blankId && canWrite(record))) entries.set(id, record);
  }
  for (const [id, draft] of edits.drafts) {
    if (!archived && (matchesPerson(draft.record) || (id === blankId && canWrite(draft.record))) && !draft.proposal && !known.has(id) && capture.dates.includes(draft.date)) entries.set(id, draft.record);
  }
  function proposalDefaults(proposal: CaptureProposal) {
    const suggested = currentCapture.current.wording?.[proposal.digest];
    const source = suggested ? { ...proposal, ...suggested } : proposal;
    const values = proposalValues(source, state, capture.guidelines);
    if (!firmCommand) return values;
    const { project } = proposalAssignment(source, state);
    return { ...values, project: project?.id ?? null, activity: source.activity || "Other" };
  }
  function hydrateDraft(draft: TimeRowDraft, values: TimeRecordValues) {
    const proposal = currentCapture.current.proposals.find(item => item.key === draft.proposal?.key && item.digest === draft.proposal.digest);
    return proposal ? { ...proposalDefaults(proposal), ...values, timekeeper: self } : values;
  }
  function proposalRecord(proposal: CaptureProposal) {
    const draft = edits.drafts.get(proposal.key);
    const savedDraft = capture.drafts[proposal.key];
    const candidate = draft?.proposal?.digest === proposal.digest ? draft.record : row(proposal.key, {
      ...proposalDefaults(proposal),
      ...(savedDraft?.proposalDigest === proposal.digest ? savedDraft.values : {}),
      timekeeper: self,
    });
    candidateOrigins.current.set(candidate, proposal);
    return candidate;
  }
  const blank = row(blankId, { name: "", billingNarrative: "", status: "Draft", timekeeper: person || self, recordedMinutes: null, billableMinutes: null, startedAt: capture.date, serviceDate: capture.date });
  const showBlank = !archived && (composerId === blankId || entries.has(blankId));
  const blankRow = entries.get(blankId) ?? blank;
  entries.delete(blankId);
  for (const id of entries.keys()) if (!order.current.has(id)) order.current.set(id, order.current.size);
  const rows = [...entries.values()].filter(record => !createdIds.has(record.id)).sort((a, b) => (order.current.get(a.id) ?? 0) - (order.current.get(b.id) ?? 0));
  const choices = members.map(member => ({ ...row(memberPrefix + member.userId, { name: member.userId === directory.permissions.userId ? t("timesheets.ledger.me") : member.name || member.email || member.userId }), objectId: "@time-member" }));
  const activityNames = { Other: t("back_office.option.other"), ...timeActivities };
  for (const policy of state.policies) Object.assign(activityNames, policy.activityLabels);
  const extraChoices = firmCommand ? [
    ...state.projects.map(project => ({ ...row(project.id, { name: project.name }), objectId: "timeProjectChoices" })),
    ...Object.entries(activityNames)
      .map(([id, name]) => ({ ...row(id, { name }), objectId: "timeActivityChoices" })),
  ] : [];
  const records = [...directory.records.filter(record => record.objectId !== "timeEntries"), ...choices, ...extraChoices, ...rows, ...(showBlank ? [blankRow] : [])];
  const openRecord = (record: BackOfficeRecord) => { if (!record.objectId.startsWith("@")) navigate("/back-office/" + record.objectId + "?record=" + record.id + (record.archivedAt ? "&archived=true" : "")); };

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
    return next;
  }
  const availableClients = new Set(directory.records.filter(record => record.objectId === "clients" && !record.archivedAt).map(record => record.id));
  function billingClients(matterId: BackOfficeValue | undefined) {
    return state.matters.find(matter => matter.id === matterId)?.clientIds.filter(id => availableClients.has(id)) ?? [];
  }
  function requiredFieldErrors(record: BackOfficeRecord) {
    const values = record.values;
    const timer = proposalMap.get(record.id)?.source === "stopwatch";
    return {
      billingNarrative: String(values.name ?? "").trim() ? "" : t("timeWorkspace.requireDescription"),
      matter: values.matter ? "" : t("timeWorkspace.requireMatter"),
      recordedMinutes: typeof values.recordedMinutes === "number" && (values.recordedMinutes > 0 || (values.recordedMinutes === 0 && timer))
        ? "" : t("timeWorkspace.requireRecorded"),
      billableMinutes: typeof values.billableMinutes === "number" && values.billableMinutes >= 0 ? "" : t("timeWorkspace.requireBillable"),
    };
  }
  function valid(draft: TimeRowDraft) {
    return Boolean(draft.record.values.timekeeper && serviceDate(draft.record.values)) && !Object.values(requiredFieldErrors(draft.record)).some(Boolean);
  }
  async function privateDraft(draft: TimeRowDraft, verify = false) {
    if ((!verify && draft.privateSaved) || !currentCapture.current.privateAvailable) return;
    const key = draft.record.id;
    const current = currentCapture.current;
    const proposalDigest = draft.proposal?.digest;
    if (current.writeDraft) {
      let stored;
      try {
        stored = await current.writeDraft({ type: "draft-patch", key, date: draft.date, proposalDigest,
          revision: draft.focusedRevision ?? draft.privateRevision ?? 0, initial: draft.record.values, changes: draft.changes ?? {} });
      } catch (error) {
        const pending = edits.drafts.get(key);
        if (pending && pending.proposal?.digest === proposalDigest) pending.latestDraft = privateDraftConflict(error);
        throw error;
      }
      if (!stored) throw new Error(t("back_office.save_failed"));
      const later = edits.drafts.get(key);
      const pending = later && later !== draft ? differentTimeValues(draft.record.values, later.record.values) : {};
      draft.record = { ...draft.record, values: hydrateDraft(draft, stored.values) };
      draft.privateRevision = stored.revision;
      if (later && later !== draft && later.proposal?.digest === proposalDigest) {
        later.record = { ...later.record, values: { ...draft.record.values, ...pending } };
        later.privateRevision = stored.revision;
        later.changes = pending;
        later.privateSaved = !Object.keys(pending).length;
        if (later.privateSaved) later.focusedRevision = undefined;
        later.latestDraft = undefined;
        edits.draftErrors.delete(key);
        edits.changed();
      }
    } else if (!await current.act({ type: "draft", key, date: draft.date, values: draft.record.values, proposalDigest })) {
      throw new Error(t("back_office.save_failed"));
    }
    if (edits.drafts.get(key) === draft) {
      draft.privateSaved = true;
      draft.focusedRevision = undefined;
      draft.changes = {};
      draft.latestDraft = undefined;
      edits.draftErrors.delete(key);
      edits.changed();
    }
  }

  async function deletePrivateDraft(draftId: string, date: string, revision: number) {
    const current = currentCapture.current;
    if (current.writeDraft) await current.writeDraft({ type: "draft-patch", key: draftId, date, revision, changes: null });
    else if (!await current.act({ type: "draft", key: draftId, date, values: null })) throw new Error(t("back_office.save_failed"));
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
    if (typeof chosen !== "string" || !chosen.startsWith(memberPrefix) || typeof contact !== "string") return;
    edits.memberContacts.set(chosen, contact);
    const access = currentAccess.current;
    if (access?.rosterIds.has(chosen)) access.contacts.set(contact, chosen);
  }
  async function acknowledge(saved: BackOfficeRecord) {
    edits.confirmed.set(saved.id, saved);
    edits.changed();
    await applySavedRecord(cache, client.baseUrl, directory, saved);
  }
  async function flushUpdates(id: string) {
    const queue = edits.updates.get(id);
    if (!queue) return;
    while (queue[0] && !queue[0].error && !queue[0].conflict) {
      const edit = queue[0];
      const known = currentRecords.current.get(id);
      const confirmed = edits.confirmed.get(id);
      const current = confirmed && confirmed.revision > (known?.revision ?? 0) ? confirmed : known ?? edit.base;
      if (!canWrite(current, edit.values)) {
        edit.error = t("back_office.save_failed");
        edits.changed();
        return;
      }
      const expectedValues = Object.fromEntries(Object.keys(allowedValues(edit.values)).map(key => [key, edit.base.values[key] ?? null]));
      const expectedMember = expectedValues.timekeeper;
      if (typeof expectedMember === "string" && expectedMember.startsWith(memberPrefix)) {
        expectedValues.timekeeper = edits.memberContacts.get(expectedMember) ?? [...contacts].find(([, member]) => member === expectedMember)?.[0] ?? null;
      }
      edits.saving.add(id);
      edits.changed();
      try {
        const managed = latestState.current.entries.find(entry => entry.id === id);
        let saved: BackOfficeRecord;
        if (firmCommand && managed) {
          const changedFields = Object.keys(differentTimeValues(edit.base.values, current.values));
          const conflicts = conflictingTimeFields(edit.values, changedFields);
          if (current.revision !== edit.base.revision && Object.keys(edit.values).some(field => conflicts.has(field))) {
            edit.conflict = { record: current, fields: changedFields };
            continue;
          }
          const draft = workflowDraft({ ...current.values, ...edit.values }, managed);
          const next = await firmCommand({ type: "update", id, revision: current.revision, entry: draft });
          const entry = next.entries.find(item => item.id === id);
          if (!entry) throw new Error(t("back_office.save_failed"));
          saved = workflowRecord(entry, current);
        } else {
          saved = responseSchema.parse(await writeBackOfficeRecord(client, directory, {
            id, objectId: "timeEntries", revision: edit.base.revision, ...timeRecordBody(edit.values), expectedValues,
          })).record;
        }
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
    if (!canWrite(pending.record)) throw new Error(t("back_office.save_failed"));
    if (pending.proposal) {
      if (!accepted) { await privateDraft(pending); return; }
      const active = currentCapture.current;
      if (pending.proposal.digest !== accepted.digest || !active.proposals.some(proposal => proposal.key === id && proposal.digest === accepted.digest))
        throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
    } else if (accepted) return;
    // Merge with edits from other windows before using a private draft to write a ledger row.
    if (currentCapture.current.writeDraft && (pending.proposal || currentCapture.current.drafts[id] || pending.privateRevision)) {
      const reviewed = pending.record.values;
      await privateDraft(pending, true);
      if (Object.keys(differentTimeValues(reviewed, pending.record.values)).length) throw new Error(t(accepted
        ? "timesheets.sheet.edit_suggestion_changed" : "back_office.conflict.title"));
    }
    if (!valid(pending)) {
      await privateDraft(pending);
      if (accepted) setValidationAttempts(previous => new Set(previous).add(accepted.digest));
      return false;
    }
    if (!canWrite(pending.record)) throw new Error(t("back_office.save_failed"));
    edits.saving.add(id);
    edits.changed();
    try {
      const privateRevision = currentCapture.current.writeDraft ? pending.privateRevision : undefined;
      const saved = firmCommand
        ? await createWorkflowEntry(id, workflowDraft(pending.record.values), accepted, privateRevision)
        : responseSchema.parse(await writeBackOfficeRecord(client, directory, {
            id, objectId: "timeEntries", revision: 0, create: true, ...timeRecordBody(pending.record.values),
            ...(accepted ? { privateProposal: { key: id, digest: accepted.digest, profileId: directory.captureProfileId,
              ...(privateRevision === undefined ? {} : { draftRevision: privateRevision }) } }
              : privateRevision === undefined ? {} : { privateDraft: { date: pending.date, revision: privateRevision, profileId: directory.captureProfileId } }),
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
      if (!accepted && currentCapture.current.privateAvailable && (privateRevision !== undefined || !currentCapture.current.writeDraft))
        await deletePrivateDraft(id, pending.date, pending.privateRevision ?? 0);
    } catch (error) {
      const conflict = privateDraftConflict(error);
      if (conflict !== undefined) (edits.drafts.get(id) ?? pending).latestDraft = conflict;
      throw error;
    } finally {
      edits.saving.delete(id);
      edits.changed();
    }
  }
  async function edit(record: BackOfficeRecord, patch: TimeRecordValues, focusedRevision?: number) {
    const id = record.id;
    if (!canWrite(record, patch)) throw new Error(t("back_office.save_failed"));
    const values = timeCellChanges(record.values, patch, capture.date, fieldValue(record, "timekeeper"), matterId => {
      const matter = state.matters.find(matter => matter.id === matterId);
      return soleMatterClient(matter, state.clients) || null;
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
    if ((origin || (id === blankId && !matchingDraft)) && !Object.keys(values).length) return;
    const latest = matchingDraft?.record ?? record;
    const next = { ...latest, values: { ...latest.values, ...values } };
    if (firmCommand && "matter" in values && typeof next.values.project === "string" &&
        !state.projects.some(item => item.id === next.values.project && item.matterIds.includes(String(next.values.matter)))) {
      values.project = next.values.project = null;
    }
    const matter = state.matters.find(item => item.id === next.values.matter);
    if (matter && typeof next.values.recordedMinutes === "number") {
      const date = serviceDate(next.values);
      const clientId = String(next.values.client || soleMatterClient(matter, state.clients) || "");
      const guidelines = capture.guidelines ?? [];
      if (firmCommand || !origin && effectiveWorkdayGuidelines(state, guidelines, { date, clientId, matterId: matter.id }).length) {
        const projectId = typeof next.values.project === "string" ? next.values.project : undefined;
        const rules = draftRules(state, guidelines, matter, date, projectId, clientId);
        const activity = String(next.values.activity ?? "");
        const maximum = rules.activityLimits[activity] ?? rules.maxMinutes;
        const charge = next.values.billableMinutes;
        if (charge == null || (!("billableMinutes" in patch) && charge !== 0 &&
            ["matter", "client", "recordedMinutes", "startedAt", "serviceDate", "activity", "project"].some(key => key in values))) {
          next.values.billableMinutes = workdayBillableMinutes(next.values.recordedMinutes, rules, activity) ?? null;
          values.billableMinutes = next.values.billableMinutes;
        } else if ("billableMinutes" in values && typeof charge === "number" && charge > 0) {
          if (charge < rules.minimumMinutes) throw new Error(t("timeWorkspace.minimumBillable", { minutes: rules.minimumMinutes }));
          if (charge > maximum) throw new Error(t("timesheets.ledger.cap", { minutes: maximum }));
          if (rules.enforceIncrement && charge % rules.incrementMinutes) throw new Error(t("timesheets.ledger.increment", { minutes: rules.incrementMinutes }));
        }
      } else if (!saved && next.values.billableMinutes == null) {
        next.values.billableMinutes = proposedCharge(next.values.recordedMinutes, resolveTimePolicy(state.policies, clientId, matter.id, date));
      }
    }
    if (saved) { addUpdate(saved, values); return; }
    const storedDraft = capture.drafts[id];
    const draft: TimeRowDraft = { record: next, date: origin?.date ?? matchingDraft?.date ?? storedDraft?.date ?? capture.date, proposal: origin,
      privateRevision: matchingDraft?.privateRevision ?? storedDraft?.revision,
      focusedRevision: matchingDraft?.focusedRevision ?? focusedRevision,
      changes: { ...matchingDraft?.changes, ...differentTimeValues(latest.values, next.values) },
      latestDraft: matchingDraft?.latestDraft,
    };
    edits.drafts.set(id, draft);
    if (id === blankId && valid(draft)) blankIds.current.delete(blankKey);
    edits.changed();
    enqueue(id, async () => { await persistDraft(id); });
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
    const local = edits.drafts.get(id);
    const storedDraft = capture.drafts[id];
    enqueue(id, async () => {
      if (local?.latestDraft !== null && (local?.privateRevision !== undefined || storedDraft)) {
        try {
          await deletePrivateDraft(id, local?.date ?? storedDraft.date, local?.privateRevision ?? storedDraft?.revision ?? 0);
        } catch (error) {
          if (local) local.latestDraft = privateDraftConflict(error);
          throw error;
        }
      }
      edits.drafts.delete(id);
      edits.draftErrors.delete(id);
      if (id === blankId) blankIds.current.delete(blankKey);
      edits.changed();
    });
  }
  function retryDraft(id: string, useMine = true) {
    enqueue(id, async () => {
      const pending = edits.drafts.get(id);
      if (pending?.latestDraft) {
        const latest = pending.latestDraft;
        pending.privateRevision = latest.revision;
        pending.focusedRevision = undefined;
        if (!useMine) {
          pending.record = { ...pending.record, values: hydrateDraft(pending, latest.values) };
          pending.privateSaved = true;
          pending.changes = {};
          pending.acceptance = undefined;
          pending.latestDraft = undefined;
          edits.draftErrors.delete(id);
          edits.changed();
          return;
        }
      }
      await persistDraft(id, pending?.acceptance);
      edits.draftErrors.delete(id);
      edits.changed();
    });
  }

  function draftError(id: string) {
    const error = edits.draftErrors.get(id);
    if (!error) return null;
    const pending = edits.drafts.get(id), saved = pending?.latestDraft;
    return <div role="alert" className="bo-error">
      {error}
      {saved && pending ? <>
        <dl>{Object.keys(differentTimeValues(pending.record.values, saved.values)).map(field => {
          const label = object.fields.find(item => item.id === field)?.label ?? field;
          return <div key={field}><dt>{label} · {t("back_office.conflict.saved")}</dt><dd>{String(saved.values[field] ?? "∅")}</dd></div>;
        })}</dl>
        <button type="button" onClick={() => retryDraft(id, false)}>{t("back_office.conflict.keep")}</button>{" "}
        <button type="button" onClick={() => retryDraft(id)}>{t("back_office.conflict.apply")}</button>
      </> : pending && (saved === null
        ? <button type="button" onClick={() => discardDraft(id)}>{t("timesheets.sheet.edit_discard")}</button>
        : <button type="button" onClick={() => retryDraft(id)}>{t("timesheets.retry")}</button>)}
    </div>;
  }
  function accept(record: BackOfficeRecord, proposal: CaptureProposal) {
    if (!canWrite(record) || edits.saving.has(record.id))
      return Promise.resolve(false);
    if (!edits.drafts.has(record.id) || edits.drafts.get(record.id)?.proposal?.digest !== proposal.digest)
      edits.drafts.set(record.id, { record, date: proposal.date, proposal, privateRevision: currentCapture.current.drafts[record.id]?.revision });
    edits.drafts.get(record.id)!.acceptance = proposal;
    let booked = false;
    return enqueue(record.id, async () => { booked = await persistDraft(record.id, proposal) !== false; }).then(() => booked, () => false);
  }
  function finishProposal(proposal: CaptureProposal, action: CaptureAction) {
    if (edits.saving.has(proposal.key)) return Promise.resolve(false);
    return enqueue(proposal.key, async () => {
      const active = currentCapture.current;
      if (!active.proposals.some(item => item.key === proposal.key && item.digest === proposal.digest))
        throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
      edits.saving.add(proposal.key);
      edits.changed();
      try {
        if (action.type === "reconcile") {
          const draft = edits.drafts.get(proposal.key);
          if (draft?.proposal?.digest === proposal.digest) {
            const reviewed = draft.record.values;
            await privateDraft(draft, true);
            if (Object.keys(differentTimeValues(reviewed, draft.record.values)).length)
              throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
          }
          const draftRevision = draft?.privateRevision ?? active.drafts[proposal.key]?.revision;
          if (active.writeDraft) action = { ...action, draftRevision };
        }
        if (!await active.act(action)) throw new Error(t("back_office.save_failed"));
        edits.drafts.delete(proposal.key);
        edits.draftErrors.delete(proposal.key);
        hideProposals(previous => new Set(previous).add(proposal.key));
      } finally {
        edits.saving.delete(proposal.key);
        edits.changed();
      }
    }).then(() => true, () => false);
  }

  const { byDate } = periodTimeTotals(visible.map(record => ({
    date: serviceDate(record.values),
    workedMinutes: Number(record.values.recordedMinutes || 0),
    billableMinutes: Number(record.values.billableMinutes || 0),
  })));
  const unsaved = edits.updates.size > 0 || [...edits.drafts.values()].some(draft => !draft.proposal && !known.has(draft.record.id)) ||
    Object.entries(capture.drafts).some(([id, draft]) => !draft.proposalDigest && !draft.values.workflow && !known.has(id));
  const historyRecord = historyId ? stored.find(record => record.id === historyId && record.revision > 0) : undefined;
  const ledger = <div className="@container/time-history relative isolate flex min-h-0 min-w-0 flex-1">
    <div ref={grid} className="time-record-sheet min-w-0" onCopy={event => {
    if (!copied.current || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || window.getSelection()?.toString()) return;
    event.clipboardData.setData("text/plain", JSON.stringify({ legalworkTimeRow: 1, values: copyTimeRecordValues(copied.current, object.fields, capture.date, self, directory.permissions.finance) }));
    event.preventDefault();
  }} onPaste={event => {
    if (!editable || archived) return;
    try {
      const value = timeRowClipboardSchema.safeParse(JSON.parse(event.clipboardData.getData("text/plain")));
      if (value.success) { event.preventDefault(); duplicate(value.data.values); }
    } catch { /* Ordinary text remains available to the focused editor. */ }
  }}>
    <TimesheetWeekTotals dates={capture.dates} date={capture.date} totalsByDate={byDate} onDateChange={day => capture.selectDate(day, true)} />
    {members.length > 1 && capture.visible !== false && <TimeHeaderContent slot={TimekeeperControlTarget}>
      <TimeSelect label={t("timesheets.ledger.workers")} value={person}
        options={[{ id: "", name: t("timesheets.sheet.all_people") }, ...choices.map(member => ({ id: member.id, name: String(member.values.name) }))]}
        onChange={id => { setPerson(id); setComposerId(undefined); }} />
    </TimeHeaderContent>}
    {roster.error && <p className="bo-error" role="alert">{t("timesheets.sheet.members_error")} <Button size="xs" variant="outline" onClick={() => void roster.refetch()}>{t("timesheets.retry")}</Button></p>}
    {archived && archiveQuery.isPending && <p role="status">{t("common.loading")}</p>}
    {archived && archiveQuery.error && <p role="alert" className="bo-error">{archiveQuery.error.message} <Button size="xs" variant="outline" onClick={() => void archiveQuery.refetch()}>{t("timesheets.retry")}</Button></p>}
    {submitNotice && <p role={submitNotice.error ? "alert" : "status"} className={submitNotice.error ? "bo-error" : "px-3 py-1 text-sm"}>{submitNotice.message}</p>}
    {editable && !archived && <div className="time-entry-actions">
      {reviewLink && <Button size="sm" variant="ghost" nativeButton={false} render={<Link to={reviewLink} />}>{t("back_office.billing.detail")}</Button>}
      {submit && (ready.length > 0 || needsReview && !visible.length) && <Button size="sm" variant="outline" disabled={!ready.length || submitting || edits.saving.size > 0 || edits.updates.size > 0}
        onClick={() => void submitPeriod()}><Send size={14} />{t("timesheets.ledger.submit")}</Button>}
      <Button size="sm" className="time-new-entry" onClick={() => {
        setComposerId(blankId);
        grid.current?.querySelector<HTMLElement>('[data-sheet-blank] [data-col="0"]')?.focus();
      }}><Plus size={14} />{t("timesheets.ledger.new")}</Button>
    </div>}
    <RecordGrid object={object} records={records} views={directory.views} editable={editable} canEditRecord={canWrite} finance={directory.permissions.finance}
      userId={directory.permissions.userId} columnScope={scope} archived={archived} onArchivedChange={setArchived} lockedSchema
      onSave={async (record, patch, archive) => {
        if (archive === undefined) return edit(record, patch);
        if (!canWrite(record) || !record.revision) throw new Error(t("back_office.save_failed"));
        await enqueue(record.id, async () => {
          const latest = currentRecords.current.get(record.id) ?? record;
          if (!canWrite(latest) || edits.updates.has(record.id) || (archive && latest.revision !== record.revision)) throw new Error(t("back_office.save_failed"));
          const managed = latestState.current.entries.find(entry => entry.id === latest.id && !entry.legacy);
          if (managed && firmCommand) {
            if (!archive) throw new Error(t("back_office.save_failed"));
            await firmCommand({ type: "withdraw", id: latest.id, revision: latest.revision });
            return;
          }
          const { record: saved } = responseSchema.parse(await writeBackOfficeRecord(client, directory, {
            id: latest.id, objectId: latest.objectId, revision: latest.revision, values: {}, archived: archive,
          }));
          await acknowledge(saved);
        });
      }} onCreate={() => {}} onOpen={openRecord} onSaveView={onSaveView}
      readOnlyFields={firmCommand ? ["timekeeper", "status"] : members.length <= 1 ? ["timekeeper"] : undefined}
      sheet={{ columns: columnIds, blankId, fieldValue, appendedRowCount: receiptBookings.length,
        sumFields: ["recordedMinutes", "billableMinutes"],
        afterRows: archived ? undefined : render => <>
          {receipt((item, index) => {
            const record = entries.get(item.id) ?? known.get(item.id);
            return record ? render(record, index) : undefined;
          }, item => {
            const record = entries.get(item.id) ?? known.get(item.id);
            return record ? serviceDate(record.values) : item.date;
          }, receiptBookings)}
        </>,
        allowedRelationIds: (record, field) => field === "client" ? billingClients(record.values.matter)
          : field === "project" ? state.projects.filter(item => item.matterIds.includes(String(record.values.matter))).map(item => item.id) : undefined, widths: { startedAt: 130, timekeeper: 140, matter: 200, client: 170, billingNarrative: 340, recordedMinutes: 120, billableMinutes: 120 },
        onFocus: record => { copied.current = record.revision > 0 ? record.values : undefined; },
        trailing: record => record.revision > 0 ? <>
          {directory.permissions.edit && !archived && <Button variant="ghost" size="icon-xs" type="button" title={t("timesheets.ledger.duplicate")} aria-label={t("timesheets.ledger.duplicate")}
            onClick={() => duplicate(record.values)}><CopyPlus /></Button>}
          <Button type="button" variant="ghost" size="icon-xs" title={t("timesheets.ledger.history")} aria-label={t("timesheets.ledger.history")} aria-expanded={historyId === record.id} onClick={() => setHistoryId(current => current === record.id ? undefined : record.id)}><History /></Button>
        </> : null,
        leading: record => {
          if (!editable) return null;
          return record.id === blankId ? <button aria-label={t("back_office.add_new")} onClick={event => event.currentTarget.closest("[role=row]")?.querySelector<HTMLElement>("[role=gridcell]")?.click()}><Plus size={14} /></button> : undefined;
        },
        details: record => {
          const error = edits.draftErrors.get(record.id), change = edits.updates.get(record.id)?.[0];
          const draft = record.revision === 0 && (edits.drafts.has(record.id) || Boolean(capture.drafts[record.id]));
          if (!draft && !error && !change?.error && !change?.conflict) return null;
          return <div className="time-proposal-details">
            {draft && record.id !== blankId && <small>{t("timesheets.sheet.private_draft")}</small>}
            {draft && <button disabled={edits.saving.has(record.id)} onClick={() => discardDraft(record.id)}>{t("timesheets.sheet.edit_discard")}</button>}
            {error && draftError(record.id)}
            {change?.error && <span role="alert" className="bo-error">{change.error} <button onClick={() => resolveUpdate(record.id, change, null)}>{t("timesheets.retry")}</button> <button onClick={() => resolveUpdate(record.id, change, false)}>{t("timesheets.sheet.edit_discard")}</button></span>}
            {change?.conflict && <div className="time-proposal-evidence" role="alert"><strong>{t("back_office.conflict.title")}</strong>
              {[...conflictingTimeFields(change.values, change.conflict.fields)].map(id => {
                const field = object.fields.find(field => field.id === id);
                if (!field || !change.conflict) return null;
                const show = (value: BackOfficeValue | undefined) => value == null || value === "" ? "∅" : <ValueDisplay objectId="timeEntries" field={field} value={value} records={records} onOpen={openRecord} />;
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
    {(edits.saving.size > 0 || unsaved || directory.sync.error || directory.sync.pending > 0) && <span className="time-sheet-sync" role="status">
      <Info size={12} />{edits.saving.size ? t("projects.saving") : unsaved ? t("timesheets.sheet.edit_unsaved") : directory.sync.error ? t("timesheets.sheet.sync_error") : t("timesheets.sheet.pending")}
    </span>}
    </div>
    {historyRecord && <RecordHistorySidebar key={historyRecord.id} client={client} directory={directory} record={historyRecord}
      onClose={() => setHistoryId(undefined)} onOpen={openRecord} />}
  </div>;
  const timelineBookings = [...known.values()].filter(record => !record.archivedAt && isOwn(record) && serviceDate(record.values) === capture.date)
    .map(({ id, values }) => ({ key: id, matterId: String(values.matter ?? ""), narrative: String(values.billingNarrative || values.name || ""),
      startAt: typeof values.startedAt === "string" ? values.startedAt : undefined, endAt: typeof values.endedAt === "string" ? values.endedAt : undefined }));
  return workspace(ledger, proposal => {
    if (!proposalMap.has(proposal.key)) return null;
    const record = proposalRecord(proposal);
    const values = record.values;
    const localDraft = edits.drafts.get(proposal.key), savedDraft = capture.drafts[proposal.key];
    const revision = localDraft?.proposal?.digest === proposal.digest ? localDraft.privateRevision ?? 0
      : savedDraft?.proposalDigest === proposal.digest ? savedDraft.revision ?? 0 : 0;
    const busy = edits.saving.has(proposal.key);
    const errors = validationAttempts.has(proposal.digest) ? requiredFieldErrors(record) : undefined;
    const errorId = (key: keyof ReturnType<typeof requiredFieldErrors>) => errors?.[key] ? proposal.key + "-" + key + "-error" : undefined;
    const fieldError = (key: keyof ReturnType<typeof requiredFieldErrors>) => errors?.[key] &&
      <small role="alert" id={errorId(key)} className="text-xs text-destructive">{errors[key]}</small>;
    const matches = fieldValue(record, "timekeeper") === self && values.matter ? stored.filter(entry => isOwn(entry) &&
      serviceDate(entry.values) === proposal.date && entry.values.matter === values.matter) : [];
    const dismiss = () => finishProposal(proposal, { type: "dismiss", key: proposal.key, digest: proposal.digest });
    const patch = (values: TimeRecordValues, base = record, baseRevision?: number) => {
      void edit(base, values, baseRevision).catch(error => {
        edits.draftErrors.set(proposal.key, errorMessage(error));
        edits.changed();
      });
    };
    return (
      <div key={proposal.digest} className="time-workspace-form">
        <ProposalDecisionReceiver proposal={proposal} accept={() => accept(record, proposal)} dismiss={dismiss} />
        <label>{t("timesheets.workday.matter")}
          <TimeRecordPicker errorId={errorId("matter")} label={t("timesheets.workday.matter")} value={typeof values.matter === "string" ? values.matter : ""}
            disabled={!editable || busy} placeholder={t("timesheets.workday.choose")}
            options={proposal.source === "stopwatch" ? state.matters : [{ id: "", name: t("timesheets.workday.unassigned") }, ...state.matters]}
            onChange={matterId => {
              const before = proposalValues({ ...proposal, matterId: typeof values.matter === "string" ? values.matter : undefined }, state, capture.guidelines);
              const charge = proposalValues({ ...proposal, matterId, projectId: null, chargeMinutes: undefined }, state, capture.guidelines).billableMinutes;
              patch({ matter: matterId || null, ...(values.billableMinutes === before.billableMinutes ? { billableMinutes: charge } : {}) });
            }} />
          {fieldError("matter")}
        </label>
        <label>{t("timesheets.workday.description")}
          <RecordProposalField record={record} revision={revision} field="billingNarrative" errorId={errorId("billingNarrative")} disabled={!editable || busy} onCommit={patch} />
            {fieldError("billingNarrative")}
        </label>
        <div className="time-workspace-form-pair">
          <label>{t("timesheets.ledger.worked")}
            {proposal.estimatedMinutes != null && proposal.workedMinutes == null &&
              <small className="text-muted-foreground">{t("timeWorkspace.estimatedMinutes", { minutes: proposal.estimatedMinutes })}{proposal.estimateReason && " · " + proposal.estimateReason}</small>}
            <RecordProposalField record={record} revision={revision} field="recordedMinutes" errorId={errorId("recordedMinutes")} disabled={!editable || busy} onCommit={patch} />
            {fieldError("recordedMinutes")}
          </label>
          <label>{t("timesheets.ledger.charge")}
            <RecordProposalField record={record} revision={revision} field="billableMinutes" errorId={errorId("billableMinutes")} disabled={!editable || busy} onCommit={patch} />
            {fieldError("billableMinutes")}
          </label>
        </div>
        {draftError(proposal.key)}
        {matches.length > 0 && <label>{t("timesheets.sheet.reconcile")}
          <TimeSelect label={t("timesheets.sheet.reconcile")} value="" disabled={!editable || busy}
            placeholder={t("timeWorkspace.chooseRecorded")} options={matches.map(entry => ({ id: entry.id,
              name: String(entry.values.billingNarrative || entry.values.name) + " · " + formatTimeDuration(Number(entry.values.recordedMinutes), durationFormat),
            }))} onChange={id => {
              const match = matches.find(entry => entry.id === id);
              if (match) finishProposal(proposal, { type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: match.id, recordRevision: match.revision });
            }} />
        </label>}
        <div className="time-workspace-actions">
          <TimeProposalActions busy={busy} canAccept={editable} onAccept={() => void accept(record, proposal)}
            onDismiss={() => void dismiss()} />
          <Button size="sm" type="button" variant="outline" disabled={busy}
            onClick={() => void enqueue(proposal.key, async () => {
              const active = currentCapture.current;
              if (!active.proposals.some(item => item.key === proposal.key && item.digest === proposal.digest))
                throw new Error(t("timesheets.sheet.edit_suggestion_changed"));
              const local = edits.drafts.get(proposal.key);
              const draft = active.drafts[proposal.key];
              const reviewed = local?.proposal?.digest === proposal.digest ? local.record.values : values;
              const matterId = typeof reviewed.matter === "string" ? reviewed.matter : undefined;
              const { matter, project } = proposalAssignment(proposal, state);
              active.openSource({ ...proposal,
                ...(matterId === matter?.id ? {} : {
                  matterId, projectId: matterId && project?.matterIds.includes(matterId) ? project.id : null,
                }),
                narrative: String(reviewed.billingNarrative || proposal.narrative),
              }, local?.proposal?.digest === proposal.digest && local.privateRevision !== undefined
                ? local.privateRevision : draft ? draft.revision ?? 0 : undefined);
            }).catch(() => {})}>{t("common.edit")}</Button>
        </div>
      </div>
    );
  }, proposals, { bookings: timelineBookings, save: editable ? async (id, entry) => {
    const worker = self;
    const values = { name: entry.narrative.slice(0, 240), billingNarrative: entry.narrative, matter: entry.matterId,
      client: entry.clientId || null, timekeeper: worker, status: "Draft", serviceDate: entry.date,
      startedAt: entry.startAt ? localRecordInstant(entry.startAt) : entry.date, endedAt: entry.endAt ? localRecordInstant(entry.endAt) : null, recordedMinutes: entry.workedMinutes,
      billableMinutes: entry.billableMinutes };
    if (!canWrite(row(id, values))) throw new Error(t("back_office.save_failed"));
    const saved = firmCommand
      ? await createWorkflowEntry(id, workflowDraft({ ...values, project: entry.projectId ?? null, activity: entry.activity }))
      : responseSchema.parse(await writeBackOfficeRecord(client, directory, {
          id, objectId: "timeEntries", revision: 0, create: true, ...timeRecordBody(values),
        })).record;
    rememberMember(values, saved);
    await acknowledge(saved);
    showBooking({ id, date: entry.date, worker, description: entry.narrative });
  } : undefined });
}
