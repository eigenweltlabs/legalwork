import { randomUUID } from "node:crypto";
import type {
  InvoiceDraftInput,
  TimeEntry,
  TimesheetCommand,
  TimesheetState,
} from "@legalwork/types/timesheet";

type Reference = { id: string; revision: number };
export function prepareInvoice(
  entries: TimeEntry[],
  adjustmentVersions: Reference[] = [],
  overrides: Partial<InvoiceDraftInput> = {},
): Extract<TimesheetCommand, { type: "prepareInvoice" }> {
  const dates = entries.map((entry) => entry.date).sort();
  return {
    type: "prepareInvoice",
    draft: {
      matterId: entries[0].matterId,
      clientId: entries[0].clientId,
      period: { from: dates[0], to: dates[dates.length - 1] },
      entries: entries.map(({ id, revision }) => ({ id, revision })),
      adjustmentVersions,
      wording: [],
      pricing: { mode: "hourly" },
      ...overrides,
    },
  };
}
export function invoiceDraftRef(state: TimesheetState) {
  if (!state.invoiceDraft) throw new Error("Expected an invoice draft.");
  const { id, revision } = state.invoiceDraft;
  return { id, revision };
}
export function approveInvoice(
  run: (command: TimesheetCommand) => TimesheetState,
  preview: TimesheetState,
) {
  const draft = invoiceDraftRef(preview);
  run({ type: "approveInvoice", ...draft });
  const issue: TimesheetCommand = {
    type: "issueInvoice",
    ...draft,
    requestId: randomUUID(),
  };
  return issue;
}
