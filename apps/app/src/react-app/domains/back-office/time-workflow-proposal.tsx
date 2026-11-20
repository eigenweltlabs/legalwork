import { useId, useRef, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import type { BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, type CaptureAction, type CaptureProposal } from "@legalwork/types/time-capture";
import {
  timeActivities, proposedCharge, resolveTimePolicy, type TimesheetCommand, type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import {
  fromDraft, matchMatter, matterOptions, workerOptions, productOptions, parseRow, changeAmounts,
  rowColumns, stopwatchRowCharge, type RowColumn, type RowValues,
} from "./timesheet-row";
import { ledgerColumnKeys, sourceKeys } from "./timesheet-labels";
import { timeRecordDate } from "./time-record-values";
import type { TimeCaptureSheet } from "./time-record-sheet";

export function TimeWorkflowProposal({ proposal, state, columns, capture, onCommand, canEdit }: {
  proposal: CaptureProposal;
  state: TimesheetState;
  columns: RowColumn[];
  capture: TimeCaptureSheet;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
  canEdit: boolean;
}) {
  const id = useId(), host = useRef<HTMLDivElement>(null);
  const matters = matterOptions(state), people = workerOptions(state);
  const project = state.projects.find(project => project.id === proposal.projectId);
  const matter = state.matters.find(matter => matter.id === proposal.matterId)
    ?? (project?.matterIds.length === 1 ? state.matters.find(matter => matter.id === project.matterIds[0]) : undefined);
  const clientId = matter?.clientIds.length === 1 ? matter.clientIds[0] : "";
  const stopwatch = proposal.source === "stopwatch";
  const duration = captureChargeMinutes(proposal);
  function policyFor(values: RowValues) {
    const assigned = matchMatter(matters, values.matter);
    return resolveTimePolicy(state.policies, assigned?.clientId ?? "", assigned?.matterId ?? "",
      values.date, assigned ? assigned.projectId : project?.id);
  }
  const [edited, setValues] = useState<RowValues>(() => {
    const policy = resolveTimePolicy(state.policies, clientId, matter?.id ?? "", proposal.date, project?.id);
    const initial = fromDraft({
      date: proposal.date, activity: proposal.activity, projectId: project?.id, matterId: matter?.id, clientId,
      narrative: stopwatch && !proposal.parentDigest ? "" : proposal.narrative,
      workedMinutes: proposal.workedMinutes ?? undefined,
      billableMinutes: duration === null || stopwatch ? undefined : proposedCharge(duration, policy),
    }, people.find(person => person.id === state.userId)?.label ?? "", proposal.date, state, matters);
    const saved = capture.drafts[proposal.key];
    if (saved?.proposalDigest !== proposal.digest || !saved.values.workflow) return initial;
    const result = { ...initial };
    for (const column of rowColumns) if (typeof saved.values[column] === "string") result[column] = saved.values[column];
    if (typeof saved.values.billable === "boolean") result.billable = saved.values.billable;
    if (stopwatch) {
      result.manualCharge = typeof saved.values.manualCharge === "boolean"
        ? saved.values.manualCharge
        : Boolean(result.charge && Number(result.charge) !== stopwatchRowCharge(proposal, result, policy));
    }
    return result;
  });
  const [changed, setChanged] = useState(false);
  const suggestion = !changed && capture.drafts[proposal.key]?.proposalDigest !== proposal.digest ? capture.wording?.[proposal.digest] : undefined;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const queue = useRef(Promise.resolve());
  const policy = policyFor(edited);
  const charge = stopwatch ? stopwatchRowCharge(proposal, edited, policy) : null;
  const values = charge !== null && !edited.manualCharge && Number.isFinite(charge)
    ? { ...edited, charge: edited.worked || (duration !== null && proposal.workedMinutes === null) ? String(charge) : "" }
    : suggestion ? { ...edited, ...suggestion } : edited;
  const conflict = capture.overlaps.has(proposal.key);
  const selectedMatter = matchMatter(matters, values.matter);
  const selectedWorker = people.find(person => person.label.toLocaleLowerCase() === values.workers.trim().toLocaleLowerCase());

  function saveFields() {
    const fields: Record<string, BackOfficeValue> = {
      workflow: true, billable: values.billable,
      matterId: selectedMatter?.matterId ?? null, workerId: selectedWorker?.id ?? null,
    };
    if (stopwatch) fields.manualCharge = Boolean(values.manualCharge);
    for (const column of rowColumns) fields[column] = values[column];
    return capture.act({ type: "draft", key: proposal.key, date: proposal.date, proposalDigest: proposal.digest, values: fields });
  }
  function privateSave() {
    if (!changed || !canEdit || !capture.privateAvailable || inFlight.current) return;
    queue.current = queue.current.then(async () => {
      if (!await saveFields()) setError(t("back_office.save_failed"));
    });
  }
  async function run(action: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setBusy(true);
    try {
      await queue.current;
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("back_office.save_failed"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function accept() {
    if (!canEdit || conflict || inFlight.current) return;
    const parsed = parseRow(values, state);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    await run(async () => {
      const entry = parsed.entry;
      if (entry.date === values.date && entry.workedMinutes === proposal.workedMinutes && proposal.startAt && proposal.endAt) {
        entry.startAt = proposal.startAt;
        entry.endAt = proposal.endAt;
      }
      await onCommand({
        type: "create", requestId: proposal.key, source: "suggestion", proposalDigest: proposal.digest,
        entry, workerIds: parsed.workerIds,
      });
      await capture.act({ type: "draft", key: proposal.key, values: null });
    });
  }
  const choices: Partial<Record<RowColumn, string[]>> = {
    matter: matters.map(matter => matter.label),
    workers: people.map(person => person.label),
    product: productOptions(state, selectedMatter?.matterId).map(product => product.label),
    activity: Object.keys({ ...timeActivities, ...policy.activityLabels }),
  };
  const linkMatter = selectedMatter?.matterId;
  const entriesById = new Map(state.entries.map(entry => [entry.id, entry]));
  const matches = linkMatter && selectedWorker?.id === state.userId ? capture.linkableRecords?.filter(record => {
    const entry = entriesById.get(record.id);
    return entry
      ? entry.workerId === state.userId && entry.status !== "declined" && entry.status !== "pending"
        && entry.matterId === linkMatter && entry.date === values.date
      : record.values.matter === linkMatter && timeRecordDate(record.values.startedAt, record.values.serviceDate) === values.date;
  }) ?? [] : [];
  function updateSource(action: CaptureAction) {
    void run(async () => {
      if (action.type === "reconcile" && !await saveFields()) return;
      await capture.act(action);
    });
  }

  return (
    <div ref={host} className="time-workflow-proposal">
      <div role="row" className="bo-grid-row" data-time-proposal={proposal.key}>
        <div className="bo-check-cell time-proposal-actions">
          <button type="button" aria-label={t("timesheets.sheet.accept")}
            title={t(conflict ? "timesheets.workday.overlap" : "timesheets.sheet.accept")}
            disabled={busy || !canEdit || conflict} onClick={() => void accept()}><Check size={14} /></button>
          <button type="button" aria-label={t("timesheets.sheet.decline")} title={t("timesheets.sheet.decline")}
            disabled={busy} onClick={() => updateSource({ type: "dismiss", key: proposal.key })}><X size={14} /></button>
        </div>
        {columns.map((column, index) => (
          <div className="bo-grid-cell bo-time-input-cell" role="gridcell" key={column}>
            <input aria-label={t(ledgerColumnKeys[column])} data-column={column}
              value={column === "charge" && !values.billable ? "0" : values[column]}
              type={column === "date" ? "date" : "text"} disabled={!canEdit || busy}
              readOnly={column === "charge" && !values.billable} list={choices[column] ? id + column : undefined}
              onChange={event => {
                const value = event.target.value;
                setChanged(true);
                setValues(current => {
                  const previous = suggestion ? { ...current, ...suggestion } : current;
                  if (column === "worked" || column === "billableWork" || column === "nonBillable" || column === "charge") {
                    const effective = policyFor(previous);
                    return { ...previous, ...changeAmounts(previous, column, value, effective,
                      stopwatch ? amounts => stopwatchRowCharge(proposal, amounts, effective) : undefined) };
                  }
                  if (column === "matter" && previous.matter !== value) return { ...previous, matter: value, product: "" };
                  return { ...previous, [column]: value };
                });
              }}
              onBlur={privateSave}
              onKeyDown={event => {
                if (event.key === "Tab") {
                  const next = index + (event.shiftKey ? -1 : 1);
                  if (next >= 0 && next < columns.length) {
                    event.preventDefault();
                    host.current?.querySelector<HTMLInputElement>(`[data-column="${columns[next]}"]`)?.focus();
                  }
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void accept();
                }
              }}
            />
            {choices[column] && <datalist id={id + column}>{choices[column]?.map(value => <option key={value} value={value} />)}</datalist>}
          </div>
        ))}
        <div className="bo-grid-cell"><span>{t("timesheets.ai_tab")}</span></div>
      </div>
      <div className="time-proposal-details time-workflow-source">
        <button type="button" className="time-proposal-source" onClick={() => capture.openSource(proposal)}>
          <Sparkles size={13} />{t("timesheets.sheet.because", { source: t(sourceKeys[proposal.source]) })}
          {proposal.workedMinutes !== null && " · " + proposal.workedMinutes + " min"}{project && " · " + project.name}
        </button>
        {conflict && <>
          <span>{t("timesheets.workday.overlap")}</span>
          <button type="button" className="time-proposal-source" onClick={() => capture.openSource(proposal)}>{t("timesheets.workday.correct")}</button>
        </>}
        {matches.length > 0 && <select aria-label={t("timesheets.sheet.reconcile")} value="" disabled={busy || !canEdit}
          onChange={event => {
            const match = matches.find(record => record.id === event.target.value);
            if (match) updateSource({ type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: match.id, recordRevision: match.revision });
          }}>
          <option value="">{t("timesheets.sheet.reconcile")}</option>
          {matches.map(record => <option key={record.id} value={record.id}>
            {String(record.values.billingNarrative || record.values.name)} · {String(record.values.recordedMinutes)} min
          </option>)}
        </select>}
        {error && <span className="bo-error" role="alert">{error}</span>}
      </div>
    </div>
  );
}
