import { randomUUID } from "node:crypto";
import {
  adjustedTimeEntry,
  type TimeAdjustment,
  type TimeEntry,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { renderInvoice, standardInvoice } from "@legalwork/types/invoice-template";
import { type BackOfficeActor } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { readTimeDocument, writeTimeDocument, timeError } from "./timesheet-data.js";

export function invoiceLines(
  entries: TimeEntry[],
  adjustments: TimeAdjustment[],
  expected: { id: string; revision: number }[],
) {
  const ids = new Set(entries.map((e) => e.id)),
    relevant = adjustments.filter((a) => ids.has(a.entryId));
  if (relevant.some((a) => a.status === "pending"))
    timeError("Resolve pending corrections before issuing.", 409);
  const approved = relevant.filter((a) => a.status === "approved");
  if (
    expected.length !== approved.length ||
    approved.some((a) => !expected.some((r) => r.id === a.id && r.revision === a.revision))
  )
    timeError("The approved corrections changed. Preview the invoice again.", 409);
  return entries.map((e) => adjustedTimeEntry(e, approved));
}
const scaleFor = (currency: string) =>
  10 **
  (new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits ?? 2);
function delta(e: TimeEntry, from: number, to: number) {
  if (e.hourlyRate === undefined || !e.currency) return null;
  const scale = scaleFor(e.currency),
    perMinute = (e.hourlyRate * scale) / 60;
  return (Math.round(to * perMinute) - Math.round(from * perMinute)) / scale;
}
export function adjustTime(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  original: TimeEntry,
  command: Extract<TimesheetCommand, { type: "adjust" }>,
) {
  if (original.legacy || !["approved", "invoiced"].includes(original.status))
    timeError("Corrections require a pinned approved original.", 409);
  const existing = state.adjustments?.filter((a) => a.entryId === original.id) ?? [];
  if (existing.some((a) => a.status === "pending"))
    timeError("A correction is already pending for this entry.", 409);
  const previous = adjustedTimeEntry(original, existing);
  if (previous.narrative === command.narrative && previous.billableMinutes === command.billableMinutes)
    timeError("Change the charge or description first.");
  const invoiceId =
    original.status === "invoiced" ? store.raw(state.scope, original.id)?.values.invoice : undefined;
  if (original.status === "invoiced" && typeof invoiceId !== "string")
    timeError("The original invoice is unavailable.", 409);
  const time = Math.max(Date.now(), ...existing.map((a) => Date.parse(a.createdAt) + 1));
  const value: TimeAdjustment = {
    id: randomUUID(),
    entryId: original.id,
    baseRevision: original.revision,
    revision: 1,
    matterId: original.matterId,
    authorId: actor.userId,
    workerId: original.workerId,
    status: "pending",
    reason: command.reason,
    narrative: command.narrative,
    fromMinutes: previous.billableMinutes,
    toMinutes: command.billableMinutes,
    deltaAmount: delta(original, previous.billableMinutes, command.billableMinutes),
    currency: original.currency,
    createdAt: new Date(time).toISOString(),
    invoiceId: typeof invoiceId === "string" ? invoiceId : undefined,
  };
  writeTimeDocument(store, state.scope, {
    kind: "adjustment",
    id: value.id,
    value,
  });
}
export function decideAdjustment(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  entry: TimeEntry,
  adjustment: TimeAdjustment,
  approve: boolean,
) {
  const value: TimeAdjustment = {
    ...adjustment,
    revision: adjustment.revision + 1,
    reviewerId: actor.userId,
    reviewedAt: new Date().toISOString(),
    status: approve ? "approved" : "declined",
  };
  let document: string | undefined;
  if (approve && value.invoiceId) {
    const issued = readTimeDocument(store, state.scope, value.invoiceId);
    if (
      issued?.kind !== "invoice" ||
      !issued.value.entries.some((i) => i.id === entry.id) ||
      !value.currency ||
      value.deltaAmount === null
    )
      timeError("The pinned original invoice or its price is unavailable.", 409);
    const ordinal =
      1 +
      Number(
        store.db.get(
          "SELECT COUNT(*) AS n FROM bo_timesheets WHERE scope=? AND json_extract(data,'$.kind')='adjustment' AND json_extract(data,'$.value.invoiceId')=? AND json_extract(data,'$.value.noteNumber') IS NOT NULL",
          [state.scope, value.invoiceId],
        )?.n ?? 0,
      );
    value.noteNumber = issued.value.number + "-C" + ordinal;
    const template = state.template ?? standardInvoice;
    const title =
      (template.locale === "de-AT" ? "Rechnungskorrektur " : "Invoice correction ") + value.noteNumber;
    document = renderInvoice(
      { ...template, title },
      {
        date: value.reviewedAt!.slice(0, 10),
        client: state.clients.find((c) => c.id === entry.clientId)?.name ?? entry.clientId,
        currency: value.currency,
        entries: [
          {
            date: entry.date,
            narrative: value.narrative,
            billableMinutes: value.toMinutes - value.fromMinutes,
            amountMinor: Math.round(value.deltaAmount * scaleFor(value.currency)),
          },
        ],
      },
    );
  }
  writeTimeDocument(store, state.scope, {
    kind: "adjustment",
    id: value.id,
    value,
    document,
  });
}
