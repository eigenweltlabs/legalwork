import { useId, useRef, useState } from "react";
import { isUntitledStopwatch, proposalAssignment } from "./time-record-values";
import { Button } from "@/components/ui/button";
import { ProposalDecisionReceiver, TimeProposalActions } from "./time-proposal-actions";
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
import { ledgerColumnKeys } from "./timesheet-labels";
import { timeRecordDate } from "./time-record-values";
import type { TimeCaptureSheet } from "./time-record-sheet";

export function TimeWorkflowProposal({ proposal, state, capture, onCommand, canEdit }: {
  proposal: CaptureProposal;
  state: TimesheetState;
  capture: TimeCaptureSheet;
  onCommand: (command: TimesheetCommand) => Promise<unknown>;
  canEdit: boolean;
}) {
  const id = useId();
  const matters = matterOptions(state), worker = workerOptions(state).find(person => person.id === state.userId);
  const { project, matter, clientId, policy: initialPolicy } = proposalAssignment(proposal, state);
  const stopwatch = proposal.source === "stopwatch";
  const duration = captureChargeMinutes(proposal);
  function policyFor(values: RowValues) {
    const assigned = matchMatter(matters, values.matter);
    return resolveTimePolicy(state.policies, assigned?.clientId ?? "", assigned?.matterId ?? "",
      values.date, assigned ? assigned.projectId : project?.id);
  }
  const [edited, setValues] = useState<RowValues>(() => {
    const initial = fromDraft({
      date: proposal.date, activity: proposal.activity, projectId: project?.id, matterId: matter?.id, clientId,
      narrative: isUntitledStopwatch(proposal) ? "" : proposal.narrative,
      workedMinutes: proposal.workedMinutes ?? undefined,
      billableMinutes: duration === null || stopwatch ? undefined : proposal.chargeMinutes ?? proposedCharge(duration, initialPolicy),
      workProductId: state.products.find(product =>
        product.id === (proposal.workProductId ?? proposal.documentId) && product.matterId === matter?.id)?.id,
    }, worker?.label ?? "", proposal.date, state, matters);
    const saved = capture.drafts[proposal.key];
    if (saved?.proposalDigest !== proposal.digest || !saved.values.workflow) return initial;
    const result = { ...initial };
    for (const column of rowColumns) {
      if (column !== "date" && column !== "workers" && typeof saved.values[column] === "string") result[column] = saved.values[column];
    }
    if (typeof saved.values.productId === "string") result.productId = saved.values.productId;
    if (typeof saved.values.billable === "boolean") result.billable = saved.values.billable;
    if (stopwatch) {
      result.manualCharge = typeof saved.values.manualCharge === "boolean"
        ? saved.values.manualCharge
        : Boolean(result.charge && Number(result.charge) !== stopwatchRowCharge(proposal, result, policyFor(result)));
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
  const assignment = matchMatter(matters, edited.matter);
  const unchangedTimer = edited.worked === (proposal.workedMinutes?.toString() ?? "") &&
    Number(edited.nonBillable) === 0 && assignment?.matterId === matter?.id &&
    assignment?.projectId === project?.id && (assignment?.clientId ?? "") === clientId;
  const charge = stopwatch
    ? (unchangedTimer ? proposal.chargeMinutes : undefined) ?? stopwatchRowCharge(proposal, edited, policy)
    : null;
  const values = charge !== null && !edited.manualCharge && Number.isFinite(charge)
    ? { ...edited, charge: edited.worked || (duration !== null && proposal.workedMinutes === null) ? String(charge) : "" }
    : suggestion ? { ...edited, ...suggestion } : edited;
  const conflict = capture.overlaps.has(proposal.key);
  const selectedMatter = matchMatter(matters, values.matter);
  const fields: RowColumn[] = state.supportsTimeAllocations
    ? ["matter", "activity", "product", "narrative", "worked", "billableWork", "nonBillable", "charge"]
    : ["matter", "activity", "product", "narrative", "worked", "charge"];

  function saveFields() {
    const fields: Record<string, BackOfficeValue> = {
      workflow: true, billable: values.billable,
      matterId: selectedMatter?.matterId ?? null, workerId: state.userId, productId: values.productId ?? null,
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
  async function run(action: () => Promise<boolean>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setError("");
    setBusy(true);
    try {
      await queue.current;
      return await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : t("back_office.save_failed"));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function accept() {
    if (!canEdit || conflict || inFlight.current) return false;
    const parsed = parseRow(values, state);
    if ("error" in parsed) {
      setError(parsed.error);
      return false;
    }
    return run(async () => {
      const entry = parsed.entry;
      if (entry.date === proposal.date && entry.workedMinutes === proposal.workedMinutes && proposal.startAt && proposal.endAt) {
        entry.startAt = proposal.startAt;
        entry.endAt = proposal.endAt;
      }
      await onCommand({
        type: "create", requestId: proposal.key, source: "suggestion", proposalDigest: proposal.digest,
        entry, workerIds: parsed.workerIds,
      });
      return true;
    });
  }
  const choices: Partial<Record<RowColumn, string[]>> = {
    matter: matters.map(matter => matter.label),
    product: productOptions(state, selectedMatter?.matterId).map(product => product.label),
    activity: Object.keys({ ...timeActivities, ...policy.activityLabels }),
  };
  const linkMatter = selectedMatter?.matterId;
  const entriesById = new Map(state.entries.map(entry => [entry.id, entry]));
  const matches = linkMatter ? capture.linkableRecords?.filter(record => {
    const entry = entriesById.get(record.id);
    return entry
      ? entry.workerId === state.userId && entry.status !== "declined" && entry.status !== "pending"
        && entry.matterId === linkMatter && entry.date === values.date
      : record.values.matter === linkMatter && timeRecordDate(record.values.startedAt, record.values.serviceDate) === values.date;
  }) ?? [] : [];
  function updateSource(action: CaptureAction) {
    return run(async () => {
      if (action.type === "reconcile" && !await saveFields()) return false;
      return capture.act(action);
    });
  }
  const dismiss = () => updateSource({ type: "dismiss", key: proposal.key, digest: proposal.digest });

  function change(column: RowColumn, value: string) {
    setChanged(true);
    setValues(current => {
      const previous = suggestion ? { ...current, ...suggestion } : current;
      if (column === "worked" || column === "billableWork" || column === "nonBillable" || column === "charge") {
        const effective = policyFor(previous);
        return { ...previous, ...changeAmounts(previous, column, value, effective,
          stopwatch ? amounts => stopwatchRowCharge(proposal, amounts, effective) : undefined) };
      }
      if (column === "matter" && previous.matter !== value) {
        const next = { ...previous, matter: value, product: "", productId: undefined };
        if (!stopwatch && previous.billable && Number(previous.charge) === proposedCharge(Number(previous.billableWork), policyFor(previous)))
          next.charge = String(proposedCharge(Number(previous.billableWork), policyFor(next)));
        return next;
      }
      if (column === "product") return { ...previous, product: value,
        productId: productOptions(state, selectedMatter?.matterId).find(product => product.label === value)?.id };
      return { ...previous, [column]: value };
    });
  }

  return (
    <form className="time-workspace-form" data-time-proposal={proposal.key} onSubmit={event => {
      event.preventDefault();
      void accept();
    }}>
      <ProposalDecisionReceiver proposal={proposal} accept={accept} dismiss={dismiss} />
      {fields.map(column => (
        <label key={column}>
          {t(ledgerColumnKeys[column])}
          {column === "narrative"
            ? <textarea rows={3} maxLength={2000} data-column={column} value={values.narrative} disabled={!canEdit || busy}
                onChange={event => change(column, event.currentTarget.value)} onBlur={privateSave} />
            : <input data-column={column} value={column === "charge" && !values.billable ? "0" : values[column]}
                disabled={!canEdit || busy} readOnly={column === "charge" && !values.billable}
                list={choices[column] ? id + column : undefined}
                onChange={event => change(column, event.currentTarget.value)} onBlur={privateSave} />}
          {choices[column] && <datalist id={id + column}>{choices[column]?.map(value => <option key={value} value={value} />)}</datalist>}
        </label>
      ))}
      {conflict && <p role="status">{t("timesheets.workday.overlap")}</p>}
      {error && <p role="alert">{error}</p>}
      {matches.length > 0 && <label>{t("timesheets.sheet.reconcile")}
        <select value="" disabled={!canEdit} aria-disabled={busy || undefined} onChange={event => {
          if (busy) return;
          const match = matches.find(record => record.id === event.target.value);
          if (match) updateSource({ type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: match.id, recordRevision: match.revision });
        }}>
          <option value="">{t("timeWorkspace.chooseRecorded")}</option>
          {matches.map(record => <option key={record.id} value={record.id}>
            {String(record.values.billingNarrative || record.values.name)} · {String(record.values.recordedMinutes)} min
          </option>)}
        </select>
      </label>}
      <div className="time-workspace-actions">
        <TimeProposalActions busy={busy} canAccept={canEdit && !conflict} onDismiss={() => void dismiss()} />
        <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => capture.openSource({ ...proposal,
            matterId: selectedMatter?.matterId, projectId: selectedMatter?.projectId ?? null,
            workProductId: values.productId, activity: values.activity, narrative: values.narrative || proposal.narrative,
          })}>{t("timeWorkspace.editTimes")}</Button>
      </div>
    </form>
  );
}
