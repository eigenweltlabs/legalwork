import { randomUUID } from "node:crypto";
import { calculateInvoiceDraft } from "./timesheet-schema.js";
import type { InvoiceDraftInput, InvoiceWordingSuggestion, TimeEntry, TimeInvoiceDraft, TimesheetState } from "./timesheet-schema.js";
import { invoiceLines } from "./timesheet-adjustment.js";
import { invoiceWordingRules, type InvoiceGuidelineContext } from "./timesheet-invoice-guidelines.js";
import { timeError } from "./timesheet-data.js";

export function buildInvoiceDraft(
  state: TimesheetState,
  input: InvoiceDraftInput,
  canReview: (entry: TimeEntry) => boolean,
  validateEntry: (entry: TimeEntry) => void,
  digest: (data: unknown) => string,
  previous?: TimeInvoiceDraft,
  advice?: InvoiceWordingSuggestion[],
  context?: InvoiceGuidelineContext,
) {
  return calculateInvoiceDraft({
    newId: randomUUID, timeError, invoiceLines,
    invoiceWordingRules: (current, entry) => invoiceWordingRules(current, entry, context),
  }, state, input, canReview, validateEntry, digest, previous, advice);
}
