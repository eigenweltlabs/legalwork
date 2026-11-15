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
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
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
  matterOptions,
  offsetDate,
  parseRow,
  productOptions,
  rowColumns,
  weekDates,
  workerOptions,
  type RowColumn,
  type RowValues,
} from "./timesheet-row";
import { AdjustmentRequest } from "./timesheet-adjustment";
import { useTimesheetColumns } from "./timesheet-columns";
import "./timesheet-ledger.css";

export type InitialTimesheetDraft = {
  key: string;
  entry: Partial<TimeDraft>;
  source?: "suggestion";
  proposalDigest?: string;
};
type OriginalProposal = Pick<CaptureProposal, "date" | "activity" | "narrative" | "workedMinutes" | "digest">;

type Props = {
  state: TimesheetState;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
  initialDraft?: InitialTimesheetDraft;
  onDiscardProposal?: () => void;
  initialDate?: string;
  onDateChange?: (date: string) => void;
  columnScope?: string;
  onEditingChange?: (dirty: boolean) => void;
  onOriginal?: (digest: string) => Promise<OriginalProposal>;
  canEdit?: boolean;
};
type Edit = { entry: TimeEntry; initial: RowValues; values: RowValues };
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
  consent,
}: {
  entry: TimeEntry;
  consent?: { checked: boolean; onChange: (checked: boolean) => void };
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
              {!consent && original.date + " · "}
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
          {consent && (
            <div>
              <dt>{t("timesheets.ledger.submitting")}</dt>
              <dd>
                {entry.activity} · {entry.narrative} · {duration(entry.workedMinutes)} h
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void open()}>
          {t("timesheets.ledger.compare_original")}
        </Button>
      )}
      {original && consent && (
        <label>
          <input
            type="checkbox"
            checked={consent.checked}
            onChange={(e) => consent.onChange(e.currentTarget.checked)}
          />
          {t("timesheets.ledger.share_comparison")}
        </label>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function TimesheetLedger({
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
  const person = (id: string) => people.find((p) => p.id === id)?.label ?? id;
  const [date, setDate] = useState(initialDraft?.entry.date ?? initialDate ?? localDate(new Date()));
  const [period, setPeriod] = useState<"day" | "week">("day");
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
  const [draft, setDraft] = useState(() => fromDraft(initialDraft?.entry ?? {}, own, date, state, matters));
  const [draftChanged, setDraftChanged] = useState(false);
  const [requestId, setRequestId] = useState(() => initialDraft?.key ?? crypto.randomUUID());
  const [provenance, setProvenance] = useState(initialDraft?.source);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [selected, setSelected] = useState("");
  const [history, setHistory] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [shareRevisions, setShareRevisions] = useState(new Map<string, number>());
  const editing = Boolean(edit || draftChanged || provenance);
  useEffect(() => onEditingChange?.(editing), [editing, onEditingChange]);
  const week = weekDates(date);
  const rows = state.entries
    .filter(
      (e) =>
        e.workerId === state.userId &&
        e.status !== "declined" &&
        (period === "day" ? e.date === date : e.date >= week[0] && e.date <= week[6]),
    )
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.history[0]?.at ?? "").localeCompare(b.history[0]?.at ?? "") ||
        a.id.localeCompare(b.id),
    );
  const totals = rows
    .filter((row) => row.status !== "pending")
    .reduce(
      (sum, row) => {
        sum.worked += row.workedMinutes;
        sum.billable += row.workedMinutes - nonBillableWork(row);
        sum.charge += row.billableMinutes;
        return sum;
      },
      { worked: 0, billable: 0, charge: 0 },
    );
  const delegated = (state.delegatedEntries ?? []).filter((e) =>
    period === "day" ? e.date === date : e.date >= week[0] && e.date <= week[6],
  );
  const ready = rows.filter((e) => e.status === "confirmed");
  const shareable = ready.filter(
    (e) => e.source === "suggestion" && e.authorId === state.userId && e.proposalDigest && e.groupId,
  );
  const copied = rows.find((e) => e.id === selected);
  const focus = (row: string, column: RowColumn) => {
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
  function chooseDate(next: string) {
    if (!next || next === date) return;
    if (edit || draftChanged || provenance) {
      setError(t("timesheets.ledger.finish_edit"));
      return;
    }
    setDate(next);
    onDateChange?.(next);
    setShareRevisions(new Map());
    setDraft((current) => (current.date === date ? { ...current, date: next } : current));
    setSelected("");
    setHistory("");
  }
  function policyFor(values: RowValues) {
    const matter = matters.find((m) => m.label === values.matter);
    return resolveTimePolicy(
      state.policies,
      matter?.clientId ?? "",
      matter?.matterId ?? "",
      values.date,
      matter?.projectId,
    );
  }
  function field(row: string, key: RowColumn, value: string) {
    const update = (current: RowValues) => {
      const next = { ...current, [key]: value };
      if (key === "worked" || key === "billableWork" || key === "nonBillable" || key === "charge") {
        return { ...current, ...changeAmounts(current, key, value, policyFor(current)) };
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
      return next;
    };
    if (row === "new") {
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
      await onCommand(command);
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
  async function save(row: string, nextFocus = true, tabToNext = false) {
    if (!canEdit || pending.current) return false;
    if (row === "new" && edit) {
      setError(t("timesheets.ledger.finish_edit"));
      return false;
    }
    const current = row === "new" ? draft : edit?.values;
    if (!current) return false;
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
    const result = parseRow(current, state);
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
        const parsed = parseRow({ ...current, ...participant.amounts, workers: worker.label }, state);
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
      setRequestId(crypto.randomUUID());
      setProvenance(undefined);
      setDraftChanged(false);
      setParticipants([]);
      setDate(entry.date);
      onDateChange?.(entry.date);
      setDraft(
        emptyRow(
          entry.date,
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
  function resetComposer() {
    if (provenance) onDiscardProposal?.();
    setDraftChanged(false);
    setParticipants([]);
    setDraft(emptyRow(date, own));
    setRequestId(crypto.randomUUID());
    setProvenance(undefined);
    setError("");
    setNotice("");
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
    } else if (
      event.key === "Enter" ||
      (event.key === "Tab" && !event.shiftKey && column === columns[columns.length - 1])
    ) {
      event.preventDefault();
      void save(row, true, event.key === "Tab");
    }
  }
  function editors(row: string, values: RowValues) {
    const localMatter =
      matters.find((m) => m.label.toLowerCase() === values.matter.trim().toLowerCase()) ??
      matters.find(
        (m) => values.matter && m.label.toLowerCase().includes(values.matter.trim().toLowerCase()),
      );
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
            readOnly={column === "charge" && !values.billable}
            title={column === "workers" ? t("timesheets.ledger.worker_hint") : undefined}
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
              const query = e.currentTarget.value.trim().toLocaleLowerCase();
              if (!query || !list || list.some((item) => item === e.currentTarget.value)) return;
              const matches = list.filter((choice) => choice.toLocaleLowerCase().includes(query));
              if (
                matches.length === 1 &&
                (column === "matter" ||
                  column === "workers" ||
                  (column === "activity" && matches[0].toLowerCase() === query))
              )
                field(row, column, matches[0]);
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
  return (
    <div
      ref={host}
      style={{ ...layout, width: "100%" }}
      className="bo-record-grid bo-time-ledger"
      onCopy={clipboardCopy}
      onPaste={clipboardPaste}
    >
      <div className="bo-view-toolbar bo-time-toolbar">
        <div className="bo-time-period" role="group" aria-label={t("timesheets.ledger.period")}>
          {(["day", "week"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={value === period}
              onClick={() => {
                if (edit) return setError(t("timesheets.ledger.finish_edit"));
                setShareRevisions(new Map());
                setPeriod(value);
              }}
            >
              {value === "week" ? t("timesheets.ledger.week") : t("timesheets.ledger.day")}
            </button>
          ))}
        </div>
        <div className="bo-time-date">
          <button
            type="button"
            title={t("timesheets.ledger.previous")}
            aria-label={t("timesheets.ledger.previous")}
            onClick={() => chooseDate(offsetDate(date, period === "day" ? -1 : -7))}
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
            onClick={() => chooseDate(offsetDate(date, period === "day" ? 1 : 7))}
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
        <div className="bo-view-actions">
          {columnChooser}
          {copied && (
            <>
              <Button
                variant="ghost"
                size="sm"
                startIcon={<ClipboardCopy size={14} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(encodeTimeRow(copied).plain);
                    setNotice(t("timesheets.ledger.copied"));
                  } catch {
                    setError(t("timesheets.ledger.use_shortcut"));
                  }
                }}
              >
                {t("timesheets.ledger.copy")}
              </Button>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  startIcon={<CopyPlus size={14} />}
                  onClick={() => pasteEntry(copied)}
                >
                  {t("timesheets.ledger.duplicate")}
                </Button>
              )}
            </>
          )}
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
                if (
                  await run({
                    type: "submit",
                    entries: ready.map((e) => ({
                      id: e.id,
                      revision: e.revision,
                      ...(e.proposalDigest && e.groupId && shareRevisions.get(e.id) === e.revision
                        ? { shareOriginal: { key: e.groupId, digest: e.proposalDigest } }
                        : {}),
                    })),
                  })
                ) {
                  setShareRevisions(new Map());
                  setNotice(t("timesheets.ledger.submitted"));
                }
              }}
            >
              {t("timesheets.ledger.submit")}
            </Button>
          )}
        </div>
      </div>
      {canEdit && state.supportsBillingComparisons && onOriginal && shareable.length > 0 && (
        <details className="bo-time-original">
          <summary>{t("timesheets.ledger.submission_comparisons")}</summary>
          {shareable.map((e) => (
            <div key={e.id + ":" + e.revision}>
              <strong>{e.narrative}</strong>
              <PrivateOriginal
                entry={e}
                load={onOriginal}
                consent={{
                  checked: shareRevisions.get(e.id) === e.revision,
                  onChange: (checked) =>
                    setShareRevisions((previous) => {
                      const next = new Map(previous);
                      if (checked) next.set(e.id, e.revision);
                      else next.delete(e.id);
                      return next;
                    }),
                }}
              />
            </div>
          ))}
        </details>
      )}
      <div className="bo-time-totals" aria-label={t("timesheets.ledger.totals")}>
        {[
          [t("timesheets.ledger.worked_total"), totals.worked],
          [t("timesheets.ledger.billable"), totals.billable],
          [t("timesheets.ledger.nonbillable"), totals.worked - totals.billable],
          [t("timesheets.ledger.charge_total"), totals.charge],
        ].map(([key, value]) => (
          <span key={key}>
            {key} <b>{duration(Number(value))} h</b>
          </span>
        ))}
      </div>
      {period === "week" && (
        <div className="bo-time-week">
          {week.map((day) => (
            <button type="button" key={day} aria-pressed={day === date} onClick={() => chooseDate(day)}>
              {new Date(day + "T12:00:00").toLocaleDateString(locale, {
                weekday: "short",
                day: "numeric",
              })}{" "}
              ·{" "}
              {duration(
                rows
                  .filter((e) => e.date === day && e.status !== "pending")
                  .reduce((n, e) => n + e.workedMinutes, 0),
              )}
            </button>
          ))}
        </div>
      )}
      {activeCap !== null && (
        <div className="bo-time-cap" role="status">
          <AlertTriangle size={13} />
          {t("timesheets.ledger.cap_review", { minutes: activeCap })}
        </div>
      )}
      {error && (
        <div className="bo-error" role="alert">
          {error}
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
        {rows.map((entry) => {
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
                      <button aria-label={t("timesheets.ledger.save")} onClick={() => void save(entry.id)}>
                        <Check size={14} />
                      </button>
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
        })}
        {canEdit && (
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
              <button type="button" disabled={busy} onClick={() => void save("new")}>
                {t("timesheets.ledger.book")}
              </button>
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
        {canEdit && (
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
                      readOnly={field === "charge" && !(item.amounts ?? draft).billable}
                      inputMode="numeric"
                      placeholder="0"
                      value={(item.amounts ?? draft)[field]}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setParticipants((items) =>
                          items.map((p) =>
                            p.key === item.key
                              ? {
                                  ...p,
                                  amounts: changeAmounts(p.amounts ?? draft, field, value, policyFor(draft)),
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
      <div className="bo-time-footer">
        {canEdit && <span>{t("timesheets.ledger.keyboard")}</span>}
        <span role="status">{notice}</span>
      </div>
    </div>
  );
}
