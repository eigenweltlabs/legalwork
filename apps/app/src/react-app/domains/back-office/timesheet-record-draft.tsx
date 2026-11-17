import { useQueryClient } from "@tanstack/react-query";
import { z, BackOfficeRecordSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { captureChargeMinutes, type CaptureProposal } from "@legalwork/types/time-capture";
import { proposedCharge, proposedStopwatchCharge, resolveTimePolicy, type TimesheetState } from "@legalwork/types/timesheet";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { applySavedRecord, writeBackOfficeRecord, type BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordCreateForm } from "./record-create-form";

/** Prepare only fields present in the connected directory's model. Saving still
 * uses its normal record permissions, revision history and synchronization. */
export function TimesheetRecordDraft({ client, directory, state, proposal, onClose }: {
  client: LegalworkServerClient; directory: BackOfficeState; state: TimesheetState;
  proposal: CaptureProposal; onClose: () => void;
}) {
  const cache = useQueryClient();
  const raw = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);
  if (!raw || !directory.captureProfileId) return <p role="alert">{t("timesheets.account_changed")}</p>;
  const object = displayBackOfficeObject(raw);
  const project = state.projects.find(project => project.id === proposal.projectId);
  const matter = state.matters.find(matter => matter.id === proposal.matterId)
    ?? (project?.matterIds.length === 1 ? state.matters.find(matter => matter.id === project.matterIds[0]) : undefined);
  const clientId = matter?.clientIds.length === 1 ? matter.clientIds[0] : "";
  const policy = resolveTimePolicy(state.policies, clientId, matter?.id ?? "", proposal.date, project?.id);
  const duration = captureChargeMinutes(proposal);
  const charge = duration === null ? null : proposal.source === "stopwatch"
    ? proposedStopwatchCharge(duration, policy) : proposedCharge(duration, policy);
  const narrative = proposal.source === "stopwatch" && !proposal.parentDigest ? "" : proposal.narrative;
  const values: Record<string, BackOfficeValue> = {
    matter: matter?.id ?? null, client: clientId || null,
    startedAt: proposal.startAt ?? null, endedAt: proposal.endAt ?? null,
    recordedMinutes: proposal.workedMinutes, billableMinutes: charge,
    billingNarrative: narrative, status: "Draft",
  };
  const initialValues = Object.fromEntries(Object.entries(values).filter(([id]) => object.fields.some(field => field.id === id)));
  return <div className="time-record-draft">
    <p className="time-storage-notice">{t("timesheets.records_draft_notice")}</p>
    <RecordCreateForm object={object} initialRecordId={proposal.key} name={narrative.slice(0, 240)} initialValues={initialValues}
      persistenceNotice={t("timesheets.records_visibility")}
      onCancel={onClose} onCreated={async () => onClose()}
      onSave={async record => {
        const response = await writeBackOfficeRecord(client, directory, {
          id: proposal.key, create: true, revision: 0, objectId: "timeEntries", values: record.values,
          privateProposal: { key: proposal.key, digest: proposal.digest, profileId: directory.captureProfileId },
        });
        const { record: saved } = z.object({ record: BackOfficeRecordSchema }).parse(response);
        await applySavedRecord(cache, client.baseUrl, directory, saved);
        return saved;
      }} />
  </div>;
}
