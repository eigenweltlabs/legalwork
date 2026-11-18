import type { BackOfficeActor, BackOfficeRecord } from "../back-office/schema.js";
import type { BackOfficeStore } from "../back-office/store.js";
import { readTimeDocument, timeDirectory, type TimeDirectory } from "../back-office/timesheet-data.js";
import type { CaptureProposal, ReconcileCapture } from "../back-office/timesheet-schema.js";
import { timeMemberUserId } from "../back-office/time-member-identity.js";
import { dayInZone } from "../calendar/dates.js";
import { ApiError } from "../errors.js";

const serviceDay = z.iso.date();
function recordDay({ serviceDate, startedAt }: BackOfficeRecord["values"], zone: string) {
  const explicit = serviceDay.safeParse(serviceDate);
  if (explicit.success) return explicit.data;
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) return;
  if (serviceDay.safeParse(startedAt).success || /[+-]\d{2}:\d{2}$/.test(startedAt)) return startedAt.slice(0, 10);
  return dayInZone(startedAt, zone);
}

export function validateReconcileTarget(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  action: ReconcileCapture,
  proposal: CaptureProposal,
  reviewedMatter: string | undefined,
  workspaces: TimeDirectory["projects"],
  zone: string,
) {
  store.requireAccount(scope, actor);
  const model = store.model(scope);
  const visible = (record: BackOfficeRecord | null, objectId: string): record is BackOfficeRecord =>
    Boolean(record && record.objectId === objectId && !record.archivedAt &&
      model.objects.some((object) => object.id === objectId && !object.archived) && store.canRead(scope, record, actor));
  const record = store.raw(scope, action.recordId);
  if (!actor.edit || !visible(record, "timeEntries") || record.id === proposal.key)
    throw new ApiError(403, "private_reconcile", "Choose one of your time entries.");
  const managed = scope === "local" ? readTimeDocument(store, scope, record.id) : null;
  const entry = managed?.kind === "entry" ? managed.value : undefined;
  const timekeeper = record.values.timekeeper;
  const contact = typeof timekeeper === "string" && timekeeper ? store.raw(scope, timekeeper) : null;
  const ownRecord = timekeeper === undefined || timekeeper === null || timekeeper === ""
    ? record.ownerId === actor.userId
    : visible(contact, "people") && contact.values.active !== false && timeMemberUserId(scope, contact) === actor.userId;
  const own = entry ? entry.workerId === actor.userId && entry.status !== "declined" : ownRecord;
  if (!own) throw new ApiError(403, "private_reconcile", "Choose one of your time entries.");
  if (record.revision !== action.recordRevision)
    throw new ApiError(409, "private_reconcile_changed", "The time entry changed. Refresh and choose it again.");
  const date = entry?.date ?? recordDay(record.values, zone);
  const recordMatter = entry?.matterId ?? record.values.matter;
  const projectMatters = !reviewedMatter && !proposal.matterId && proposal.projectId
    ? timeDirectory(store, scope, actor, [], workspaces).projects.find((project) => project.id === proposal.projectId)?.matterIds
    : undefined;
  const matter = reviewedMatter ?? proposal.matterId ?? (projectMatters?.length === 1 ? projectMatters[0] : undefined);
  if (!matter || !visible(store.raw(scope, matter), "matters"))
    throw new ApiError(409, "private_reconcile_matter", "Assign an available matter to the suggestion before linking it.");
  if (recordMatter !== matter || date !== proposal.date)
    throw new ApiError(409, "private_reconcile_mismatch", "Choose a time entry on the same workday and matter.");
}
import { z } from "zod";
