import { Link } from "react-router-dom";
import { useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
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
  X,
} from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import {
  proposedCharge,
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
import "./timesheet-ledger.css";

export type InitialTimesheetDraft = {
  key: string;
  entry: Partial<TimeDraft>;
  source?: "suggestion";
  proposalDigest?: string;
};
type OriginalProposal = Pick<
  CaptureProposal,
  "date" | "activity" | "narrative" | "workedMinutes" | "digest"
>;

type Props = {
  state: TimesheetState;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
  initialDraft?: InitialTimesheetDraft;
  initialDate?: string;
  onOriginal?: (digest: string) => Promise<OriginalProposal>;
  canEdit?: boolean;
};
type Edit = { entry: TimeEntry; values: RowValues };
const label = (key: string) => t("timesheets.ledger." + key);
function changes(entry: TimeEntry, person: (id: string) => string, locale: string) {
  return (
    <ol className="bo-time-history">
      {entry.history.map((event) => (
        <li key={event.revision}>
          <b>{person(event.actorId)}</b> · {new Date(event.at).toLocaleString(locale)} ·{" "}
          {label("event." + event.action)}
          {event.before &&
            (Object.keys(event.after) as (keyof typeof event.after)[])
              .filter((key) => event.before?.[key] !== event.after[key])
              .map((key) => (
                <div key={key}>
                  {label("change." + key)} · <del>{String(event.before?.[key] ?? "—")}</del> →{" "}
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
  const first = entry.history.find((event) => event.before === null)?.after;
  if (!entry.proposalDigest) return null;
  const digest = entry.proposalDigest;
  async function open() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const proposal = await load(digest);
      if (proposal.digest !== digest) throw Error(label("original_unavailable"));
      setOriginal(proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : label("original_unavailable"));
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="bo-time-original">
      {original ? (
        <dl>
          <div>
            <dt>{label("original")}</dt>
            <dd>
              {original.date} · {original.activity} · {original.narrative} ·{" "}
              {original.workedMinutes === null
                ? label("unknown_minutes")
                : duration(original.workedMinutes) + " h"}
            </dd>
          </div>
          {first && (
            <div>
              <dt>{label("first_saved")}</dt>
              <dd>
                {first.date} · {first.activity} · {first.narrative} · {duration(first.workedMinutes)} h
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => void open()}>
          {label("compare_original")}
        </Button>
      )}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}

export function TimesheetLedger({
  state,
  onCommand,
  initialDraft,
  initialDate,
  canEdit = true,
  onOriginal,
}: Props) {
  const locale = useLocale();
  const uid = useId();
  const host = useRef<HTMLDivElement>(null);
  const matters = useMemo(() => matterOptions(state), [state.matters, state.clients, state.projects]);
  const people = useMemo(() => workerOptions(state), [state.people, state.userId, locale]);
  const person = (id: string) => people.find((p) => p.id === id)?.label ?? id;
  const [date, setDate] = useState(initialDraft?.entry.date ?? initialDate ?? localDate(new Date()));
  const [period, setPeriod] = useState<"day" | "week">("day");
  function capFor(
    entry: Pick<
      TimeDraft,
      "clientId" | "matterId" | "projectId" | "date" | "activity" | "billableMinutes"
    >,
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
  const [draft, setDraft] = useState(() =>
    fromDraft(initialDraft?.entry ?? {}, own, date, state, matters),
  );
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
  const week = weekDates(date);
  const rows = state.entries
    .filter(
      (e) =>
        e.workerId === state.userId &&
        e.status !== "declined" &&
        (period === "day" ? e.date === date : e.date >= week[0] && e.date <= week[6]),
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const totals = rows
    .filter((row) => row.status !== "pending")
    .reduce(
      (sum, row) => {
        sum.worked += row.workedMinutes;
        sum.billable += row.billable ? row.workedMinutes : 0;
        sum.charge += row.billableMinutes;
        return sum;
      },
      { worked: 0, billable: 0, charge: 0 },
    );
  const ready = rows.filter((e) => e.status === "confirmed");
  const copied = rows.find((e) => e.id === selected);
  const focus = (row: string, column: RowColumn) =>
    requestAnimationFrame(() => {
      const element = host.current?.querySelector<HTMLInputElement>(
        `[data-time-row="${CSS.escape(row)}"] [data-column="${column}"]`,
      );
      if (!element) return;
      element.focus();
      if (element.tagName === "INPUT" && element.type === "text") element.select();
    });
  function chooseDate(next: string) {
    if (!next) return;
    if (edit) {
      setError(label("finish_edit"));
      return;
    }
    setDate(next);
    setDraft((current) => (current.date === date ? { ...current, date: next } : current));
    setSelected("");
    setHistory("");
  }
  function field(row: string, key: RowColumn, value: string | boolean) {
    const update = (current: RowValues) => {
      const next = { ...current, [key]: value };
      if (key === "worked" && typeof value === "string") {
        const matter = matters.find((m) => m.label === current.matter);
        const policy = resolveTimePolicy(
          state.policies,
          matter?.clientId ?? "",
          matter?.matterId ?? "",
          current.date,
          matter?.projectId,
        );
        const autoCharge = (input: string) =>
          /^\d+$/.test(input) ? String(proposedCharge(Number(input), policy)) : input;
        if (!current.charge || current.charge === autoCharge(current.worked))
          next.charge = autoCharge(value);
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
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onCommand(command);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : label("failed"));
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function save(row: string, nextFocus = true, tabToNext = false) {
    if (!canEdit || pending.current) return false;
    if (row === "new" && edit) {
      setError(label("finish_edit"));
      return false;
    }
    const current = row === "new" ? draft : edit?.values;
    if (!current) return false;
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
      const command: TimesheetCommand = {
        type: "create",
        requestId,
        entry,
        workerIds,
        ...(provenance ? { source: provenance, proposalDigest: initialDraft?.proposalDigest } : {}),
      };
      if (!(await run(command))) return false;
      setRequestId(crypto.randomUUID());
      setProvenance(undefined);
      setDraftChanged(false);
      setDate(entry.date);
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
      if (!(await run({ type: "update", id: edit.entry.id, revision: edit.entry.revision, entry })))
        return false;
      setEdit(null);
      if (nextFocus && tabToNext) {
        const next = rows
          .slice(rows.findIndex((entry) => entry.id === row) + 1)
          .find((entry) => ["pending", "confirmed", "submitted"].includes(entry.status));
        if (next) {
          setEdit({ entry: next, values: fromDraft(next, person(next.workerId), date, state, matters) });
          setSelected(next.id);
        }
        focus(next?.id ?? "new", "matter");
      } else if (nextFocus) focus(row, "narrative");
    }
    const limit = capFor(entry);
    setNotice(limit === null ? label("saved") : t("timesheets.ledger.cap_review", { minutes: limit }));
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
      setEdit({ entry: row, values: fromDraft(row, person(row.workerId), date, state, matters) });
      setSelected(row.id);
      setError("");
      setNotice(row.status === "submitted" ? label("reopens") : "");
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
      setError(label("unfinished"));
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
    setNotice(label("pasted"));
  }
  function resetComposer() {
    setDraftChanged(false);
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
    setNotice(label("copied"));
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
      (event.key === "Tab" && !event.shiftKey && column === "billable")
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
    const activityName = (code: string) => catalog[code] || label("activity." + code);
    const choices: Partial<Record<RowColumn, string[]>> = {
      matter: matters.map((m) => m.label),
      workers: people.map((p) => p.label),
      activity: Object.keys({ ...timeActivities, ...catalog }),
      product: values.createProduct
        ? []
        : productOptions(state, localMatter?.matterId).map((p) => p.label),
    };
    const workerPrefix = values.workers.includes(" + ")
      ? values.workers.slice(0, values.workers.lastIndexOf(" + ") + 3)
      : "";
    return rowColumns.map((column) => {
      const value = values[column],
        list = choices[column];
      return (
        <div role="gridcell" className="bo-grid-cell bo-time-input-cell" key={column}>
          {column === "billable" ? (
            <input
              data-column={column}
              aria-label={label(column)}
              type="checkbox"
              checked={values.billable}
              disabled={busy}
              onChange={(e) => field(row, column, e.currentTarget.checked)}
              onKeyDown={(e) => onKey(e, row, column)}
            />
          ) : (
            <input
              data-column={column}
              aria-label={label(column)}
              type={column === "date" ? "date" : "text"}
              disabled={
                busy ||
                (column === "workers" && row !== "new") ||
                (column === "charge" && !values.billable)
              }
              title={column === "workers" ? label("worker_hint") : undefined}
              autoComplete="off"
              placeholder={
                column === "product" && values.createProduct
                  ? label("new_product_title")
                  : label("placeholder." + column)
              }
              value={String(column === "charge" && !values.billable ? "0" : value)}
              list={list ? uid + row + column : undefined}
              inputMode={column === "charge" || column === "worked" ? "numeric" : undefined}
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
          )}
          {column === "product" && (
            <button
              type="button"
              className="bo-time-new-product"
              aria-label={label("new_product")}
              title={label("new_product")}
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
              ? label("activity." + entry.activity)
              : entry.activity)
          }
        >
          {entry.activity}
        </span>
      );
    if (column === "billable")
      return entry.billable ? (
        <Check size={13} aria-label={label("billable")} />
      ) : (
        <span aria-label={label("nonbillable")}>–</span>
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
      className="bo-record-grid bo-time-ledger"
      onCopy={clipboardCopy}
      onPaste={clipboardPaste}
    >
      <div className="bo-view-toolbar bo-time-toolbar">
        <select
          aria-label={label("period")}
          value={period}
          onChange={(e) =>
            edit ? setError(label("finish_edit")) : setPeriod(e.target.value === "week" ? "week" : "day")
          }
        >
          <option value="day">{label("day")}</option>
          <option value="week">{label("week")}</option>
        </select>
        <button
          type="button"
          title={label("previous")}
          aria-label={label("previous")}
          onClick={() => chooseDate(offsetDate(date, period === "day" ? -1 : -7))}
        >
          <ChevronLeft size={14} />
        </button>
        <input
          type="date"
          aria-label={label("period_date")}
          value={date}
          onChange={(e) => chooseDate(e.currentTarget.value)}
        />
        <button
          type="button"
          title={label("next")}
          aria-label={label("next")}
          onClick={() => chooseDate(offsetDate(date, period === "day" ? 1 : 7))}
        >
          <ChevronRight size={14} />
        </button>
        <button type="button" onClick={() => chooseDate(offsetDate(localDate(new Date()), -1))}>
          {label("yesterday")}
        </button>
        <button type="button" onClick={() => chooseDate(localDate(new Date()))}>
          {label("today")}
        </button>
        <div className="bo-view-actions">
          {copied && (
            <>
              <Button
                variant="ghost"
                size="sm"
                startIcon={<ClipboardCopy size={14} />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(encodeTimeRow(copied).plain);
                    setNotice(label("copied"));
                  } catch {
                    setError(label("use_shortcut"));
                  }
                }}
              >
                {label("copy")}
              </Button>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  startIcon={<CopyPlus size={14} />}
                  onClick={() => pasteEntry(copied)}
                >
                  {label("duplicate")}
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
                if (edit) {
                  setError(label("finish_edit"));
                  return;
                }
                if (
                  await run({
                    type: "submit",
                    entries: ready.map((e) => ({ id: e.id, revision: e.revision })),
                  })
                )
                  setNotice(label("submitted"));
              }}
            >
              {label("submit")}
            </Button>
          )}
        </div>
      </div>
      <div className="bo-time-totals" aria-label={label("totals")}>
        {[
          [label("worked_total"), totals.worked],
          [label("billable"), totals.billable],
          [label("nonbillable"), totals.worked - totals.billable],
          [label("charge_total"), totals.charge],
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
      <div role="grid" aria-label={label("title")} className="bo-grid-scroll bo-time-scroll">
        <div role="row" className="bo-grid-header">
          <div role="columnheader" className="bo-check-cell">
            <span className="sr-only">{label("select")}</span>
          </div>
          {rowColumns.map((column) => (
            <div role="columnheader" className="bo-grid-heading" key={column}>
              {label(column)}
            </div>
          ))}
          <div role="columnheader" className="bo-grid-heading">
            {label("status")}
          </div>
        </div>
        {canEdit && (
          <div role="row" className="bo-grid-row bo-time-new" data-time-row="new">
            <div className="bo-check-cell" title={label("new")}>
              <Plus size={13} />
            </div>
            {editors("new", draft)}
            <div role="gridcell" className="bo-grid-cell">
              <button type="button" disabled={busy} onClick={() => void save("new")}>
                {label("book")}
              </button>
              {(draftChanged || draft.activity || draft.narrative || draft.worked || provenance) && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={label("cancel")}
                  onClick={resetComposer}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}
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
                  : rowColumns.map((column) => (
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
                      <button aria-label={label("save")} onClick={() => void save(entry.id)}>
                        <Check size={14} />
                      </button>
                      <button
                        aria-label={label("cancel")}
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
                        {label("confirm")}
                      </button>
                      <button
                        disabled={busy}
                        aria-label={label("decline")}
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
                    <span>{label("status." + entry.status)}</span>
                  )}
                  <button
                    type="button"
                    aria-expanded={history === entry.id}
                    aria-label={label("history")}
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
                      <AdjustmentRequest
                        entry={entry}
                        adjustments={state.adjustments ?? []}
                        submit={run}
                      />
                    )}
                  <Link
                    className="bo-time-original"
                    to={"/back-office/timeEntries?record=" + encodeURIComponent(entry.id)}
                  >
                    {label("signed_history")}
                  </Link>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="bo-time-footer">
        {canEdit && <span>{label("keyboard")}</span>}
        <span role="status">{notice}</span>
      </div>
    </div>
  );
}
