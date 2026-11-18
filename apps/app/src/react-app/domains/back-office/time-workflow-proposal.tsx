import { useId, useRef, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import type { BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, type CaptureProposal } from "@legalwork/types/time-capture";
import { timeActivities, proposedCharge, proposedStopwatchCharge, resolveTimePolicy, type TimesheetCommand, type TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import { fromDraft, matterOptions, workerOptions, productOptions, parseRow, changeAmounts, rowColumns, type RowColumn, type RowValues } from "./timesheet-row";
import { ledgerColumnKeys, sourceKeys } from "./timesheet-labels";
import type { TimeCaptureSheet } from "./time-record-sheet";

export function TimeWorkflowProposal({ proposal, state, columns, capture, onCommand, canEdit }: {
  proposal: CaptureProposal; state: TimesheetState; columns: RowColumn[]; capture: TimeCaptureSheet;
  onCommand: (command: TimesheetCommand) => Promise<unknown>; canEdit: boolean;
}) {
  const id = useId(), host = useRef<HTMLDivElement>(null);
  const matters = matterOptions(state), people = workerOptions(state);
  const project = state.projects.find(project => project.id === proposal.projectId);
  const matter = state.matters.find(matter => matter.id === proposal.matterId)
    ?? (project?.matterIds.length === 1 ? state.matters.find(matter => matter.id === project.matterIds[0]) : undefined);
  const clientId = matter?.clientIds.length === 1 ? matter.clientIds[0] : "";
  const policy = resolveTimePolicy(state.policies, clientId, matter?.id ?? "", proposal.date, project?.id);
  const duration = captureChargeMinutes(proposal);
  const [values, setValues] = useState<RowValues>(() => {
    const initial = fromDraft({ date: proposal.date, activity: proposal.activity, projectId: project?.id, matterId: matter?.id, clientId,
      narrative: proposal.source === "stopwatch" && !proposal.parentDigest ? "" : proposal.narrative,
      workedMinutes: proposal.workedMinutes ?? undefined,
      billableMinutes: duration === null ? undefined : proposal.source === "stopwatch" ? proposedStopwatchCharge(duration, policy) : proposedCharge(duration, policy),
    }, people.find(person => person.id === state.userId)?.label ?? "", proposal.date, state, matters);
    const saved = capture.drafts[proposal.key]?.values;
    if (!saved?.workflow) return initial;
    const result = { ...initial };
    for (const column of rowColumns) if (typeof saved[column] === "string") result[column] = saved[column];
    if (typeof saved.billable === "boolean") result.billable = saved.billable;
    return result;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queue = useRef(Promise.resolve());
  const privateSave = () => {
    const fields: Record<string, BackOfficeValue> = { workflow: true, billable: values.billable };
    for (const column of rowColumns) fields[column] = values[column];
    queue.current = queue.current.then(async () => {
      if (!await capture.act({ type: "draft", key: proposal.key, proposalDigest: proposal.digest, values: fields })) setError(t("back_office.save_failed"));
    });
  };
  async function accept() {
    const parsed = parseRow(values, state);
    if ("error" in parsed) { setError(parsed.error); return; }
    setError(""); setBusy(true);
    try {
      await queue.current;
      const entry = parsed.entry;
      if (entry.date === proposal.date && entry.workedMinutes === proposal.workedMinutes && proposal.startAt && proposal.endAt) {
        entry.startAt = proposal.startAt; entry.endAt = proposal.endAt;
      }
      await onCommand({ type: "create", requestId: proposal.key, source: "suggestion", proposalDigest: proposal.digest, entry, workerIds: parsed.workerIds });
      await capture.act({ type: "draft", key: proposal.key, values: null });
    } catch (error) { setError(error instanceof Error ? error.message : t("back_office.save_failed")); }
    finally { setBusy(false); }
  }
  const selectedMatter = matters.find(matter => matter.label === values.matter);
  const choices: Partial<Record<RowColumn, string[]>> = {
    matter: matters.map(matter => matter.label), workers: people.map(person => person.label),
    product: productOptions(state, selectedMatter?.matterId).map(product => product.label),
    activity: Object.keys({ ...timeActivities, ...policy.activityLabels }),
  };
  return <div ref={host} className="time-workflow-proposal">
    <div role="row" className="bo-grid-row" data-time-proposal={proposal.key}>
      <div className="bo-check-cell time-proposal-actions"><button aria-label={t("timesheets.sheet.accept")} title={t("timesheets.sheet.accept")} disabled={busy || !canEdit} onClick={() => void accept()}><Check size={14} /></button><button aria-label={t("timesheets.sheet.decline")} title={t("timesheets.sheet.decline")} disabled={busy} onClick={() => void capture.act({ type: "dismiss", key: proposal.key })}><X size={14} /></button></div>
      {columns.map((column, index) => <div className="bo-grid-cell bo-time-input-cell" role="gridcell" key={column}>
        <input aria-label={t(ledgerColumnKeys[column])} data-column={column} value={values[column]} type={column === "date" ? "date" : "text"} disabled={!canEdit || busy} list={choices[column] ? id + column : undefined}
          onChange={event => {
            const value = event.target.value;
            setValues(previous => column === "worked" || column === "billableWork" || column === "nonBillable" || column === "charge"
              ? { ...previous, ...changeAmounts(previous, column, value, policy) } : { ...previous, [column]: value });
          }}
          onBlur={privateSave}
          onKeyDown={event => {
            if (event.key === "Tab") {
              const next = index + (event.shiftKey ? -1 : 1);
              if (next >= 0 && next < columns.length) { event.preventDefault(); host.current?.querySelector<HTMLInputElement>(`[data-column="${columns[next]}"]`)?.focus(); }
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void accept(); }
          }} />
        {choices[column] && <datalist id={id + column}>{choices[column]?.map(value => <option key={value} value={value} />)}</datalist>}
      </div>)}
      <div className="bo-grid-cell"><span>{t("timesheets.ai_tab")}</span></div>
    </div>
    <div className="time-proposal-details time-workflow-source"><button className="time-proposal-source" onClick={() => capture.openSource(proposal)}><Sparkles size={13} />{t("timesheets.sheet.because", { source: t(sourceKeys[proposal.source]) })}{proposal.workedMinutes !== null && " · " + proposal.workedMinutes + " min"}{project && " · " + project.name}</button>{error && <span className="bo-error" role="alert">{error}</span>}</div>
  </div>;
}
