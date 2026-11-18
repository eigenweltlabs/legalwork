import { z } from "zod";
import { readableBackOfficeRecord, type BackOfficeActor, type BackOfficeRecord } from "../back-office/schema.js";
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
  reviewed: {
    matter: string | null | undefined;
    values: BackOfficeRecord["values"] | undefined;
  },
  workspaces: TimeDirectory["projects"],
  zone: string,
) {
  store.requireAccount(scope, actor);
  const model = store.model(scope);
  const visible = (record: BackOfficeRecord | null, objectId: string): record is BackOfficeRecord =>
    Boolean(record && record.objectId === objectId && !record.archivedAt &&
      model.objects.some((object) => object.id === objectId && !object.archived) && store.canRead(scope, record, actor));
  const record = store.raw(scope, action.recordId);
  const timeEntries = model.objects.find((object) => object.id === "timeEntries" && !object.archived);
  if (!actor.edit || !timeEntries || !visible(record, "timeEntries") || record.id === proposal.key)
    throw new ApiError(403, "private_reconcile", "Choose one of your time entries.");
  const managed = scope === "local" ? readTimeDocument(store, scope, record.id) : null;
  const entry = managed?.kind === "entry" ? managed.value : undefined;
  const values = readableBackOfficeRecord(record, timeEntries, actor).values;
  const timekeeper = values.timekeeper;
  const ownContact = (value: BackOfficeRecord["values"][string] | undefined) => {
    const contact = typeof value === "string" && value ? store.raw(scope, value) : null;
    return visible(contact, "people") && contact.values.active !== false && timeMemberUserId(scope, contact) === actor.userId;
  };
  const ownRecord = timekeeper !== record.values.timekeeper ? false
    : timekeeper === undefined || timekeeper === null || timekeeper === ""
      ? record.ownerId === actor.userId
      : ownContact(timekeeper);
  const own = entry ? entry.workerId === actor.userId && entry.status !== "declined" && entry.status !== "pending" : ownRecord;
  const draft = reviewed.values;
  const ownDraft = !draft || (draft.workflow === true
    ? draft.workerId === actor.userId || (!Object.hasOwn(draft, "workerId") && !Object.hasOwn(draft, "workers"))
    : !Object.hasOwn(draft, "timekeeper") || draft.timekeeper === "member:" + actor.userId || ownContact(draft.timekeeper));
  if (!own || !ownDraft) throw new ApiError(403, "private_reconcile", "Choose one of your time entries.");
  if (record.revision !== action.recordRevision)
    throw new ApiError(409, "private_reconcile_changed", "The time entry changed. Refresh and choose it again.");
  const date = entry?.date ?? recordDay(values, zone);
  const recordMatter = entry?.matterId ?? values.matter;
  let reviewedDate: string | undefined = proposal.date;
  if (draft?.workflow === true && Object.hasOwn(draft, "date"))
    reviewedDate = serviceDay.safeParse(draft.date).data;
  else if (draft && Object.hasOwn(draft, "serviceDate"))
    reviewedDate = serviceDay.safeParse(draft.serviceDate).data;
  else if (draft && Object.hasOwn(draft, "startedAt"))
    reviewedDate = recordDay(draft, zone);
  const projectMatters = reviewed.matter === undefined && !proposal.matterId && proposal.projectId
    ? timeDirectory(store, scope, actor, [], workspaces).projects.find((project) => project.id === proposal.projectId)?.matterIds
    : undefined;
  const matter = reviewed.matter === undefined
    ? proposal.matterId ?? (projectMatters?.length === 1 ? projectMatters[0] : undefined)
    : reviewed.matter;
  if (!matter || !visible(store.raw(scope, matter), "matters"))
    throw new ApiError(409, "private_reconcile_matter", "Assign an available matter to the suggestion before linking it.");
  if (!reviewedDate || date !== reviewedDate || (!entry && date !== recordDay(record.values, zone)) || recordMatter !== matter)
    throw new ApiError(409, "private_reconcile_mismatch", "Choose a time entry on the same workday and matter.");
}
