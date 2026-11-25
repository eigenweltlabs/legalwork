import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { History, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import type { BackOfficeRecord } from "@legalwork/types/back-office";
import { hasTimeEntryPrice, resolveTimePolicy,  timeEntryPrice, timePolicyError, type TimeEntry, type TimesheetCommand, type TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordHistorySidebar } from "./history-panel";
import { RecordGrid, type SaveBackOfficeView } from "./record-grid";
import { TimeEntryInput } from "./time-duration-controls";

type ReviewCommand = Extract<TimesheetCommand, { type: "review" | "approve" | "return" }>;

export function FirmTimeReview({ client, state, directory, dates, onCommand, columnScope, onSaveView, reviewEntryId }: {
  client: LegalworkServerClient;
  state: TimesheetState;
  directory: BackOfficeState;
  dates: readonly string[];
  onCommand: (command: TimesheetCommand) => Promise<TimesheetState>;
  columnScope: string;
  onSaveView: SaveBackOfficeView;
  reviewEntryId: string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const billableErrorId = useId();
  const navigate = useNavigate();
  const [, setParams] = useSearchParams();
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<{ entry: TimeEntry; narrative: string; minutes: string; reason: string }>();
  const [returning, setReturning] = useState(false);
  const [pendingAction, setPendingAction] = useState<ReviewCommand["type"]>();
  const busy = Boolean(pendingAction);
  const [error, setError] = useState("");
  const timeObject = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);

  const pending = state.entries.filter(entry =>
    entry.status === "submitted" && entry.workerId !== state.userId && dates.includes(entry.date) &&
    resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId).reviewerId === state.userId);
  const entries = new Map(pending.map(entry => [entry.id, entry]));
  const requestedEntry = reviewEntryId ? entries.get(reviewEntryId) : undefined;
  const openReview = useCallback((entry: TimeEntry) => {
    setEditing({ entry, narrative: entry.narrative, minutes: String(entry.billableMinutes), reason: "" });
    setError("");
    setReturning(false);
    setShowHistory(false);
  }, []);
  useEffect(() => {
    if (!reviewEntryId || !timeObject) return;
    if (requestedEntry) openReview(requestedEntry);
    else toast.error(t("timesheets.review_entry_unavailable"));
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete("reviewEntry");
      return next;
    }, { replace: true });
  }, [reviewEntryId, requestedEntry, timeObject, openReview, setParams]);
  if (!timeObject) return <p role="status">{t("timesheets.unavailable")}</p>;

  const labeled = displayBackOfficeObject(timeObject);
  const columns = ["startedAt", "timekeeper", "matter", "name", "recordedMinutes", "billableMinutes"];
  const object = {
    ...labeled, fields: columns.flatMap(id => {
      const field = labeled.fields.find(item => item.id === id);
      if (!field) return [];
      if (id === "startedAt") return [{ ...field, type: "date" as const, label: t("timesheets.ledger.date") }];
      if (id === "name") return [{ ...field, label: t("timesheets.ledger.narrative") }];
      if (id === "matter" || id === "timekeeper") return [{ ...field, type: "text" as const }];
      return [field];
    }),
  };
  const rows: BackOfficeRecord[] = pending.map(entry => ({
    id: entry.id, objectId: "timeEntries", ownerId: entry.workerId, revision: entry.revision,
    schemaRevision: directory.model.revision, access: "members", members: [state.userId], sourceId: undefined,
    archivedAt: null, createdAt: entry.history.at(-1)?.at ?? entry.date + "T00:00:00Z",
    updatedAt: entry.history.at(-1)?.at ?? entry.date + "T00:00:00Z",
    values: {
      name: entry.narrative, startedAt: entry.date,
      matter: state.matters.find(matter => matter.id === entry.matterId)?.name ?? "",
      timekeeper: state.people.find(person => person.id === entry.workerId)?.name ?? "",
      recordedMinutes: entry.workedMinutes, billableMinutes: entry.billableMinutes,
    },
  }));
  async function run(command: ReviewCommand, done: (next: TimesheetState) => void) {
    setPendingAction(command.type === "review" && command.approve ? "approve" : command.type);
    setError("");
    try {
      done(await onCommand(command));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPendingAction(undefined);
    }
  }
  const policyFor = (entry: TimeEntry) => resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId);
  function approvalError(entry: TimeEntry) {
    const policy = policyFor(entry);
    const policyError = timePolicyError(entry, policy);
    if (policyError || !entry.billable) return policyError;
    if (!entry.clientId) return t("timesheets.sheet.choose_bill_to");
    return policy.nonHourlyAgreement || hasTimeEntryPrice(timeEntryPrice(policy, entry.workerId))
      ? "" : t("back_office.billing.price_missing");
  }
  const target = editing?.entry;
  const stale = target && entries.get(target.id)?.revision !== target.revision;
  const minutes = editing && editing.minutes.trim() !== "" ? Number(editing.minutes) : NaN;
  const changed = editing && (editing.narrative.trim() !== target?.narrative || minutes !== target?.billableMinutes);
  const blocked = busy || stale;
  const proposal = editing && target ? { ...target, narrative: editing.narrative.trim(), billableMinutes: minutes } : undefined;
  const billableError = proposal ? Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440
    ? timePolicyError(proposal, policyFor(proposal)) : t("back_office.billing.invalid_minutes") : "";
  const editCommand = editing && target && proposal ? {
    type: "review" as const, id: target.id, revision: target.revision,
    narrative: proposal.narrative, billableMinutes: minutes, reason: editing.reason.trim() || undefined,
  } : undefined;
  const canSave = !blocked && Boolean(proposal?.narrative) && !billableError;
  const approvalProblem = proposal && !billableError ? approvalError(proposal) : "";
  const historyEntry = showHistory && target ? entries.get(target.id) : undefined;
  return <div className="@container/time-history relative isolate flex min-h-0 min-w-0 flex-1">
    <div ref={container} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
    {rows.length ? <RecordGrid object={object} records={rows} views={[]} finance userId={state.userId}
      editable={false} archived={false} lockedSchema openOnRowClick columnScope={columnScope}
      onSave={async () => {}} onCreate={() => {}} onSaveView={onSaveView}
      onOpen={record => {
        const entry = entries.get(record.id);
        if (entry) openReview(entry);
      }}
      selectionActions={(records, clear) => <Button size="sm" disabled={busy || records.some(record => approvalError(entries.get(record.id)!))}
        aria-busy={pendingAction === "approve"}
        onClick={() => void run({ type: "approve", entries: records.map(({ id, revision }) => ({ id, revision })) }, clear)}>
        {pendingAction === "approve" && <Loader2 className="animate-spin" />}{t("back_office.billing.approve")}
      </Button>}
    /> : <p className="m-4 text-sm text-muted-foreground" role="status">{t("timesheets.review_empty")}</p>}
    {!editing && error && <p className="m-3 text-sm text-destructive" role="alert">{error}</p>}
    <Dialog open={Boolean(editing)} modal={false} disablePointerDismissal={Boolean(historyEntry)} onOpenChange={(open, details) => {
      if (!open && !busy && details.reason !== "focus-out") setEditing(undefined);
    }}>
      {editing && target && <ItemDialogContent container={container} className="max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] gap-4 overflow-auto p-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("back_office.billing.detail")}</DialogTitle>
          <DialogDescription>{state.people.find(person => person.id === target.workerId)?.name} · {target.date}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="grid gap-1 text-sm">{t("timesheets.ledger.narrative")}
            <Textarea value={editing.narrative} rows={3} maxLength={2000} readOnly={busy}
              onChange={e => setEditing({ ...editing, narrative: e.target.value })} />
          </label>
          <div className="space-y-1">
            <label className="grid gap-1 text-sm">{t("timesheets.ledger.billable")}
              <TimeEntryInput value={editing.minutes} readOnly={busy} aria-invalid={Boolean(billableError)}
                aria-describedby={billableError ? billableErrorId : undefined} onValueChange={minutes => setEditing({ ...editing, minutes })} />
            </label>
            {billableError && <p id={billableErrorId} className="text-sm text-destructive">{billableError}</p>}
          </div>
          {!returning && target.suggestion && target.suggestion !== editing.narrative && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">{t("back_office.billing.suggestion")}</p>
              <p className="text-sm">{target.suggestion}</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ ...editing, narrative: target.suggestion ?? editing.narrative })}>
                {t("back_office.billing.apply")}
              </Button>
            </div>
          )}
          {(returning || (changed && minutes !== target.billableMinutes)) && <label className="grid gap-1 text-sm">
            {t(returning ? "back_office.billing.return_reason" : "timesheets.review_change_reason")}
            <Input value={editing.reason} readOnly={busy} maxLength={2000} onChange={e => setEditing({ ...editing, reason: e.target.value })} />
          </label>}
          {approvalProblem && <p className="text-sm text-destructive">{approvalProblem}</p>}
          {(error || stale) && <p role="alert" className="text-sm text-destructive">{error || t("back_office.conflict.title")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" className="mr-auto" disabled={stale} aria-expanded={Boolean(historyEntry)}
              onClick={() => setShowHistory(open => !open)}>
              <History size={14} />{t("timesheets.ledger.history")}
            </Button>
            <Button size="sm" variant="outline" disabled={blocked} aria-busy={pendingAction === "return"}
              onClick={() => {
                if (!returning) setReturning(true);
                else void run({ type: "return", entries: [{ id: target.id, revision: target.revision }], reason: editing.reason.trim() || undefined }, () => setEditing(undefined));
              }}>
              {pendingAction === "return" && <Loader2 className="animate-spin" />}{t("back_office.billing.return")}
            </Button>
            {changed && editCommand && <Button size="sm" variant="outline" disabled={!canSave} aria-busy={pendingAction === "review"}
              onClick={() => void run(editCommand, next => {
                const saved = next.entries.find(entry => entry.id === target.id);
                setEditing(saved ? { entry: saved, narrative: saved.narrative, minutes: String(saved.billableMinutes), reason: "" } : undefined);
              })}>
              {pendingAction === "review" && <Loader2 className="animate-spin" />}{t("timesheets.save_review")}
            </Button>}
            <Button size="sm" disabled={!canSave || Boolean(approvalProblem)} aria-busy={pendingAction === "approve"}
              onClick={() => void run(changed && editCommand ? { ...editCommand, approve: true } :
                { type: "approve", entries: [{ id: target.id, revision: target.revision }] }, () => setEditing(undefined))}>
              {pendingAction === "approve" && <Loader2 className="animate-spin" />}{t("timesheets.review_approve")}
            </Button>
          </div>
        </div>
      </ItemDialogContent>}
    </Dialog>
    </div>
    {historyEntry && <RecordHistorySidebar client={client} directory={directory} record={historyEntry}
      onClose={() => setShowHistory(false)}
      onOpen={record => navigate("/back-office/" + record.objectId + "?record=" + record.id)} />}
  </div>;
}
