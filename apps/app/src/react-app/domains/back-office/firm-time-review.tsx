import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ItemDialogContent } from "@/react-app/design-system/item-detail";
import type { BackOfficeRecord } from "@legalwork/types/back-office";
import { resolveTimePolicy, timePolicyError, type TimeEntry, type TimesheetCommand, type TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";
import type { BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordGrid, type SaveBackOfficeView } from "./record-grid";

export function FirmTimeReview({ state, directory, dates, onCommand, columnScope, onSaveView }: {
  state: TimesheetState;
  directory: BackOfficeState;
  dates: readonly string[];
  onCommand: (command: TimesheetCommand) => Promise<TimesheetState>;
  columnScope: string;
  onSaveView: SaveBackOfficeView;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ entry: TimeEntry; narrative: string; minutes: string; reason: string }>();
  const [returning, setReturning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timeObject = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);
  if (!timeObject) return <p role="status">{t("timesheets.unavailable")}</p>;

  const pending = state.entries.filter(entry =>
    entry.status === "submitted" && entry.workerId !== state.userId && dates.includes(entry.date) &&
    resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId).reviewerId === state.userId);
  const entries = new Map(pending.map(entry => [entry.id, entry]));
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
  async function run(command: TimesheetCommand, done: () => void) {
    setBusy(true);
    setError("");
    try {
      await onCommand(command);
      done();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  function canApprove(entry: TimeEntry) {
    const policy = resolveTimePolicy(state.policies, entry.clientId, entry.matterId, entry.date, entry.projectId);
    return !timePolicyError(entry, policy) &&
      (!entry.billable || (entry.clientId && (policy.nonHourlyAgreement || (entry.hourlyRate !== undefined && entry.currency))));
  }
  const target = editing?.entry;
  const stale = target && entries.get(target.id)?.revision !== target.revision;
  const minutes = editing && editing.minutes.trim() !== "" ? Number(editing.minutes) : NaN;
  const changed = editing && (editing.narrative.trim() !== target?.narrative || minutes !== target?.billableMinutes);
  const blocked = busy || stale;
  return <div ref={container} className="relative isolate min-h-0 flex flex-1 flex-col">
    {rows.length ? <RecordGrid object={object} records={rows} views={[]} finance userId={state.userId}
      editable={false} archived={false} lockedSchema openOnRowClick columnScope={columnScope}
      onSave={async () => {}} onCreate={() => {}} onSaveView={onSaveView}
      onOpen={record => {
        const entry = entries.get(record.id);
        if (entry) {
          setEditing({ entry, narrative: entry.narrative, minutes: String(entry.billableMinutes), reason: "" });
          setError("");
          setReturning(false);
        }
      }}
      selectionActions={(records, clear) => <Button size="sm" disabled={busy || records.some(record => !canApprove(entries.get(record.id)!))}
        onClick={() => void run({ type: "approve", entries: records.map(({ id, revision }) => ({ id, revision })) }, clear)}>
        {t("back_office.billing.approve")}
      </Button>}
    /> : <p className="m-4 text-sm text-muted-foreground" role="status">{t("timesheets.review_empty")}</p>}
    {!editing && error && <p className="m-3 text-sm text-destructive" role="alert">{error}</p>}
    <Dialog open={Boolean(editing)} modal={false} onOpenChange={(open, details) => {
      if (!open && !busy && details.reason !== "focus-out") setEditing(undefined);
    }}>
      {editing && target && <ItemDialogContent container={container} className="max-h-[calc(100%-1rem)] w-[calc(100%-1rem)] gap-4 overflow-auto p-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("back_office.billing.detail")}</DialogTitle>
          <DialogDescription>{state.people.find(person => person.id === target.workerId)?.name} · {target.date}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="grid gap-1 text-sm">{t("timesheets.ledger.narrative")}
            <Textarea value={editing.narrative} rows={3} maxLength={2000}
              onChange={e => setEditing({ ...editing, narrative: e.target.value })} />
          </label>
          <label className="grid gap-1 text-sm">{t("timesheets.ledger.billable")}
            <Input type="number" min={0} max={1440} value={editing.minutes}
              onChange={e => setEditing({ ...editing, minutes: e.target.value })} />
          </label>
          {(returning || (changed && minutes !== target.billableMinutes)) && <label className="grid gap-1 text-sm">
            {t(returning ? "back_office.billing.return_reason" : "timesheets.review_change_reason")}
            <Input value={editing.reason} maxLength={2000} onChange={e => setEditing({ ...editing, reason: e.target.value })} />
          </label>}
          {(error || stale) && <p role="alert" className="text-sm text-destructive">{error || t("back_office.conflict.title")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" nativeButton={false} className="mr-auto"
              render={<Link to={"/back-office/timeEntries?record=" + target.id} />}>
              <History size={14} />{t("timesheets.ledger.history")}
            </Button>
            <Button size="sm" variant="outline" disabled={blocked || (returning && !editing.reason.trim())}
              onClick={() => {
                if (!returning) setReturning(true);
                else void run({ type: "return", entries: [{ id: target.id, revision: target.revision }], reason: editing.reason }, () => setEditing(undefined));
              }}>
              {t("back_office.billing.return")}
            </Button>
            {changed ? <Button size="sm" disabled={blocked || !editing.narrative.trim() || !Number.isInteger(minutes) ||
              (minutes !== target.billableMinutes && !editing.reason.trim())} onClick={() => void run({
                type: "review", id: target.id, revision: target.revision, narrative: editing.narrative,
                billableMinutes: minutes, reason: editing.reason.trim() || undefined,
              }, () => setEditing(undefined))}>{t("timesheets.save_review")}</Button> :
              <Button size="sm" disabled={blocked || !canApprove(target)}
                onClick={() => void run({ type: "approve", entries: [{ id: target.id, revision: target.revision }] }, () => setEditing(undefined))}>
                {t("timesheets.review_approve")}
              </Button>}
          </div>
        </div>
      </ItemDialogContent>}
    </Dialog>
  </div>;
}
