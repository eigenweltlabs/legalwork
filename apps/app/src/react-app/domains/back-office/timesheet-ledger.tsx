import type { TimeCaptureSheet } from "./time-record-sheet";
import {
  labelForCode,
  ledgerColumnKeys,
  placeholderKeys,
  activityKeys,
  entryStatusKeys,
  historyActionKeys,
  historyFieldKeys,
} from "./timesheet-labels";
import { Link } from "react-router-dom";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  History,
  Plus,
  Send,
  UserRoundPlus,
  X,
} from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import {
  nonBillableWork,
  requiresTimeAllocations,
  resolveTimePolicy,
  timeActivities,
  type TimeDraft,
  type TimeEntry,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { useLocale } from "@/i18n/use-locale";
import { decodeTimeRow, encodeTimeRow, timeRowMime } from "./timesheet-clipboard";
import {
  changeAmounts,
  type TimeAmounts,
  duration,
  emptyRow,
  fromDraft,
  localDate,
  matchMatter,
  matterOptions,
  offsetDate,
  parseRow,
  productOptions,
  rowColumns,
  stopwatchRowCharge,
  adjacentPeriod, periodDates, periodTimeTotals, type TimePeriod,
  workerOptions,
  type RowColumn,
  type RowValues,
} from "./timesheet-row";
import { AdjustmentRequest } from "./timesheet-adjustment";
import { useTimesheetColumns } from "./timesheet-columns";
import { useBookingReceipt } from "./time-booking-receipt";
import { differentTimeValues, privateDraftConflict, type TimeRecordValues } from "./time-record-edits";
import { TimesheetPeriodSwitch, TimesheetWeekTotals } from "./timesheet-week-totals";
import "./timesheet-ledger.css";

export type InitialTimesheetDraft = {
  key: string;
  entry: Partial<TimeDraft>;
  source?: "suggestion";
  proposalDigest?: string;
  captureSource?: CaptureProposal["source"];
};
type OriginalProposal = Pick<CaptureProposal, "date" | "activity" | "narrative" | "workedMinutes" | "digest">;

type Props = {
  capture?: TimeCaptureSheet;
  visible?: boolean;
  state: TimesheetState;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
  initialDraft?: InitialTimesheetDraft;
  onDiscardProposal?: () => void;
  initialDate?: string;
  onDateChange?: (date: string) => void;
  columnScope?: string;
  onEditingChange?: (dirty: boolean, dateLocked: boolean) => void;
  onOriginal?: (digest: string) => Promise<OriginalProposal>;
  canEdit?: boolean;
};
type Edit = { entry: TimeEntry; initial: RowValues; values: RowValues };
type DraftBaseline = { revision: number; values: TimeRecordValues };
function workflowDraftValues(values: RowValues): TimeRecordValues {
  return { workflow: true, billable: values.billable, createProduct: Boolean(values.createProduct),
    productId: values.productId ?? null, ...Object.fromEntries(rowColumns.map(column => [column, values[column]])) };
}
function workflowDraftRow(row: RowValues, values: TimeRecordValues): RowValues {
  const merged = { ...row };
  for (const column of rowColumns) if (typeof values[column] === "string") merged[column] = values[column];
  if (typeof values.billable === "boolean") merged.billable = values.billable;
  if (typeof values.createProduct === "boolean") merged.createProduct = values.createProduct;
  if (Object.hasOwn(values, "productId")) merged.productId = typeof values.productId === "string" ? values.productId : undefined;
  return merged;
}
function changes(entry: TimeEntry, person: (id: string) => string, locale: string) {
  return (
    <ol className="bo-time-history">
      {entry.history.map((event) => (
        <li key={event.revision}>
          <b>{person(event.actorId)}</b> · {new Date(event.at).toLocaleString(locale)} ·{" "}
          {labelForCode(historyActionKeys, event.action)}
          {event.before &&
            (Object.keys(event.after) as (keyof typeof event.after)[])
              .filter((key) => event.before?.[key] !== event.after[key])
              .map((key) => (
                <div key={key}>
                  {labelForCode(historyFieldKeys, key)} · <del>{String(event.before?.[key] ?? "—")}</del> →{" "}
                  {String(event.after[key] ?? "—")}
                </div>
              ))}
        </li>
      ))}
    </ol>
  );
}

function PrivateOriginal({
  entry,
  load,
}: {
  entry: TimeEntry;
  load: (digest: string) => Promise<OriginalProposal>;
}) {
  const [original, setOriginal] = useState<OriginalProposal | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const first = entry.history.find((event) => event.action === "create" && event.before === null)?.after;
  if (!entry.proposalDigest) return null;
  const digest = entry.proposalDigest;
  async function open() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const proposal = await load(digest);
      if (proposal.digest !== digest) throw Error(t("timesheets.ledger.original_unavailable"));
      setOriginal(proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("timesheets.ledger.original_unavailable"));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="bo-time-original">
      {original ? (
        <dl>
          <div>
            <dt>{t("timesheets.ledger.original")}</dt>
            <dd>
              {original.date + " · "}
              {original.activity} · {original.narrative} ·{" "}
              {original.workedMinutes === null
                ? t("timesheets.ledger.unknown_minutes")
                : duration(original.workedMinutes) + " h"}
            </dd>
          </div>
          {first && (
            <div>
              <dt>{t("timesheets.ledger.first_saved")}</dt>
              <dd>
                {first.date} · {first.activity} · {first.narrative} · {duration(first.workedMinutes)} h
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void open()}>
          {t("timesheets.ledger.compare_original")}
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function TimesheetLedger({
  capture, visible = true,
  state,
  onCommand,
  initialDraft,
  onDiscardProposal,
  initialDate,
  onDateChange,
  columnScope,
  onEditingChange,
  canEdit = true,
  onOriginal,
}: Props) {
  const locale = useLocale();
  const currentState = useRef(state);
  currentState.current = state;
  const uid = useId();
  const {
    columns,
    control: columnChooser,
    layout,
    reveal,
  } = useTimesheetColumns(columnScope ?? state.scope + ":" + state.userId);
  const [participants, setParticipants] = useState<
    { key: string; workerId: string; amounts?: TimeAmounts }[]
  >([]);
  const host = useRef<HTMLDivElement>(null);
  const matters = useMemo(() => matterOptions(state), [state.matters, state.clients, state.projects]);
  const people = useMemo(() => workerOptions(state), [state.people, state.userId, locale]);
  const person = (id: string) => people.find((p) => p.id === id)?.label ?? state.people.find(p => p.id === id)?.name ?? id;
  const [ledgerDate, setLedgerDate] = useState(initialDraft?.entry.date ?? initialDate ?? localDate(new Date()));
  const [period, setPeriod] = useState<TimePeriod>("day");
  const date = capture?.date ?? ledgerDate;
  const dates = capture?.dates ?? periodDates(date, period);
  const previousDate = useRef(date);
  const previousCapture = useRef(capture);
  const parkedDrafts = useRef(new Map<string, { requestId: string; values: RowValues; participants: typeof participants }>());
  const { showBooking, bookings, receipt } = useBookingReceipt(date, day => chooseDate(day, true), visible);
  const [composerOpen, setComposerOpen] = useState(Boolean(initialDraft));
  useEffect(() => setComposerOpen(false), [date, visible]);
  function capFor(
    entry: Pick<TimeDraft, "clientId" | "matterId" | "projectId" | "date" | "activity" | "billableMinutes">,
  ) {
    const policy = resolveTimePolicy(
      state.policies,
      entry.clientId,
      entry.matterId,
      entry.date,
      entry.projectId,
    );
    const maximum = policy.activityLimits[entry.activity] ?? policy.maxMinutes;
    return entry.billableMinutes > maximum ? maximum : null;
  }
  const own = person(state.userId);
  const restored = Object.entries(capture?.drafts ?? {}).find(([id, item]) =>
    item.date === date && item.values.workflow && !item.proposalDigest &&
    !state.entries.some(entry => entry.groupId === id));
  const [draft, setDraft] = useState(() => fromDraft(initialDraft?.entry ?? {}, own, date, state, matters));
  const [draftChanged, setDraftChanged] = useState(false);
  const [requestId, setRequestId] = useState(() => initialDraft?.key ?? crypto.randomUUID());
  const privateQueue = useRef<Promise<RowValues | false>>(Promise.resolve(false));
  const privateBases = useRef(new Map<string, DraftBaseline>());
  const [privateConflicts, setPrivateConflicts] = useState<Partial<Record<string, DraftBaseline | null>>>({});
  const privateConflict = privateConflicts[requestId];
  const latestDraft = useRef({ requestId, values: draft });
  latestDraft.current = { requestId, values: draft };
  if (!privateBases.current.has(requestId)) privateBases.current.set(requestId, {
    revision: 0, values: workflowDraftValues(emptyRow(date, own)),
  });
  const restoredKeys = useRef(new Set<string>());
  const [provenance, setProvenance] = useState(initialDraft?.source);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [selected, setSelected] = useState("");
  const [history, setHistory] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editing = Boolean(edit || draftChanged || provenance);
  const dateLocked = Boolean(edit || provenance || busy);
  const draftsOpen = editing || parkedDrafts.current.size > 0;
  useEffect(() => onEditingChange?.(draftsOpen, dateLocked), [draftsOpen, dateLocked, onEditingChange]);
  useLayoutEffect(() => {
    const from = previousDate.current;
    const oldCapture = previousCapture.current;
    previousDate.current = date;
    previousCapture.current = capture;
    if (!capture || from === date) return;
    if (draftChanged && !provenance) {
      parkedDrafts.current.set(from, { requestId, values: draft, participants });
      savePrivateDraft(from, oldCapture);
    }
    const parked = parkedDrafts.current.get(date);
    parkedDrafts.current.delete(date);
    setRequestId(parked?.requestId ?? crypto.randomUUID());
    setDraft(parked?.values ?? emptyRow(date, own));
    setDraftChanged(Boolean(parked));
    setParticipants(parked?.participants ?? []);
    setSelected("");
    setHistory("");
    setError("");
  }, [date, capture]);
  useEffect(() => {
    if (!capture && initialDate && !editing) setLedgerDate(initialDate);
  }, [initialDate, editing]);
  useEffect(() => {
    if (!editing) setDraft(current => current.date === date ? current : { ...current, date });
  }, [date, editing]);
  const restoredKey = restored?.[0], restoredFields = restored?.[1].values, restoredRevision = restored?.[1].revision;
  useEffect(() => {
    if (editing || !restoredKey || !restoredFields || restoredKeys.current.has(restoredKey)) return;
    const initial = workflowDraftRow(emptyRow(date, own), restoredFields);
    privateBases.current.set(restoredKey, { revision: restoredRevision ?? 0, values: workflowDraftValues(initial) });
    restoredKeys.current.add(restoredKey);
    setRequestId(restoredKey);
    setDraft(initial);
    setDraftChanged(true);
  }, [date, editing, own, restoredKey, restoredFields, restoredRevision]);
  const rows = state.entries
    .filter(
      (e) =>
        e.workerId === state.userId &&
        e.status !== "declined" &&
        dates.includes(e.date),
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.history[0]?.at ?? "").localeCompare(b.history[0]?.at ?? "") ||
        a.id.localeCompare(b.id),
    );
  const countedRows = rows.filter(row => row.status !== "pending");
  const awaitingConfirmation = rows.filter(row => row.status === "pending");
  const { totals, byDate } = periodTimeTotals(countedRows);
  const delegated = (state.delegatedEntries ?? []).filter(e => dates.includes(e.date));
  const ready = rows.filter((e) => e.status === "confirmed");
  const copied = rows.find((e) => e.id === selected);
  const focus = (row: string, column: RowColumn) => {
    if (row === "new") setComposerOpen(true);
    reveal(column);
    requestAnimationFrame(() => {
      const element = host.current?.querySelector<HTMLInputElement>(
        `[data-time-row="${CSS.escape(row)}"] [data-column="${column}"]`,
      );
      if (!element) return;
      element.focus();
      if (element.tagName === "INPUT" && element.type === "text") element.select();
    });
  };
  function chooseDate(next: string, openDay = false) {
    if (!next || (next === date && !openDay)) return;
    if (dateLocked || (!capture && draftChanged)) {
      setError(t("timesheets.ledger.finish_edit"));
      return;
    }
    if (capture) {
      capture.selectDate(next, openDay);
      return;
    }
    else {
      if (openDay) setPeriod("day");
      setLedgerDate(next);
      if (next !== date) onDateChange?.(next);
    }
    setDraft((current) => (current.date === date ? { ...current, date: next } : current));
    setSelected("");
    setHistory("");
  }
  function policyFor(values: RowValues) {
    const matter = matchMatter(matters, values.matter);
    return resolveTimePolicy(
      state.policies,
      matter?.clientId ?? "",
      matter?.matterId ?? "",
      values.date,
      matter?.projectId ?? (!values.matter && provenance ? initialDraft?.entry.projectId : undefined),
    );
  }
  const stopwatchDraft = Boolean(provenance && initialDraft?.captureSource === "stopwatch");
  function stopwatchCharge(values: RowValues) {
    return stopwatchRowCharge(initialDraft?.entry ?? {}, values, policyFor(values));
  }
  function participantAmounts(amounts?: TimeAmounts) {
    if (amounts) return amounts;
    return stopwatchDraft && draft.manualCharge
      ? { ...draft, manualCharge: false, charge: String(stopwatchCharge(draft)) }
      : draft;
  }
  function field(row: string, key: RowColumn, value: string) {
    const update = (current: RowValues) => {
      const next = { ...current, [key]: value };
      if (key === "worked" || key === "billableWork" || key === "nonBillable" || key === "charge") {
        return { ...current, ...changeAmounts(current, key, value, policyFor(current),
          row === "new" && stopwatchDraft ? (amounts) => stopwatchCharge({ ...current, ...amounts }) : undefined) };
      }
      if (key === "matter" && current.matter !== value) {
        next.product = "";
        next.productId = undefined;
        next.createProduct = false;
      }
      if (key === "product" && typeof value === "string") {
        const matter = matters.find((m) => m.label === current.matter);
        next.productId = current.createProduct
          ? undefined
          : productOptions(state, matter?.matterId).find((p) => p.label === value)?.id;
      }
      if (row === "new" && stopwatchDraft && (key === "matter" || key === "date") && !current.manualCharge)
        next.charge = next.worked ? String(stopwatchCharge(next)) : "";
      return next;
    };
    if (row === "new") {
      if (stopwatchDraft && (key === "matter" || key === "date"))
        setParticipants((items) => items.map((item) => {
          if (!item.amounts) return item;
          const previous = { ...draft, ...item.amounts };
          return !previous.manualCharge
            ? { ...item, amounts: { ...item.amounts, charge: String(stopwatchCharge({ ...previous, [key]: value })) } }
            : item;
        }));
      setDraft(update);
      setDraftChanged(true);
    } else setEdit((current) => current && { ...current, values: update(current.values) });
    setError("");
    setNotice("");
  }
  function toggleProductCreation(row: string, values: RowValues, matterId?: string) {
    const create = !values.createProduct;
    const selected = productOptions(state, matterId).find(
      (p) => p.id === values.productId || p.label === values.product,
    );
    const next = {
      ...values,
      product: selected?.name ?? values.product,
      createProduct: create,
      productId: undefined,
    };
    if (row === "new") {
      setDraft(next);
      setDraftChanged(true);
    } else setEdit((current) => current && { ...current, values: next });
    setError("");
    focus(row, "product");
  }
  async function send(command: TimesheetCommand) {
    await onCommand(command);
    if (command.type !== "create") return;
    const { entry, workerIds } = command;
    showBooking({ id: command.requestId, date: entry.date, description: entry.narrative,
      details: [state.matters.find(matter => matter.id === entry.matterId)?.name,
        (workerIds ?? [state.userId]).map(person).join(", "), t("timesheets.sheet.worked", { minutes: entry.workedMinutes }),
        t("timesheets.sheet.charge", { minutes: entry.billableMinutes })].filter(Boolean).join(" · ") });
  }
  async function run(command: TimesheetCommand) {
    if (!canEdit || pending.current) return false;
    if (!state.supportsTimeAllocations && requiresTimeAllocations(command)) {
      setError(t("timesheets.allocation_upgrade"));
      return false;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await send(command);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("timesheets.ledger.failed"));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function openEditor(entry: TimeEntry) {
    const values = fromDraft(entry, person(entry.workerId), date, state, matters);
    setEdit({ entry, initial: values, values });
    setSelected(entry.id);
  }
  function closeEditor(row: string, nextFocus: boolean, tabToNext: boolean) {
    setEdit(null);
    if (!nextFocus) return;
    if (tabToNext) {
      const next = rows
        .slice(rows.findIndex((entry) => entry.id === row) + 1)
        .find((entry) => ["pending", "confirmed", "submitted"].includes(entry.status));
      if (next) openEditor(next);
      focus(next?.id ?? "new", "matter");
    } else focus(row, "narrative");
  }
  function valuesForSave(row: string, values: RowValues) {
    return row === "new" && !provenance && !values.activity.trim()
      ? { ...values, activity: "GEN" }
      : values;
  }
  async function save(row: string, nextFocus = true, tabToNext = false,
    review?: { values: RowValues; parsed: ReturnType<typeof parseRow> }) {
    if (!canEdit || pending.current) return false;
    if (row === "new" && edit) {
      setError(t("timesheets.ledger.finish_edit"));
      return false;
    }
    let before = review?.values ?? (row === "new" ? draft : edit?.values);
    if (!before) return false;
    const saveBeforeBooking = row === "new" && !provenance && Boolean(capture?.writeDraft);
    if (saveBeforeBooking) {
      const saved = await savePrivateDraft(date, capture, before, true);
      if (!saved || previousDate.current !== date || latestDraft.current.requestId !== requestId) return false;
      before = saved;
    }
    const current = valuesForSave(row, before);
    if (
      row !== "new" &&
      edit &&
      rowColumns.every((key) => current[key] === edit.initial[key]) &&
      current.productId === edit.initial.productId &&
      Boolean(current.createProduct) === Boolean(edit.initial.createProduct)
    ) {
      closeEditor(row, nextFocus, tabToNext);
      setError("");
      setNotice("");
      return true;
    }
    const result = !saveBeforeBooking && review ? review.parsed : parseRow(current, state);
    if ("error" in result) {
      setError(result.error);
      focus(row, result.field);
      return false;
    }
    const { entry, workerIds } = result;
    const original = row === "new" ? (provenance ? initialDraft?.entry : undefined) : edit?.entry;
    if (
      original?.date === entry.date &&
      original.workedMinutes === entry.workedMinutes &&
      original.startAt &&
      original.endAt
    ) {
      entry.startAt = original.startAt;
      entry.endAt = original.endAt;
    }
    const policy = resolveTimePolicy(
      state.policies,
      entry.clientId,
      entry.matterId,
      entry.date,
      entry.projectId,
    );
    if (policy.enforceIncrement && entry.billableMinutes % policy.incrementMinutes) {
      setError(t("timesheets.ledger.increment", { minutes: policy.incrementMinutes }));
      focus(row, "charge");
      return false;
    }

    if (row === "new") {
      const workerTimes = [];
      for (const participant of participants) {
        const worker = people.find((p) => p.id === participant.workerId);
        if (!worker || workerIds.includes(worker.id)) {
          setError(t("timesheets.distinct_people"));
          return false;
        }
        const parsed = parseRow({ ...current, ...participantAmounts(participant.amounts), workers: worker.label }, state);
        if ("error" in parsed) {
          setError(worker.label + " · " + parsed.error);
          return false;
        }
        const item = parsed.entry;
        if (policy.enforceIncrement && item.billableMinutes % policy.incrementMinutes) {
          setError(
            worker.label + " · " + t("timesheets.ledger.increment", { minutes: policy.incrementMinutes }),
          );
          return false;
        }
        workerIds.push(worker.id);
        workerTimes.push({
          workerId: worker.id,
          workedMinutes: item.workedMinutes,
          nonBillableMinutes: nonBillableWork(item),
          billableMinutes: item.billableMinutes,
        });
      }
      const command: TimesheetCommand = {
        type: "create",
        requestId,
        entry,
        workerIds,
        ...(workerTimes.length ? { workerTimes } : {}),
        ...(provenance ? { source: provenance, proposalDigest: initialDraft?.proposalDigest } : {}),
      };
      if (!(await run(command))) return false;
      await clearPrivateDraft(true);
      if (previousDate.current !== date) {
        if (parkedDrafts.current.get(date)?.requestId === requestId) parkedDrafts.current.delete(date);
        return true;
      }
      setRequestId(crypto.randomUUID());
      setProvenance(undefined);
      setDraftChanged(false);
      setParticipants([]);
      setComposerOpen(false);
      setDraft(
        emptyRow(
          date,
          own,
          matters.find(
            (m) =>
              m.clientId === entry.clientId &&
              m.matterId === entry.matterId &&
              m.projectId === entry.projectId,
          )?.label,
        ),
      );
      if (nextFocus) focus("new", "matter");
    } else if (edit) {
      if (edit.entry.nonBillableMinutes !== undefined) entry.nonBillableMinutes = nonBillableWork(entry);
      if (!(await run({ type: "update", id: edit.entry.id, revision: edit.entry.revision, entry })))
        return false;
      closeEditor(row, nextFocus, tabToNext);
    }
    const limit = capFor(entry);
    setNotice(
      limit === null
        ? row === "new" && workerIds.length > 1
          ? t("timesheets.saved_people", { count: workerIds.length })
          : t("timesheets.ledger.saved")
        : t("timesheets.ledger.cap_review", { minutes: limit }),
    );
    return true;
  }
  function startEdit(row: TimeEntry, column: RowColumn) {
    if (
      !canEdit ||
      pending.current ||
      !["pending", "confirmed", "submitted"].includes(row.status) ||
      column === "workers"
    )
      return;
    if (edit && edit.entry.id !== row.id) {
      void save(edit.entry.id, false).then((saved) => {
        if (saved) open();
      });
    } else open();
    function open() {
      openEditor(row);
      setError("");
      setNotice(row.status === "submitted" ? t("timesheets.ledger.reopens") : "");
      focus(row.id, column);
    }
  }
  function pasteEntry(entry: TimeDraft) {
    if (!canEdit || pending.current) return;
    if (
      edit ||
      draftChanged ||
      draft.narrative.trim() ||
      draft.activity.trim() ||
      draft.product.trim() ||
      draft.worked ||
      draft.charge ||
      draft.workers !== own ||
      !draft.billable ||
      provenance
    ) {
      setError(t("timesheets.ledger.unfinished"));
      return;
    }
    setEdit(null);
    setHistory("");
    setError("");
    setProvenance(undefined);
    setRequestId(crypto.randomUUID());
    setDraftChanged(true);
    setDraft(fromDraft({ ...entry, date }, own, date, state, matters));
    focus("new", "narrative");
    setNotice(t("timesheets.ledger.pasted"));
  }
  function clearPrivateConflict() {
    setPrivateConflicts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => key !== requestId)));
  }
  function privateSaveError(error: unknown) {
    const latest = privateDraftConflict(error);
    if (latest !== undefined) setPrivateConflicts(previous => ({ ...previous, [requestId]: latest && {
      revision: latest.revision ?? 0, values: latest.values,
    } }));
    if (latestDraft.current.requestId === requestId) setError(error instanceof Error ? error.message : t("back_office.save_failed"));
  }
  function savePrivateDraft(origin = date, target = capture, values = draft, verify = false,
    retry?: DraftBaseline): Promise<RowValues | false> {
    if (!target?.privateAvailable || provenance || !draftChanged) return Promise.resolve(values);
    const fields = workflowDraftValues(values);
    const original = privateBases.current.get(requestId)!;
    const local = differentTimeValues(original.values, fields);
    privateQueue.current = privateQueue.current.then(async () => {
      try {
        if (!target.writeDraft) {
          if (!await target.act({ type: "draft", key: requestId, date: origin, values: fields })) throw Error(t("back_office.save_failed"));
          return values;
        }
        const base = retry ?? privateBases.current.get(requestId) ?? original;
        const changes = differentTimeValues(base.values, local);
        if (!Object.keys(changes).length && !(verify && base.revision)) return workflowDraftRow(values, { ...base.values, ...local });
        const saved = await target.writeDraft({ type: "draft-patch", key: requestId, date: origin, revision: base.revision,
          changes, initial: fields });
        const stored = saved;
        if (!stored) throw Error(t("back_office.save_failed"));
        privateBases.current.set(requestId, { revision: stored.revision ?? 0, values: stored.values });
        clearPrivateConflict();
        const merged = workflowDraftRow(values, stored.values);
        const keepLater = (row: RowValues) => workflowDraftRow(row, { ...stored.values,
          ...differentTimeValues(fields, workflowDraftValues(row)) });
        if (latestDraft.current.requestId === requestId) setDraft(keepLater);
        else {
          const parked = parkedDrafts.current.get(origin);
          if (parked?.requestId === requestId) parked.values = keepLater(parked.values);
        }
        return merged;
      } catch (error) { privateSaveError(error); return false; }
    });
    return privateQueue.current;
  }
  async function clearPrivateDraft(confirmed = false) {
    if (!capture?.privateAvailable || provenance) return true;
    const displayed = privateBases.current.get(requestId);
    await privateQueue.current;
    try {
      if (capture.writeDraft) {
        const base = confirmed ? privateBases.current.get(requestId) : displayed;
        if (privateConflict !== null && (base?.revision || privateBases.current.get(requestId)?.revision || capture.drafts[requestId]))
          await capture.writeDraft({ type: "draft-patch", key: requestId, date,
          revision: base?.revision ?? 0, changes: null });
      } else if (!await capture.act({ type: "draft", key: requestId, date, values: null })) throw Error(t("back_office.save_failed"));
      privateBases.current.delete(requestId);
      clearPrivateConflict();
      return true;
    } catch (error) { privateSaveError(error); return false; }
  }
  async function resetComposer() {
    if (!await clearPrivateDraft() || latestDraft.current.requestId !== requestId) return;
    setComposerOpen(false);
    if (provenance) onDiscardProposal?.();
    setDraftChanged(false);
    setParticipants([]);
    setDraft(emptyRow(date, own));
    setRequestId(crypto.randomUUID());
    setProvenance(undefined);
    setError("");
    setNotice("");
  }
  function resolvePrivateConflict(useMine: boolean) {
    if (!privateConflict) return;
    if (useMine) void savePrivateDraft(date, capture, draft, true, privateConflict).then(row => { if (row) setError(""); });
    else {
      privateBases.current.set(requestId, privateConflict);
      setDraft(current => workflowDraftRow(current, privateConflict.values));
      clearPrivateConflict();
      setError("");
    }
  }
  function clipboardCopy(event: ClipboardEvent) {
    if (
      !copied ||
      (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") ||
      window.getSelection()?.toString()
    )
      return;
    const data = encodeTimeRow(copied);
    event.clipboardData.setData("text/plain", data.plain);
    try {
      event.clipboardData.setData(timeRowMime, data.json);
    } catch {
      /* Some WebViews only accept text. */
    }
    event.preventDefault();
    setNotice(t("timesheets.ledger.copied"));
  }
  function clipboardPaste(event: ClipboardEvent) {
    const entry = decodeTimeRow(
      event.clipboardData.getData(timeRowMime),
      event.clipboardData.getData("text/plain"),
    );
    if (!entry) return;
    event.preventDefault();
    pasteEntry(entry);
  }
  function onKey(event: KeyboardEvent<HTMLInputElement>, row: string, column: RowColumn) {
    if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setError("");
      setNotice("");
      if (row === "new") resetComposer();
      else {
        setEdit(null);
        focus(row, column);
      }
    } else if (event.key === "Tab" && (event.shiftKey || column !== columns[columns.length - 1])) {
      const available = row === "new" ? columns : columns.filter(value => value !== "workers");
      const target = available[available.indexOf(column) + (event.shiftKey ? -1 : 1)];
      if (!target) return;
      event.preventDefault();
      if (row === "new") { savePrivateDraft(); focus(row, target); }
      else void save(row, false).then(saved => {
        if (!saved) return;
        requestAnimationFrame(() => {
          const latest = currentState.current.entries.find(entry => entry.id === row);
          if (latest) openEditor(latest);
          focus(row, target);
        });
      });
    } else if (
      event.key === "Enter" ||
      (event.key === "Tab" && !event.shiftKey && column === columns[columns.length - 1])
    ) {
      event.preventDefault();
      void save(row, true, event.key === "Tab");
    }
  }
  function editors(row: string, values: RowValues) {
    const localMatter = matchMatter(matters, values.matter);
    const catalog = resolveTimePolicy(
      state.policies,
      localMatter?.clientId ?? "",
      localMatter?.matterId ?? "",
      values.date,
      localMatter?.projectId,
    ).activityLabels;
    const activityName = (code: string) => catalog[code] || labelForCode(activityKeys, code);
    const choices: Partial<Record<RowColumn, string[]>> = {
      matter: matters.map((m) => m.label),
      workers: people.map((p) => p.label),
      activity: Object.keys({ ...timeActivities, ...catalog }),
      product: values.createProduct ? [] : productOptions(state, localMatter?.matterId).map((p) => p.label),
    };
    const workerPrefix = values.workers.includes(" + ")
      ? values.workers.slice(0, values.workers.lastIndexOf(" + ") + 3)
      : "";
    return columns.map((column) => {
      const value = values[column],
        list = choices[column];
      return (
        <div role="gridcell" className="bo-grid-cell bo-time-input-cell" key={column}>
          <input
            data-column={column}
            aria-label={t(ledgerColumnKeys[column])}
            type={column === "date" ? "date" : "text"}
            disabled={busy || (column === "workers" && row !== "new")}
            readOnly={column === "charge" && !values.billable || column === "workers" && people.length <= 1}
            title={column === "workers" ? t(people.length <= 1 ? "timesheets.self_only" : "timesheets.ledger.worker_hint") : undefined}
            autoComplete="off"
            placeholder={
              column === "product" && values.createProduct
                ? t("timesheets.ledger.new_product_title")
                : t(placeholderKeys[column])
            }
            value={String(column === "charge" && !values.billable ? "0" : value)}
            list={list ? uid + row + column : undefined}
            inputMode={
              ["worked", "charge", "billableWork", "nonBillable"].includes(column) ? "numeric" : undefined
            }
            onChange={(e) => field(row, column, e.currentTarget.value)}
            onBlur={(e) => {
              const value = e.currentTarget.value;
              const destination = e.relatedTarget;
              const query = value.trim().toLocaleLowerCase();
              const matches = query && list && !list.includes(value)
                ? list.filter(choice => choice.toLocaleLowerCase().includes(query)) : [];
              let reviewed = values;
              if (
                matches.length === 1 &&
                (column === "matter" ||
                  column === "workers" ||
                  (column === "activity" && matches[0].toLowerCase() === query))
              ) {
                field(row, column, matches[0]);
                reviewed = { ...values, [column]: matches[0] };
                if (column === "matter") Object.assign(reviewed, { product: "", productId: undefined, createProduct: false });
              }
              if (row === "new") savePrivateDraft(date, capture, reviewed);
              const inside = destination instanceof Element &&
                (destination.closest("[data-time-row]")?.getAttribute("data-time-row") === row ||
                  row === "new" && destination.closest(".bo-time-participants"));
              const saveOnLeave = (capture && row === "new" && !provenance) || column === columns[columns.length - 1];
              if (saveOnLeave && !inside) {
                const normalized = valuesForSave(row, reviewed);
                const parsed = parseRow(normalized, state);
                if (!("error" in parsed)) void save(row, false, false, { values: normalized, parsed });
              }
            }}
            onFocus={(e) => {
              if (e.currentTarget.type === "text") e.currentTarget.select();
            }}
            onKeyDown={(e) => onKey(e, row, column)}
          />
          {column === "product" && (
            <button
              type="button"
              className="bo-time-new-product"
              aria-label={t("timesheets.ledger.new_product")}
              title={t("timesheets.ledger.new_product")}
              aria-pressed={!!values.createProduct}
              disabled={busy}
              onClick={() => toggleProductCreation(row, values, localMatter?.matterId)}
            >
              <Plus size={12} />
            </button>
          )}
          {list && (
            <datalist id={uid + row + column}>
              {list.map((choice) => (
                <option key={choice} value={column === "workers" ? workerPrefix + choice : choice}>
                  {column === "activity" ? activityName(choice) : choice}
                </option>
              ))}
            </datalist>
          )}
        </div>
      );
    });
  }
  function showValue(entry: TimeEntry, column: RowColumn, row: RowValues) {
    if (column === "date")
      return new Date(entry.date + "T12:00:00").toLocaleDateString(locale, {
        day: "2-digit",
        month: "2-digit",
      });
    if (column === "activity")
      return (
        <span
          title={
            entry.activityLabel ??
            (Object.hasOwn(timeActivities, entry.activity)
              ? labelForCode(activityKeys, entry.activity)
              : entry.activity)
          }
        >
          {entry.activity}
        </span>
      );
    return row[column];
  }
  const activeValues = edit?.values ?? draft,
    activeMatter = matters.find((m) => m.label === activeValues.matter);
  const activeCap =
    activeMatter && activeValues.billable
      ? capFor({
          ...activeMatter,
          date: activeValues.date,
          activity: activeValues.activity,
          billableMinutes: +activeValues.charge,
        })
      : null;
  function renderEntry(entry: TimeEntry) {
    const limit = capFor(entry),
      editing = edit?.entry.id === entry.id,
      row = fromDraft(entry, person(entry.workerId), date, state, matters);
    return (
      <div key={entry.id}>
        <div
          role="row"
          data-time-row={entry.id}
          className={"bo-grid-row" + (selected === entry.id ? " bo-row-selected" : "")}
          aria-selected={selected === entry.id}
          onClick={() => setSelected(entry.id)}
          onFocus={(event) => {
            if (!(event.target instanceof HTMLInputElement && event.target.type === "checkbox"))
              setSelected(entry.id);
          }}
        >
          <div className="bo-check-cell">
            <input
              type="checkbox"
              aria-label={t("timesheets.ledger.select_row", { name: entry.narrative })}
              checked={selected === entry.id}
              onClick={(event) => event.stopPropagation()}
              onChange={(e) => setSelected(e.currentTarget.checked ? entry.id : "")}
            />
          </div>
          {editing && edit
            ? editors(entry.id, edit.values)
            : columns.map((column) => (
                <div
                  key={column}
                  role="gridcell"
                  tabIndex={0}
                  className="bo-grid-cell bo-time-value"
                  data-column={column}
                  title={String(row[column])}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      startEdit(entry, column);
                    }
                  }}
                  onClick={() => startEdit(entry, column)}
                >
                  {showValue(entry, column, row)}
                </div>
              ))}
          <div role="gridcell" className="bo-grid-cell bo-time-state">
            {limit !== null && (
              <span
                className="bo-time-cap-icon"
                title={t("timesheets.ledger.cap_review", { minutes: limit })}
              >
                <AlertTriangle
                  size={13}
                  aria-label={t("timesheets.ledger.cap_review", { minutes: limit })}
                />
              </span>
            )}
            {editing ? (
              <>
                <span>{busy ? t("projects.saving") : t("timesheets.ledger.editing")}</span>
                <button
                  aria-label={t("timesheets.ledger.cancel")}
                  onClick={() => {
                    setEdit(null);
                    setError("");
                  }}
                >
                  <X size={14} />
                </button>
              </>
            ) : canEdit && entry.status === "pending" ? (
              <>
                <button
                  disabled={busy}
                  title={t("timesheets.ledger.by", { name: person(entry.authorId) })}
                  onClick={() =>
                    void run({
                      type: "confirm",
                      entries: [{ id: entry.id, revision: entry.revision }],
                    })
                  }
                >
                  {t("timesheets.ledger.confirm")}
                </button>
                <button
                  disabled={busy}
                  aria-label={t("timesheets.ledger.decline")}
                  onClick={() =>
                    void run({
                      type: "decline",
                      entries: [{ id: entry.id, revision: entry.revision }],
                    })
                  }
                >
                  <X size={13} />
                </button>
              </>
            ) : (
              <span>{t(entryStatusKeys[entry.status])}</span>
            )}
            {canEdit && <button type="button" title={t("timesheets.ledger.duplicate")} aria-label={t("timesheets.ledger.duplicate")}
              disabled={busy} onClick={() => pasteEntry(entry)}><CopyPlus size={13} /></button>}
            <button
              type="button"
              aria-expanded={history === entry.id}
              aria-label={t("timesheets.ledger.history")}
              onClick={() => setHistory(history === entry.id ? "" : entry.id)}
            >
              <History size={12} />
            </button>
          </div>
        </div>
        {history === entry.id && (
          <>
            {onOriginal &&
              entry.workerId === state.userId &&
              entry.source === "suggestion" &&
              entry.proposalDigest && (
                <PrivateOriginal key={entry.proposalDigest} entry={entry} load={onOriginal} />
              )}
            {changes(entry, person, locale)}
            {canEdit &&
              entry.workerId === state.userId &&
              ["approved", "invoiced"].includes(entry.status) && (
                <AdjustmentRequest entry={entry} adjustments={state.adjustments ?? []} submit={run} />
              )}
            <Link
              className="bo-time-original"
              to={"/back-office/timeEntries?record=" + encodeURIComponent(entry.id)}
            >
              {t("timesheets.ledger.signed_history")}
            </Link>
          </>
        )}
      </div>
    );
  }
  const showComposer = canEdit && (composerOpen || draftChanged || provenance);
  return (
    <div
      ref={host}
      style={{ ...layout, width: "100%" }}
      className="bo-record-grid bo-time-ledger"
      onCopy={clipboardCopy}
      onPaste={clipboardPaste}
    >
      <div className="bo-view-toolbar bo-time-toolbar">
        {!capture && <><TimesheetPeriodSwitch period={period} onChange={value => {
          if (edit) return setError(t("timesheets.ledger.finish_edit"));
                setPeriod(value);
        }} />
        <div className="bo-time-date">
          <button
            type="button"
            title={t("timesheets.ledger.previous")}
            aria-label={t("timesheets.ledger.previous")}
            onClick={() => chooseDate(adjacentPeriod(date, period, -1))}
          >
            <ChevronLeft size={14} />
          </button>
          <input
            type="date"
            aria-label={t("timesheets.ledger.period_date")}
            value={date}
            onChange={(e) => chooseDate(e.currentTarget.value)}
          />
          <button
            type="button"
            title={t("timesheets.ledger.next")}
            aria-label={t("timesheets.ledger.next")}
            onClick={() => chooseDate(adjacentPeriod(date, period, 1))}
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <button type="button" onClick={() => chooseDate(offsetDate(localDate(new Date()), -1))}>
          {t("timesheets.ledger.yesterday")}
        </button>
        <button type="button" onClick={() => chooseDate(localDate(new Date()))}>
          {t("timesheets.ledger.today")}
        </button>
        </>}
        <div className="bo-view-actions">
          {columnChooser}
          {canEdit && !!ready.length && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              startIcon={<Send size={13} />}
              onClick={async () => {
                if (edit || draftChanged || provenance) {
                  setError(t("timesheets.ledger.finish_edit"));
                  return;
                }
                if (await run({
                  type: "submit",
                  entries: ready.map(e => ({ id: e.id, revision: e.revision })),
                })) setNotice(t("timesheets.ledger.submitted"));
              }}
            >
              {t("timesheets.ledger.submit")}
            </Button>
          )}
        </div>
      </div>
      <TimesheetWeekTotals dates={dates} date={date} totalsByDate={byDate} onDateChange={day => chooseDate(day, true)} />
      <div className="bo-time-totals" aria-label={t("timesheets.ledger.totals")}>
        {[
          [t("timesheets.ledger.worked_total"), totals.worked],
          [t("timesheets.ledger.charge_total"), totals.charge],
        ].map(([key, value]) => (
          <span key={key}>
            {key} <b>{duration(Number(value))} h</b>
          </span>
        ))}
      </div>
      {activeCap !== null && (
        <div className="bo-time-cap" role="status">
          <AlertTriangle size={13} />
          {t("timesheets.ledger.cap_review", { minutes: activeCap })}
        </div>
      )}
      {(error || privateConflict) && (
        <div className="bo-error" role="alert">
          {error}
          {privateConflict && <>
            <div>{t("back_office.conflict.saved")}</div>
            {rowColumns.filter(column => Object.hasOwn(differentTimeValues(privateBases.current.get(requestId)?.values ?? {}, workflowDraftValues(draft)), column))
              .map(column => <div key={column}>{t(ledgerColumnKeys[column])} · {String(privateConflict.values[column] ?? "—")}</div>)}
            <Button type="button" size="sm" variant="outline" onClick={() => resolvePrivateConflict(false)}>{t("back_office.conflict.keep")}</Button>{" "}
            <Button type="button" size="sm" variant="outline" onClick={() => resolvePrivateConflict(true)}>{t("back_office.conflict.apply")}</Button>
          </>}
          {privateConflict === null && <Button type="button" size="sm" variant="outline" onClick={() => void resetComposer()}>
            {t("timesheets.sheet.edit_discard")}</Button>}
        </div>
      )}
      <div role="grid" aria-label={t("timesheets.ledger.title")} className="bo-grid-scroll bo-time-scroll">
        <div role="row" className="bo-grid-header">
          <div role="columnheader" className="bo-check-cell">
            <span className="sr-only">{t("timesheets.ledger.select")}</span>
          </div>
          {columns.map((column) => (
            <div
              role="columnheader"
              className="bo-grid-heading"
              key={column}
              title={t(ledgerColumnKeys[column])}
            >
              {t(ledgerColumnKeys[column])}
            </div>
          ))}
          <div role="columnheader" className="bo-grid-heading">
            {t("timesheets.ledger.status")}
          </div>
        </div>
        {countedRows.filter(entry => !bookings.some(item => item.id === entry.groupId)).map(renderEntry)}
        {canEdit && !showComposer && <Button size="sm" variant="ghost" className="time-new-entry" startIcon={<Plus size={14} />} onClick={() => focus("new", "matter")}>
          {t("timesheets.ledger.new")}
        </Button>}
        {showComposer && (
          <div role="row" className="bo-grid-row bo-time-new" data-time-row="new">
            <div className="bo-check-cell" title={t("timesheets.ledger.new")}>
              <button
                type="button"
                aria-label={t("timesheets.ledger.new")}
                onClick={() => focus("new", "matter")}
              >
                <Plus size={15} />
              </button>
            </div>
            {editors("new", draft)}
            <div role="gridcell" className="bo-grid-cell">
              {busy && <span>{t("projects.saving")}</span>}
              {!busy && draftChanged && <Button type="button" size="sm" variant="ghost" onClick={() => void save("new")}>
                {t("timeWorkspace.bookEntry")}
              </Button>}
              {(draftChanged || draft.activity || draft.narrative || draft.worked || provenance) && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("timesheets.ledger.cancel")}
                  onClick={resetComposer}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        {showComposer && (
          <div className="bo-time-participants">
            {participants.map((item) => (
              <div
                className="bo-time-participant"
                key={item.key}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    event.target instanceof HTMLInputElement &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void save("new");
                  }
                }}
              >
                <label>
                  {t("timesheets.ledger.workers")}
                  <select
                    aria-label={t("timesheets.ledger.workers")}
                    disabled={busy}
                    value={item.workerId}
                    onChange={(e) => {
                      const workerId = e.currentTarget.value;
                      setParticipants((items) =>
                        items.map((p) => (p.key === item.key ? { ...p, workerId } : p)),
                      );
                    }}
                  >
                    <option value="">{t("timesheets.pick_person")}</option>
                    {people.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                {(["billableWork", "nonBillable", "charge"] as const).map((field) => (
                  <label key={field}>
                    {t(ledgerColumnKeys[field])}
                    <input
                      disabled={busy}
                      readOnly={field === "charge" && !participantAmounts(item.amounts).billable}
                      inputMode="numeric"
                      placeholder="0"
                      value={field === "charge" && !participantAmounts(item.amounts).billable ? "0" : participantAmounts(item.amounts)[field]}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setParticipants((items) =>
                          items.map((p) =>
                            p.key === item.key
                              ? {
                                  ...p,
                                  amounts: changeAmounts(participantAmounts(p.amounts), field, value, policyFor(draft),
                                    stopwatchDraft ? (amounts) => stopwatchCharge({ ...draft, ...amounts }) : undefined),
                                }
                              : p,
                          ),
                        );
                      }}
                    />
                  </label>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t("timesheets.remove_person")}
                  onClick={() => setParticipants((items) => items.filter((p) => p.key !== item.key))}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {people.length > 1 && participants.length < people.length - 1 && (
              <button
                type="button"
                className="bo-time-add-person"
                disabled={busy}
                onClick={() => {
                  reveal("workers");
                  setDraftChanged(true);
                  const candidates = people.filter(
                    (p) =>
                      !draft.workers.split(" + ").includes(p.label) &&
                      !participants.some((item) => item.workerId === p.id),
                  );
                  setParticipants((items) => [
                    ...items,
                    { key: crypto.randomUUID(), workerId: candidates.length === 1 ? candidates[0].id : "" },
                  ]);
                }}
              >
                <UserRoundPlus size={14} />
                {t("timesheets.add_person")}
              </button>
            )}
          </div>
        )}
        {receipt(item => {
          const created = countedRows.filter(entry => entry.groupId === item.id);
          return created.length ? created.map(renderEntry) : undefined;
        }, item => state.entries.find(entry => entry.groupId === item.id && entry.workerId === state.userId)?.date ?? item.date)}
        {awaitingConfirmation.length > 0 && <details className="bo-time-delegated">
          <summary>{t("timeWorkspace.awaitingConfirmation")}</summary>
          {awaitingConfirmation.map(renderEntry)}
        </details>}
      </div>
      {delegated.length > 0 && (
        <details className="bo-time-delegated">
          <summary>
            {t("timesheets.delegated")} <span>{delegated.length}</span>
          </summary>
          <small>{t("timesheets.delegated_hint")}</small>
          <ul>
            {delegated.map((entry) => (
              <li key={entry.id}>
                <time>{entry.date}</time>
                <strong>{person(entry.workerId)}</strong>
                <span>{entry.narrative}</span>
                <span>
                  {entry.workedMinutes - nonBillableWork(entry)} / {nonBillableWork(entry)} min
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {notice && <div className="bo-time-footer" role="status">{notice}</div>}
    </div>
  );
}
