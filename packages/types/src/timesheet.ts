import { z } from "zod";
import { invoiceAmountSchema, invoiceBillingModeSchema, invoiceTemplateSchema } from "@legalwork/types/invoice-template";
import {
  DelegatedTimeEntrySchema, TimeDraftSchema, TimeEntrySchema, TimePolicySchema, decideTimeCommandSchema,
  reviewTimeCommandSchema, submitTimeCommandSchema, timeSchemaFields,
  type TimeEntry,
} from "@legalwork/types/timesheet-core";
export * from "@legalwork/types/timesheet-core";

const { id, text, minutes, currency, date, source, productType, productReference } = timeSchemaFields;

export const TimeAdjustmentSchema = z.strictObject({
  id,
  entryId: id,
  baseRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  matterId: id,
  workerId: id,
  authorId: id,
  reviewerId: id.optional(),
  reason: text,
  narrative: text,
  fromMinutes: minutes,
  toMinutes: minutes,
  deltaAmount: z.number().finite().nullable(),
  currency: currency.optional(),
  status: z.enum(["pending", "approved", "declined"]),
  createdAt: z.iso.datetime(),
  reviewedAt: z.iso.datetime().optional(),
  invoiceId: id.optional(),
  noteNumber: id.optional(),
});
export type TimeAdjustment = z.infer<typeof TimeAdjustmentSchema>;
export function appliesTimeAdjustment(entry: TimeEntry, adjustment: TimeAdjustment) {
  return adjustment.entryId === entry.id &&
    adjustment.baseRevision >= (entry.adjustmentBaselineRevision ?? 1) &&
    adjustment.baseRevision <= entry.revision;
}
export function adjustedTimeEntry(entry: TimeEntry, adjustments: TimeAdjustment[] = []): TimeEntry {
  const latest = adjustments
    .filter((a) => a.status === "approved" && appliesTimeAdjustment(entry, a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return latest
    ? {
        ...entry,
        billableMinutes: latest.toMinutes,
        narrative: latest.narrative,
      }
    : entry;
}
const entity = z.object({ id, name: z.string() });
const ref = z.object({ id, revision: z.number().int().positive() });
const selection = z.array(ref).min(1).max(1000);
const digest = z.string().regex(/^[a-f\d]{64}$/);
const invoiceAdjustment = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("percent"), basisPoints: z.number().int().min(0).max(10000) }),
  z.strictObject({ type: z.literal("target"), amountMinor: invoiceAmountSchema, basis: z.enum(["selection", "invoice"]) }),
]);
const invoiceAdjustmentScope = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("all") }),
  z.strictObject({ type: z.literal("people"), ids: z.array(id).min(1).max(1000) }),
  z.strictObject({ type: z.literal("entries"), ids: z.array(id).min(1).max(1000) }),
]);
export const InvoiceDraftInputSchema = z.strictObject({
  matterId: id,
  clientId: id,
  period: z.strictObject({ from: date.optional(), to: date }),
  entries: selection,
  adjustmentVersions: z.array(ref).max(2000),
  wording: z.array(id).max(1000),
  expectedSuggestions: z.array(z.strictObject({ id, narrative: text })).max(1000).optional(),
  edits: z.array(z.strictObject({ id, narrative: text })).max(1000).optional(),
  pricing: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("hourly"), currency: currency.optional() }),
    z.strictObject({ mode: z.literal("fixed"), currency, amountMinor: invoiceAmountSchema, showHours: z.boolean() }),
  ]),
  reduction: z.strictObject({ scope: invoiceAdjustmentScope, adjustment: invoiceAdjustment }).optional(),
});
export type InvoiceDraftInput = z.infer<typeof InvoiceDraftInputSchema>;
export const InvoiceApprovalSchema = z.strictObject({
  actorId: id,
  at: z.iso.datetime(),
  revision: digest,
});
export const InvoiceWordingSuggestionSchema = z.strictObject({
  id,
  narrative: text,
  rule: z.enum(["spelling", "language", "actionFirst", "activityLabels", "terminology", "narrativeExample", "uploadedGuideline"]),
});
export type InvoiceWordingSuggestion = z.infer<typeof InvoiceWordingSuggestionSchema>;
const invoiceSnapshot = z.strictObject({
  date,
  client: z.string(),
  clientAddress: z.string(),
  template: invoiceTemplateSchema,
  wordTemplateRevision: z.number().int().nonnegative().optional(),
});
export const TimeInvoiceDraftSchema = z.strictObject({
  id: z.uuid(),
  revision: digest,
  input: InvoiceDraftInputSchema,
  currency,
  showHours: z.boolean(),
  totalMinor: invoiceAmountSchema,
  protectedMinor: invoiceAmountSchema,
  selectedBaseMinor: invoiceAmountSchema,
  selectedTotalMinor: invoiceAmountSchema,
  snapshot: invoiceSnapshot,
  modelBasis: digest.optional(),
  modelWording: z.array(InvoiceWordingSuggestionSchema).max(1000).optional(),
  lines: z.array(z.strictObject({
    entry: TimeEntrySchema,
    originalNarrative: text,
    currentNarrative: text,
    suggestedNarrative: z.string().optional(),
    modelRule: InvoiceWordingSuggestionSchema.shape.rule.optional(),
    rules: z.array(z.string()),
    actionFirst: z.boolean().optional(),
    guidelineVersions: z.array(z.strictObject({
      id: z.uuid(), revision: z.number().int().positive(), name: z.string(), effectiveFrom: date,
    })).max(3).optional(),
    actualAmountMinor: invoiceAmountSchema.optional(),
    baseAmountMinor: invoiceAmountSchema,
    amountMinor: invoiceAmountSchema,
  })).min(1).max(1000),
  approval: InvoiceApprovalSchema.optional(),
});
export type TimeInvoiceDraft = z.infer<typeof TimeInvoiceDraftSchema>;
export const TimesheetCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    requestId: z.uuid(),
    entry: TimeDraftSchema,
    workerIds: z.array(id).min(1).max(100).optional(),
    workerTimes: z.array(z.strictObject({
      workerId: id, workedMinutes: minutes.min(1), nonBillableMinutes: minutes, billableMinutes: minutes,
    })).min(1).max(100).optional(),
    source: source.optional(),
    proposalDigest: z
      .string()
      .regex(/^[a-f\d]{64}$/)
      .optional(),
  }),
  z.strictObject({
    type: z.literal("update"),
    id,
    revision: ref.shape.revision,
    entry: TimeDraftSchema,
  }),
  z.strictObject({
    type: z.literal("applyWording"),
    entries: z.array(ref.extend({ before: text, after: text })).min(1).max(1000),
  }),
  ref.extend({ type: z.literal("withdraw") }).strict(),
  z.strictObject({
    type: z.literal("declineSuggestion"),
    id,
    revision: ref.shape.revision,
  }),
  reviewTimeCommandSchema,
  submitTimeCommandSchema,
  decideTimeCommandSchema,
  z.strictObject({ type: z.enum(["confirm", "decline"]), entries: selection, reason: text.optional() }),
  z.strictObject({
    type: z.literal("template"),
    template: invoiceTemplateSchema,
  }),
  z.strictObject({
    type: z.literal("productDetails"),
    id,
    expectedType: productType.optional(),
    expectedReference: productReference.optional(),
    productType,
    reference: productReference,
  }),
  z.strictObject({
    type: z.literal("renameProduct"),
    id,
    expectedName: z.string().min(1).max(240),
    name: z.string().trim().min(1).max(240),
  }),
  z.strictObject({
    type: z.literal("adjust"),
    id,
    revision: ref.shape.revision,
    requestId: z.uuid(),
    reason: text,
    narrative: text,
    billableMinutes: minutes,
  }),
  z.strictObject({
    type: z.literal("decideAdjustment"),
    id,
    revision: ref.shape.revision,
    approve: z.boolean(),
  }),
  z.strictObject({ type: z.literal("policy"), policy: TimePolicySchema }),
  z.strictObject({ type: z.literal("assignBillingClient"), ...ref.shape, clientId: id }),
  z.strictObject({ type: z.literal("prepareInvoice"), draft: InvoiceDraftInputSchema }),
  z.strictObject({ type: z.literal("reviewInvoiceWording"), id: z.uuid(), revision: digest,
    model: z.strictObject({ workspaceId: id, providerID: id, modelID: z.string().trim().min(1).max(300) }),
  }),
  z.strictObject({ type: z.literal("approveInvoice"), id: z.uuid(), revision: digest }),
  z.strictObject({ type: z.literal("issueInvoice"), id: z.uuid(), revision: digest, requestId: z.uuid() }),
  z.strictObject({
    type: z.literal("invoice"),
    adjustmentVersions: z.array(ref).max(2000).optional(),
    requestId: z.uuid(),
    templateRevision: z.number().int().nonnegative().optional(),
    entries: selection,
  }),
]);
export type TimesheetCommand = z.infer<typeof TimesheetCommandSchema>;
export function requiresTimeAllocations(command: TimesheetCommand) {
  return (command.type === "create" && Boolean(command.workerTimes?.length)) ||
    ((command.type === "create" || command.type === "update") && command.entry.nonBillableMinutes !== undefined);
}
export function requiresInvoiceDrafts(command: TimesheetCommand) {
  return command.type === "prepareInvoice" || command.type === "approveInvoice" || command.type === "issueInvoice" ||
    command.type === "reviewInvoiceWording";
}
const invoiceSchema = z.object({
  id,
  draftId: z.uuid().optional(),
  number: z.number().int().positive().safe(),
  entries: z.array(TimeEntrySchema.extend({
    actualAmountMinor: invoiceAmountSchema.optional(),
    baseAmountMinor: invoiceAmountSchema.optional(),
    amountMinor: invoiceAmountSchema.optional(),
    originalNarrative: text.optional(),
  })),
  templateRevision: z.number().int().nonnegative().optional(),
  total: z.number().nonnegative(),
  totalMinor: invoiceAmountSchema.optional(),
  billingMode: invoiceBillingModeSchema.optional(),
  showHours: z.boolean().optional(),
  approval: InvoiceApprovalSchema.optional(),
  snapshot: invoiceSnapshot.optional(),
  currency,
  issuedAt: z.iso.datetime(),
  clientId: id,
});
export type TimeInvoice = z.infer<typeof invoiceSchema>;
export const TimesheetStateSchema = z.object({
  service: z.enum(["workflow", "records"]).optional(),
  userId: id,
  scope: z.string(),
  template: invoiceTemplateSchema.optional(),
  supportsBillingComparisons: z.boolean().optional(),
  supportsTimeAllocations: z.boolean().optional(),
  supportsInvoiceDrafts: z.boolean().optional(),
  supportsBillingClientAssignment: z.boolean().optional(),
  supportsHourlyInvoiceCurrency: z.boolean().optional(),
  supportsInvoiceWordingReview: z.boolean().optional(),
  invoiceDraft: TimeInvoiceDraftSchema.optional(),
  unresolvedLegacyEntries: z.array(id).optional(),
  canManage: z.boolean(),
  canReview: z.boolean(),
  entries: z.array(TimeEntrySchema),
  delegatedEntries: z.array(DelegatedTimeEntrySchema).optional(),
  adjustments: z.array(TimeAdjustmentSchema).optional(),
  matters: z.array(entity.extend({ clientIds: z.array(id), reference: z.string() })),
  clients: z.array(entity.extend({ billingAddress: z.string().optional() })),
  people: z.array(entity.extend({ directoryOnly: z.literal(true).optional(), canRecordTimeFor: z.boolean().optional() })),
  products: z.array(
    entity.extend({
      matterId: id,
      productType: productType.optional(),
      reference: productReference.optional(),
      authorId: id.optional(),
      createdAt: z.iso.datetime().optional(),
    }),
  ),
  projects: z.array(entity.extend({ matterIds: z.array(id), agreementIds: z.array(id).optional() })),
  policies: z.array(TimePolicySchema),
  invoices: z.array(invoiceSchema),
});
export type TimesheetState = z.infer<typeof TimesheetStateSchema>;
