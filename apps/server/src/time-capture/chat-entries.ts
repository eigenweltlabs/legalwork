import type { z } from "zod";
import { announceSyncChange } from "../app-sync-events.js";
import type { backOfficeAccess } from "../back-office/access.js";
import type { BackOfficeRecord } from "../back-office/schema.js";
import { backOfficeStore } from "../back-office/store.js";
import { scheduleBackOfficeSync } from "../back-office/sync.js";
import { timeMemberContactId } from "../back-office/time-member-identity.js";
import { commandTimesheet } from "../back-office/timesheet.js";
import { legacyServiceDate } from "../back-office/timesheet-data.js";
import { readPlatformTimesheet } from "../back-office/timesheet-platform.js";
import { draftRules, effectiveWorkdayGuidelines, TimeDraftSchema, workdayBillableMinutes, type TimesheetState, type WorkdayGuideline } from "../back-office/timesheet-schema.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import type { chatWorkdayAction } from "./chat-workday-schema.js";

type Access = Awaited<ReturnType<typeof backOfficeAccess>>;
type EntryChange = Extract<z.infer<typeof chatWorkdayAction>, { action: "update_entry" | "remove_entry" }>;

function ownRecord(access: Access, record: BackOfficeRecord) {
  const contact = record.values.timekeeper;
  return contact ? contact === timeMemberContactId(access.scope, access.actor.userId) : record.ownerId === access.actor.userId;
}

function openRecord(record: BackOfficeRecord) {
  const { status, invoice } = record.values;
  return (!status || status === "Draft") && !invoice && !record.archivedAt;
}

function recordEntry(record: BackOfficeRecord, editable: boolean) {
  const v = record.values;
  const canChange = editable && openRecord(record);
  const clock = (value: unknown) => typeof value === "string" && value.includes("T") ? value : null;
  return { storage: "record" as const, id: record.id, revision: record.revision, date: legacyServiceDate(v), matterId: v.matter, narrative: v.billingNarrative || v.name,
    recordedMinutes: v.recordedMinutes, billableMinutes: v.billableMinutes, startAt: clock(v.startedAt), endAt: clock(v.endedAt),
    status: v.status ?? "Draft", editable: canChange, removable: canChange };
}

export async function chatEntries(config: ServerConfig, state: TimesheetState, access: Access, date: string) {
  const entries = state.entries.filter(entry => entry.date === date && entry.workerId === state.userId && entry.status !== "declined");
  const localRecords = access.scope === "local";
  const showRecords = state.service === "records";
  const legacy = new Set(localRecords ? entries.filter(entry => entry.legacy).map(entry => entry.id) : []);
  const records = showRecords || legacy.size ? (await backOfficeStore(config)).records(access.scope, access.actor, "timeEntries")
    .filter(record => (showRecords || legacy.has(record.id)) && ownRecord(access, record) && legacyServiceDate(record.values) === date)
    .map(record => recordEntry(record, access.actor.edit)) : [];
  if (showRecords) return records;
  const workflow = entries.filter(entry => !legacy.has(entry.id)).map(entry => ({
    storage: "workflow" as const, id: entry.id, revision: entry.revision, date: entry.date, matterId: entry.matterId, narrative: entry.narrative,
    recordedMinutes: entry.workedMinutes, billableMinutes: entry.billableMinutes, startAt: entry.startAt, endAt: entry.endAt, status: entry.status,
    editable: access.actor.edit && ["pending", "confirmed", "submitted"].includes(entry.status),
    removable: access.actor.edit && ["pending", "confirmed"].includes(entry.status),
  }));
  return [...records, ...workflow];
}

const stale = () => new ApiError(409, "workday_entry_changed", "This entry changed. List the entries again and review its current revision.");

export async function chatEntryForChange(config: ServerConfig, state: TimesheetState, access: Access, input: EntryChange) {
  const row = (await chatEntries(config, state, access, input.date)).find(entry => entry.id === input.id);
  if (!row) throw new ApiError(404, "workday_entry", "This time entry is unavailable for the selected date.");
  if (row.revision !== input.revision) throw stale();
  if (input.action === "remove_entry" ? !row.removable : !row.editable)
    throw new ApiError(403, "workday_entry_locked", "This time entry is locked for the requested change.");
  return row;
}

export async function changeChatEntry(config: ServerConfig, state: TimesheetState, access: Access, input: EntryChange, guidelines: WorkdayGuideline[]) {
  const actor = { ...access.actor, agentId: "timekeeping" };
  const store = await backOfficeStore(config);
  store.requireAccount(access.scope, actor);
  const row = await chatEntryForChange(config, state, access, input);
  const changes = input.action === "update_entry" ? { ...input.changes } : {};
  const newDate = changes.serviceDate ?? input.date;
  const entry = state.entries.find(item => item.id === row.id);
  const matterChanged = changes.matterId !== undefined && changes.matterId !== row.matterId;
  if (matterChanged || changes.recordedMinutes !== undefined || changes.billableMinutes !== undefined || newDate !== input.date) {
    const matter = state.matters.find(item => item.id === (changes.matterId ?? row.matterId));
    if (!matter) throw new ApiError(400, "workday_entry_matter", "Choose an accessible matter.");
    const clientId = (!matterChanged && entry?.clientId) || (matter.clientIds.length === 1 ? matter.clientIds[0] : "");
    if (effectiveWorkdayGuidelines(state, guidelines, { date: newDate, clientId, matterId: matter.id }).length) {
      const activity = entry?.activity ?? "";
      const rules = draftRules(state, guidelines, matter, newDate, matterChanged ? undefined : entry?.projectId, clientId);
      const minutes = changes.recordedMinutes ?? row.recordedMinutes;
      if (changes.billableMinutes === undefined && row.billableMinutes !== 0 && typeof minutes === "number")
        changes.billableMinutes = workdayBillableMinutes(minutes, rules, activity);
      const charge = changes.billableMinutes;
      if (charge !== undefined && charge > 0 && (charge < rules.minimumMinutes || charge > (rules.activityLimits[activity] ?? rules.maxMinutes)
          || (rules.enforceIncrement && charge % rules.incrementMinutes !== 0)))
        throw new ApiError(400, "workday_billing_rules", "The billable minutes do not meet the effective billing rules for this matter and date.");
    }
  }
  const resetClock = newDate !== input.date || (changes.recordedMinutes !== undefined && changes.recordedMinutes !== row.recordedMinutes);
  let revision: number;
  if (row.storage === "record") {
    const values: BackOfficeRecord["values"] = {};
    if (changes.narrative !== undefined) { values.name = changes.narrative.slice(0, 240); values.billingNarrative = changes.narrative; }
    if (changes.matterId !== undefined && changes.matterId !== row.matterId) { values.matter = changes.matterId; values.client = null; }
    if (changes.recordedMinutes !== undefined) values.recordedMinutes = changes.recordedMinutes;
    if (changes.billableMinutes !== undefined) values.billableMinutes = changes.billableMinutes;
    if (resetClock) { values.serviceDate = newDate; values.startedAt = newDate; values.endedAt = null; }
    revision = store.transaction(() => {
      // The one-time confirmation is bound to the entire row the user reviewed.
      const current = store.raw(access.scope, row.id);
      if (!current || current.revision !== input.revision || current.archivedAt || !ownRecord(access, current)) throw stale();
      if (!openRecord(current)) throw new ApiError(403, "workday_entry_locked", "This time entry is locked for the requested change.");
      return store.saveRecord(access.scope, actor, { id: row.id, objectId: "timeEntries", revision: input.revision, values,
        ...(input.action === "remove_entry" ? { archived: true } : {}) }).revision;
    });
    if (access.scope !== "local") scheduleBackOfficeSync(config);
  } else {
    if (!entry) throw stale();
    const draft = TimeDraftSchema.strip().parse(entry);
    const command = input.action === "remove_entry" ? { type: "withdraw", id: entry.id, revision: input.revision } : {
      type: "update", id: entry.id, revision: input.revision,
      entry: { ...draft, date: newDate, narrative: changes.narrative ?? entry.narrative,
        ...(changes.matterId !== undefined && changes.matterId !== entry.matterId ? { matterId: changes.matterId, clientId: "", projectId: undefined, workProductId: undefined, workProductTitle: undefined } : {}),
        ...(changes.recordedMinutes !== undefined ? { workedMinutes: changes.recordedMinutes } : {}),
        ...(changes.billableMinutes !== undefined ? { billableMinutes: changes.billableMinutes, billable: changes.billableMinutes > 0 || entry.billable } : {}),
        ...(resetClock ? { startAt: undefined, endAt: undefined } : {}) },
    };
    const after = access.scope === "local"
      ? commandTimesheet(store, access.scope, actor, state.people, command, state.projects)
      : await readPlatformTimesheet(config, { ...access, actor }, "POST", command);
    const changed = after.entries.find(item => item.id === row.id);
    if (!changed || (input.action === "remove_entry" && changed.status !== "declined")) throw stale();
    revision = changed.revision;
  }
  announceSyncChange(config, "backOffice");
  return { id: row.id, date: newDate, revision, removed: input.action === "remove_entry" };
}
