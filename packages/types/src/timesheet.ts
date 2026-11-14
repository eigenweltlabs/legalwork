import { z } from "zod";
import { invoiceTemplateSchema } from "@legalwork/types/invoice-template";

const id = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const minutes = z.number().int().min(0).max(1440);
const rate = z.number().finite().min(0).max(1_000_000);
const wordingMap = (limit: number) =>
  z
    .record(id, z.string().trim().min(1).max(limit))
    .refine((values) => Object.keys(values).length <= 100, "Use up to 100 wording rules per level.");
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.iso.date();

export const timeActivities: Record<string, string> = {
  RES: "Research",
  CF: "Case file study",
  EXM: "External meeting",
  INM: "Internal meeting",
  EML: "Short external email",
  EMX: "Long external email",
  EMI: "Internal email",
  DFT: "Drafting",
  MOD: "Amending",
  PLE: "Pleading",
  LS: "Short letter",
  LL: "Long letter",
  STR: "Strategy",
  TEL: "Telephone call",
  DR: "Data room review",
  DDR: "Drafting due diligence report",
};
export const workProductTypes = ["document", "email", "pleading", "memo", "letter", "report"] as const;
const productType = z.enum(workProductTypes);
const productReference = z.string().trim().max(1000);

export const TimeDraftSchema = z.strictObject({
  date,
  matterId: id,
  clientId: z.string().max(200),
  startAt: z.iso.datetime({ offset: true }).optional(),
  endAt: z.iso.datetime({ offset: true }).optional(),
  projectId: id.optional(),
  activity: z.string().trim().min(1).max(100),
  narrative: text,
  workedMinutes: minutes.min(1),
  billable: z.boolean(),
  billableMinutes: minutes,
  createWorkProduct: z.literal(true).optional(),
  workProductId: id.optional(),
  workProductTitle: z.string().trim().min(1).max(240).optional(),
});
export type TimeDraft = z.infer<typeof TimeDraftSchema>;
const bindingTermSchema = z.strictObject({
  clientId: id,
  effectiveFrom: date,
  revision: z.number().int().nonnegative(),
  incrementMinutes: minutes.min(1),
});
export type BindingTimeTerm = z.infer<typeof bindingTermSchema>;
const incrementExceptionSchema = z.strictObject({
  reason: text,
  authorizedBy: id,
  authorizedAt: z.iso.datetime(),
  terms: z.array(bindingTermSchema).min(1).max(1000),
});
type IncrementException = z.infer<typeof incrementExceptionSchema>;
export const roundingModes = ["choose", "up", "down", "nearest"] as const;
export const TimePolicySchema = z.strictObject({
  scope: z.enum(["firm", "client", "matter", "project"]),
  targetId: id,
  effectiveFrom: date,
  revision: z.number().int().nonnegative(),
  incrementMinutes: minutes.min(1).optional(),
  enforceIncrement: z.boolean().optional(),
  rounding: z.enum(roundingModes).optional(),
  bindingIncrement: z.boolean().optional(),
  agreementClientId: id.optional(),
  incrementExceptionReason: text.optional(),
  incrementException: incrementExceptionSchema.optional(),
  maxMinutes: minutes.min(1).optional(),
  activityLimits: z.record(id, minutes.min(1)).optional(),
  activityLabels: wordingMap(80).optional(),
  language: z.string().min(1).max(60).optional(),
  actionWords: wordingMap(80).optional(),
  narrativeCorrections: wordingMap(200).optional(),
  narrativeExample: z.string().trim().max(500).optional(),
  actionFirst: z.boolean().optional(),
  reviewerId: id.optional(),
  soloApproval: z.boolean().optional(),
  hourlyRate: rate.optional(),
  workerRates: z.record(id, rate).optional(),
  currency: currency.optional(),
});
export type TimePolicy = z.infer<typeof TimePolicySchema>;
/** Legacy hourly agreements supply individual defaults beneath an explicitly dated policy. */
export function appliedTimePolicies(
  policies: TimePolicy[],
  scope: TimePolicy["scope"],
  target: string | undefined,
  date: string,
  billingClient?: string,
): TimePolicy[] {
  const candidates = policies.filter(
    (p) =>
      p.scope === scope &&
      p.targetId === target &&
      p.effectiveFrom <= date &&
      (!p.agreementClientId || p.agreementClientId === billingClient),
  );
  const legacy = (p: TimePolicy) =>
    p.revision === 0 && p.effectiveFrom === "0001-01-01" && (scope === "matter" || scope === "client");
  const agreements = candidates
    .filter(legacy)
    .sort((a, b) => Number(Boolean(a.agreementClientId)) - Number(Boolean(b.agreementClientId)));
  const policy = candidates
    .filter((p) => !legacy(p))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0];
  return policy ? [...agreements, policy] : agreements;
}
export function activeTimePolicy(
  policies: TimePolicy[],
  scope: TimePolicy["scope"],
  target: string | undefined,
  date: string,
  billingClient?: string,
) {
  return appliedTimePolicies(policies, scope, target, date, billingClient).at(-1);
}
export function bindingTimeTerm(
  policies: TimePolicy[],
  clientId: string,
  date: string,
): BindingTimeTerm | undefined {
  const layers = appliedTimePolicies(policies, "client", clientId, date);
  const binding = layers.filter((p) => p.bindingIncrement !== undefined).at(-1);
  if (!binding?.bindingIncrement) return undefined;
  const issuer = layers.at(-1)!;
  return {
    clientId,
    effectiveFrom: issuer.effectiveFrom,
    revision: issuer.revision,
    incrementMinutes:
      layers.filter((p) => p.incrementMinutes !== undefined).at(-1)?.incrementMinutes ??
      activeTimePolicy(policies, "firm", "firm", date)?.incrementMinutes ??
      10,
  };
}
export function projectRelaxesTerm(
  project: Pick<TimePolicy, "enforceIncrement" | "incrementMinutes">,
  term: BindingTimeTerm,
) {
  return (
    project.enforceIncrement === false ||
    (project.incrementMinutes !== undefined && project.incrementMinutes % term.incrementMinutes !== 0)
  );
}
export function resolveTimePolicy(
  policies: TimePolicy[],
  clientId: string,
  matterId: string,
  date: string,
  projectId?: string,
) {
  const baseline = {
    bindingClientTerm: bindingTimeTerm(policies, clientId, date),
    incrementException: undefined as IncrementException | undefined,
    incrementMinutes: 10,
    enforceIncrement: true,
    rounding: "choose" as (typeof roundingModes)[number],
    maxMinutes: 120,
    activityLimits: {} as Record<string, number>,
    activityLabels: {} as Record<string, string>,
    workerRates: {} as Record<string, number>,
    language: "",
    actionFirst: false,
    narrativeExample: "",
    actionWords: {} as Record<string, string>,
    narrativeCorrections: {} as Record<string, string>,
    reviewerId: "",
    soloApproval: false,
    hourlyRate: undefined as number | undefined,
    currency: "",
  };
  const targets = {
    firm: "firm",
    client: clientId,
    matter: matterId,
    project: projectId,
  };
  for (const scope of ["firm", "client", "matter", "project"] as const) {
    for (const policy of appliedTimePolicies(policies, scope, targets[scope], date, clientId)) {
      const {
        scope: _scope,
        targetId: _id,
        effectiveFrom: _from,
        revision: _revision,
        activityLimits,
        activityLabels,
        workerRates,
        actionWords,
        narrativeCorrections,
        agreementClientId: _agreementClient,
        bindingIncrement: _binding,
        incrementExceptionReason: _reason,
        incrementException,
        ...values
      } = policy;
      Object.assign(baseline, values);
      Object.assign(baseline.activityLimits, activityLimits);
      Object.assign(baseline.activityLabels, activityLabels);
      Object.assign(baseline.workerRates, workerRates);
      Object.assign(baseline.actionWords, actionWords);
      Object.assign(baseline.narrativeCorrections, narrativeCorrections);
      const term = baseline.bindingClientTerm;
      if (term) {
        const valid =
          scope === "project" &&
          projectRelaxesTerm(policy, term) &&
          incrementException?.terms.some(
            (ref) =>
              ref.clientId === clientId &&
              ref.revision === term.revision &&
              ref.effectiveFrom === term.effectiveFrom &&
              ref.incrementMinutes === term.incrementMinutes,
          );
        if (valid) baseline.incrementException = incrementException;
        else {
          baseline.enforceIncrement = true;
          if (scope === "client" || baseline.incrementMinutes % term.incrementMinutes !== 0)
            baseline.incrementMinutes = term.incrementMinutes;
        }
      }
    }
  }
  return baseline;
}
export function timeEntryError(draft: TimeDraft, policy: ReturnType<typeof resolveTimePolicy>) {
  if (
    Boolean(draft.startAt) !== Boolean(draft.endAt) ||
    (draft.startAt && draft.endAt && Date.parse(draft.endAt) <= Date.parse(draft.startAt))
  )
    return "Choose a valid start and end together.";
  if (!draft.billable && draft.billableMinutes)
    return "Non-billable work must have zero chargeable minutes.";
  if (policy.enforceIncrement && draft.billableMinutes % policy.incrementMinutes)
    return `Chargeable time must be a multiple of ${policy.incrementMinutes} minutes.`;
  return "";
}
export function timeCapWarning(draft: TimeDraft, policy: ReturnType<typeof resolveTimePolicy>) {
  const maximum = policy.activityLimits[draft.activity] ?? policy.maxMinutes;
  if (draft.billableMinutes > maximum)
    return `This activity allows up to ${maximum} chargeable minutes per entry.`;
  return "";
}
export function proposedCharge(
  minutes: number,
  policy: Pick<
    ReturnType<typeof resolveTimePolicy>,
    "enforceIncrement" | "incrementMinutes" | "rounding"
  >,
): number {
  if (!policy.enforceIncrement || policy.rounding === "choose") return minutes;
  const scale = minutes / policy.incrementMinutes;
  const units =
    policy.rounding === "nearest"
      ? Math.round(scale)
      : policy.rounding === "down"
        ? Math.floor(scale)
        : Math.ceil(scale);
  return units * policy.incrementMinutes;
}

export function timePolicyError(draft: TimeDraft, policy: ReturnType<typeof resolveTimePolicy>) {
  return timeEntryError(draft, policy) || timeCapWarning(draft, policy);
}
const status = z.enum(["pending", "confirmed", "submitted", "approved", "invoiced", "declined"]);
const source = z.enum(["manual", "suggestion"]);
const snapshot = TimeDraftSchema.extend({
  activityLabel: z.string().max(100).optional(),
  status,
  policyDigest: z.string().length(64).optional(),
  hourlyRate: rate.optional(),
  currency: currency.optional(),
});
const history = z.object({
  revision: z.number(),
  actorId: id,
  action: z.string(),
  at: z.iso.datetime(),
  reason: z.string().optional(),
  before: snapshot.nullable(),
  after: snapshot,
});
export const TimeEntrySchema = TimeDraftSchema.extend({
  activityLabel: z.string().max(100).optional(),
  id,
  revision: z.number().int().positive(),
  workerId: id,
  authorId: id,
  status,
  source,
  history: z.array(history),
  hourlyRate: rate.optional(),
  currency: currency.optional(),
  policyDigest: z.string().length(64).optional(),
  legacy: z.boolean().optional(),
  submittedNarrative: z.string().optional(),
  suggestion: z.string().optional(),
  groupId: id.optional(),
  proposalDigest: z
    .string()
    .regex(/^[a-f\d]{64}$/)
    .optional(),
});
export type TimeEntry = z.infer<typeof TimeEntrySchema>;
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
export function adjustedTimeEntry(entry: TimeEntry, adjustments: TimeAdjustment[] = []): TimeEntry {
  const latest = adjustments
    .filter((a) => a.entryId === entry.id && a.status === "approved")
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
export const TimesheetCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("create"),
    requestId: z.uuid(),
    entry: TimeDraftSchema,
    workerIds: z.array(id).min(1).max(100).optional(),
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
    type: z.literal("declineSuggestion"),
    id,
    revision: ref.shape.revision,
  }),
  z.strictObject({
    type: z.literal("review"),
    id,
    revision: ref.shape.revision,
    narrative: text,
    billableMinutes: minutes,
    reason: text.optional(),
  }),
  z.strictObject({
    type: z.enum(["confirm", "decline", "submit", "return", "approve"]),
    entries: selection,
    reason: text.optional(),
  }),
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
  z.strictObject({
    type: z.literal("invoice"),
    adjustmentVersions: z.array(ref).max(2000).optional(),
    requestId: z.uuid(),
    templateRevision: z.number().int().nonnegative().optional(),
    entries: selection,
  }),
]);
export type TimesheetCommand = z.infer<typeof TimesheetCommandSchema>;
const invoiceSchema = z.object({
  id,
  number: z.number().int().positive().safe(),
  entries: z.array(TimeEntrySchema),
  templateRevision: z.number().int().nonnegative().optional(),
  total: z.number().nonnegative(),
  currency,
  issuedAt: z.iso.datetime(),
  clientId: id,
});
export type TimeInvoice = z.infer<typeof invoiceSchema>;
export const TimesheetStateSchema = z.object({
  userId: id,
  scope: z.string(),
  template: invoiceTemplateSchema.optional(),
  canManage: z.boolean(),
  canReview: z.boolean(),
  entries: z.array(TimeEntrySchema),
  adjustments: z.array(TimeAdjustmentSchema).optional(),
  matters: z.array(entity.extend({ clientIds: z.array(id), reference: z.string() })),
  clients: z.array(entity),
  people: z.array(entity),
  products: z.array(
    entity.extend({
      matterId: id,
      productType: productType.optional(),
      reference: productReference.optional(),
      authorId: id.optional(),
      createdAt: z.iso.datetime().optional(),
    }),
  ),
  projects: z.array(entity.extend({ matterIds: z.array(id) })),
  policies: z.array(TimePolicySchema),
  invoices: z.array(invoiceSchema),
});
export type TimesheetState = z.infer<typeof TimesheetStateSchema>;
