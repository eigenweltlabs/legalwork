import { draftRules } from "@legalwork/types/time-capture";
import { TimeEntryInput, useTimeDurationFormat } from "./time-duration-controls";
import { formatTimeDuration, isTimeAmountColumn } from "./time-duration";
import { Textarea } from "@/components/ui/textarea";
import { TimeSelect } from "./time-settings-controls";
import { useId, useRef, useState } from "react";
import { isUntitledStopwatch, proposalAssignment } from "./time-record-values";
import { Button } from "@/components/ui/button";
import { ProposalDecisionReceiver, TimeProposalActions } from "./time-proposal-actions";
import type { BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, type CaptureAction, type CaptureProposal, type PrivateBookingRevision } from "@legalwork/types/time-capture";
import {
  proposedCharge, resolveTimePolicy, type TimesheetCommand, type TimesheetState,
} from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import {
  fromDraft, matchMatter, matterOptions, workerOptions, productOptions, parseRow, changeAmounts,
  rowColumns, stopwatchRowCharge, type RowColumn, type RowValues,
} from "./timesheet-row";
import { activityOptions, ledgerColumnKeys } from "./timesheet-labels";
import { timeRecordDate } from "./time-record-values";
import type { TimeCaptureSheet } from "./time-record-sheet";
import { differentTimeValues, privateDraftConflict } from "./time-record-edits";

export function TimeWorkflowProposal({ proposal, state, capture, onCommand, canEdit }: {
  proposal: CaptureProposal;
  state: TimesheetState;
  capture: TimeCaptureSheet;
  onCommand: (command: TimesheetCommand, draft?: PrivateBookingRevision) => Promise<unknown>;
  canEdit: boolean;
}) {
  const id = useId();
  const durationFormat = useTimeDurationFormat();
  const directory = proposal.source === "stopwatch" ? { ...state, projects: [] } : state;
  const matters = matterOptions(directory), worker = workerOptions(state).find(person => person.id === state.userId);
  const { project, matter, clientId, policy: initialPolicy } = proposalAssignment(proposal, state);
  const stopwatch = proposal.source === "stopwatch";
  const duration = captureChargeMinutes(proposal);
  function policyFor(values: RowValues) {
    const assigned = matchMatter(matters, values.matter);
    return resolveTimePolicy(state.policies, assigned?.clientId ?? "", assigned?.matterId ?? "",
      values.date, assigned ? assigned.projectId : project?.id);
  }
  function timerCharge(values: RowValues) {
    const assigned = matchMatter(matters, values.matter);
    const matter = state.matters.find(item => item.id === assigned?.matterId);
    const rules = matter ? draftRules(state, capture.guidelines ?? [], matter, values.date, assigned?.projectId, assigned?.clientId) : undefined;
    return stopwatchRowCharge(proposal, values, policyFor(values), rules, values.activity);
  }
  function applyDraftFields(initial: RowValues, values: Record<string, BackOfficeValue>) {
    const result = { ...initial };
    for (const column of rowColumns) {
      if (column !== "date" && column !== "workers" && typeof values[column] === "string") result[column] = values[column];
    }
    if (values.productId === null || typeof values.productId === "string") result.productId = values.productId ?? undefined;
    if (typeof values.billable === "boolean") result.billable = values.billable;
    if (stopwatch) {
      result.manualCharge = typeof values.manualCharge === "boolean" ? values.manualCharge
        : Boolean(result.charge && Number(result.charge) !== timerCharge(result));
    }
    return result;
  }
  const [edited, setValues] = useState<RowValues>(() => {
    const initial = fromDraft({
      date: proposal.date, activity: proposal.activity, projectId: project?.id, matterId: matter?.id, clientId,
      narrative: isUntitledStopwatch(proposal) ? "" : proposal.narrative,
      workedMinutes: proposal.workedMinutes ?? proposal.estimatedMinutes,
      billableMinutes: duration === null || stopwatch ? undefined : proposal.chargeMinutes ?? proposedCharge(duration, initialPolicy),
      workProductId: state.products.find(product =>
        product.id === (proposal.workProductId ?? proposal.documentId) && product.matterId === matter?.id)?.id,
    }, worker?.label ?? "", proposal.date, state, matters);
    const saved = capture.drafts[proposal.key];
    return saved?.proposalDigest === proposal.digest && saved.values.workflow ? applyDraftFields(initial, saved.values) : initial;
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
    ? (unchangedTimer && !capture.guidelines?.length ? proposal.chargeMinutes : undefined) ?? timerCharge(edited)
    : null;
  const values = charge !== null && !edited.manualCharge && Number.isFinite(charge)
    ? { ...edited, charge: edited.worked || (duration !== null && proposal.workedMinutes === null) ? String(charge) : "" }
    : suggestion ? { ...edited, ...suggestion } : edited;
  const selectedMatter = matchMatter(matters, values.matter);
  const fields: RowColumn[] = state.supportsTimeAllocations
    ? ["matter", "activity", "product", "narrative", "worked", "billableWork", "nonBillable", "charge"]
    : ["matter", "activity", "product", "narrative", "worked", "charge"];

  function serialize(values: RowValues) {
    const fields: Record<string, BackOfficeValue> = {
      workflow: true, billable: values.billable,
      matterId: matchMatter(matters, values.matter)?.matterId ?? null, workerId: state.userId, productId: values.productId ?? null,
    };
    if (stopwatch) fields.manualCharge = Boolean(values.manualCharge);
    for (const column of rowColumns) fields[column] = values[column];
    return fields;
  }
  const current = useRef(values);
  current.current = values;
  const baseline = useRef({ revision: capture.drafts[proposal.key]?.revision ?? 0, values: serialize(values) });
  const [savedConflict, setSavedConflict] = useState<ReturnType<typeof privateDraftConflict>>();

  async function saveFields(revision = baseline.current.revision) {
    const fields = serialize(current.current);
    if (!capture.writeDraft)
      return capture.act({ type: "draft", key: proposal.key, date: proposal.date, proposalDigest: proposal.digest, values: fields });
    try {
      const saved = await capture.writeDraft({ type: "draft-patch", key: proposal.key, date: proposal.date, proposalDigest: proposal.digest,
        revision, initial: fields, changes: differentTimeValues(baseline.current.values, fields) });
      if (!saved) throw new Error(t("back_office.save_failed"));
      const acknowledged = applyDraftFields(current.current, saved.values);
      const newer = differentTimeValues(fields, serialize(current.current));
      baseline.current = { revision: saved.revision ?? 0, values: serialize(acknowledged) };
      const merged = applyDraftFields(acknowledged, newer);
      current.current = merged;
      setValues(merged);
      setSavedConflict(undefined);
      setError("");
      return true;
    } catch (error) {
      setSavedConflict(privateDraftConflict(error));
      setError(error instanceof Error ? error.message : t("back_office.save_failed"));
      return false;
    }
  }
  function privateSave() {
    if (!changed || !canEdit || !capture.privateAvailable || inFlight.current) return;
    queue.current = queue.current.then(async () => {
      if (!await saveFields() && !capture.writeDraft) setError(t("back_office.save_failed"));
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
      const collision = privateDraftConflict(error);
      if (collision !== undefined) setSavedConflict(collision);
      setError(error instanceof Error ? error.message : t("back_office.save_failed"));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function accept() {
    if (!canEdit || inFlight.current) return false;
    const reviewed = serialize(current.current);
    return run(async () => {
      if (capture.writeDraft && !await saveFields()) return false;
      if (Object.keys(differentTimeValues(reviewed, serialize(current.current))).length) {
        setError(t("timesheets.sheet.edit_suggestion_changed"));
        return false;
      }
      const parsed = parseRow(current.current, directory);
      if ("error" in parsed) {
        setError(parsed.error);
        return false;
      }
      const entry = parsed.entry;
      if (entry.date === proposal.date && entry.workedMinutes === proposal.workedMinutes && proposal.startAt && proposal.endAt) {
        entry.startAt = proposal.startAt;
        entry.endAt = proposal.endAt;
      }
      await onCommand({
        type: "create", requestId: proposal.key, source: "suggestion", proposalDigest: proposal.digest,
        entry, workerIds: parsed.workerIds,
      }, capture.writeDraft ? { date: proposal.date, revision: baseline.current.revision } : undefined);
      return true;
    });
  }
  const choices: Partial<Record<RowColumn, string[]>> = {
    product: productOptions(state, selectedMatter?.matterId).map(product => product.label),
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
    const reviewed = serialize(current.current);
    return run(async () => {
      if (action.type === "reconcile") {
        if (!await saveFields()) return false;
        if (Object.keys(differentTimeValues(reviewed, serialize(current.current))).length) {
          setError(t("timesheets.sheet.edit_suggestion_changed"));
          return false;
        }
        if (capture.writeDraft) return capture.act({ ...action, draftRevision: baseline.current.revision });
      }
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
        <label key={column} onBlur={column === "matter" || column === "activity" ? privateSave : undefined}>
          {t(ledgerColumnKeys[column])}
          {column === "worked" && proposal.estimatedMinutes != null && proposal.workedMinutes == null &&
            <small className="text-muted-foreground">{t("timeWorkspace.estimatedMinutes", { minutes: proposal.estimatedMinutes })}{proposal.estimateReason && " · " + proposal.estimateReason}</small>}
          {column === "narrative"
            ? <Textarea rows={3} maxLength={2000} data-column={column} value={values.narrative} disabled={!canEdit || busy}
                onChange={event => change(column, event.currentTarget.value)} onBlur={privateSave} />
            : column === "activity"
            ? <TimeSelect label={t(ledgerColumnKeys.activity)} value={values.activity} disabled={!canEdit || busy}
                options={[{ id: "", name: t("timeWorkspace.noActivity") }, ...activityOptions(policy.activityLabels, values.activity)]}
                onChange={value => { change(column, value); }} />
            : column === "matter"
            ? <TimeSelect label={t(ledgerColumnKeys.matter)} value={values.matter} placeholder={t("timesheets.workday.choose")}
                disabled={!canEdit || busy} options={matters.filter(item => !item.clientId || state.matters.find(m => m.id === item.matterId)?.clientIds.length === 1 || item.label === values.matter)
                  .map(({ label }) => ({ id: label, name: label }))}
                onChange={value => change(column, value)} />
            : <TimeEntryInput duration={isTimeAmountColumn(column)} data-column={column} value={column === "charge" && !values.billable ? "0" : values[column]}
                disabled={!canEdit || busy} readOnly={column === "charge" && !values.billable}
                list={choices[column] ? id + column : undefined}
                onValueChange={value => change(column, value)} onBlur={privateSave} />}
          {choices[column] && <datalist id={id + column}>{choices[column]?.map(value => <option key={value} value={value} />)}</datalist>}
        </label>
      ))}
      {error && <div role="alert">{error}
        {savedConflict ? <>
          <dl>{rowColumns.filter(field => Object.hasOwn(differentTimeValues(serialize(values), savedConflict.values), field)).map(field => <div key={field}>
            <dt>{t(ledgerColumnKeys[field])} · {t("back_office.conflict.saved")}</dt>
            <dd>{String(savedConflict.values[field] ?? "∅")}</dd>
          </div>)}</dl>
          <Button type="button" variant="outline" size="xs" onClick={() => {
            const restored = applyDraftFields(current.current, savedConflict.values);
            baseline.current = { revision: savedConflict.revision ?? 0, values: serialize(restored) };
            current.current = restored;
            setValues(restored);
            setSavedConflict(undefined);
            setError("");
          }}>{t("back_office.conflict.keep")}</Button>
          <Button type="button" variant="outline" size="xs" onClick={() => void run(() => saveFields(savedConflict.revision ?? 0))}>
            {t("back_office.conflict.apply")}
          </Button>
        </> : <Button type="button" variant="outline" size="xs" onClick={() => void run(() => saveFields())}>{t("timesheets.retry")}</Button>}
      </div>}
      {matches.length > 0 && <label>{t("timesheets.sheet.reconcile")}
        <TimeSelect label={t("timesheets.sheet.reconcile")} value="" disabled={!canEdit || busy} placeholder={t("timeWorkspace.chooseRecorded")}
          options={matches.map(record => ({ id: record.id, name: String(record.values.billingNarrative || record.values.name) + " · " + formatTimeDuration(Number(record.values.recordedMinutes), durationFormat) }))}
          onChange={id => {
            const match = matches.find(record => record.id === id);
            if (match) updateSource({ type: "reconcile", key: proposal.key, digest: proposal.digest, recordId: match.id, recordRevision: match.revision });
          }} />
      </label>}
      <div className="time-workspace-actions">
        <TimeProposalActions busy={busy} canAccept={canEdit} onDismiss={() => void dismiss()} />
        <Button type="button" size="sm" variant="outline" disabled={busy}
          onClick={() => void run(async () => {
            const reviewed = current.current;
            const selected = matchMatter(matters, reviewed.matter);
            const unchangedAssignment = selected?.matterId === matter?.id && selected?.projectId === project?.id;
            capture.openSource({ ...proposal,
              ...(unchangedAssignment ? {} : { matterId: selected?.matterId, projectId: selected?.projectId ?? null }),
              workProductId: reviewed.productId, activity: reviewed.activity, narrative: reviewed.narrative || proposal.narrative,
            }, capture.drafts[proposal.key] || baseline.current.revision > 0 ? baseline.current.revision : undefined);
            return true;
          })}>{t("common.edit")}</Button>
      </div>
    </form>
  );
}
