import { z } from "zod";
import { BackOfficeValueSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { TimePolicySchema, appliedTimePolicies, resolveTimePolicy, proposedCharge, proposedStopwatchCharge, type TimesheetState, type TimePolicy } from "@legalwork/types/timesheet";

export const desktopActivitySampleSchema = z.strictObject({
  platform: z.enum(["darwin", "win32", "unsupported"]),
  permission: z.enum(["granted", "needed", "unavailable"]),
  state: z.enum(["active", "idle", "locked", "unavailable"]),
  observedAt: z.number().int().positive(),
  idleSeconds: z.number().nonnegative(),
  application: z.string().trim().min(1).max(240).optional(),
  documentName: z.string().trim().min(1).max(240).optional(),
  isLegalWork: z.boolean().optional(),
});
export type DesktopActivitySample = z.infer<typeof desktopActivitySampleSchema>;
export const fileCaptureProviders = ["google-drive", "onedrive", "onedrive-personal", "sharepoint-files"] as const;
export const captureProviders = ["gmail", "outlook", "google-calendar", "outlook-calendar", ...fileCaptureProviders] as const;

export const captureAccountSchema = z.object({
  provider: z.enum(captureProviders),
  account: z.string().length(64),
  name: z.string().max(320).optional(),
});
export function captureFileSource(source: string) {
  return fileCaptureProviders.some(id => id === source);
}
export type CaptureAccount = z.infer<typeof captureAccountSchema>;
export const workdayModelSchema = z.object({
  workspaceId: z.string().min(1).max(200), providerID: z.string().min(1).max(200), modelID: z.string().min(1).max(300),
});
export type WorkdayModel = z.infer<typeof workdayModelSchema>;
export type WorkdayModelOption = WorkdayModel & { label: string };
export const localWorkdayModel: WorkdayModel = { workspaceId: "local", providerID: "local", modelID: "llama.cpp" };
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const workdayScheduleSchema = z.discriminatedUnion("frequency", [
  z.strictObject({ frequency: z.literal("hourly") }),
  z.strictObject({ frequency: z.literal("daily"), times: z.array(timeOfDaySchema).min(1).max(24)
    .refine(times => new Set(times).size === times.length, "Choose different run times.") }),
]);
export type WorkdaySchedule = z.infer<typeof workdayScheduleSchema>;
export const defaultWorkdayRunTime = "18:00";

export function workdaySchedule(settings: Pick<CaptureSettings, "schedule" | "intervalMinutes">): WorkdaySchedule {
  return settings.schedule ?? (Boolean(settings.intervalMinutes) ? { frequency: "hourly" } : { frequency: "daily", times: [defaultWorkdayRunTime] });
}
export const captureSettingsSchema = z.strictObject({
  calendar: z.boolean(),
  tasks: z.boolean(),
  documents: z.boolean().optional(),
  workspaceActivity: z.boolean().optional(),
  desktopActivity: z.boolean().optional(),
  recordings: z.boolean().optional(),
  /** Accepted for older profiles and clients. Stopped timers are always shown for manual review. */
  stopwatchMode: z.enum(["always", "evidence"]).optional(),
  enabled: z.boolean().optional(),
  schedule: workdayScheduleSchema.optional(),
  /** Read profiles written before scheduling was introduced. */
  aiSuggestions: z.boolean().optional(),
  model: workdayModelSchema.partial({ workspaceId: true }).optional(),
  /** Legacy source selections. Connected accounts are now selected in Integrations. */
  connections: z.array(captureAccountSchema).max(16).optional(),
  disabledConnections: z.array(captureAccountSchema).optional(),
  fileConnections: z.array(captureAccountSchema).max(16).optional(),
  intervalMinutes: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]).optional(),
});
export const captureSettingsChangeSchema = z.discriminatedUnion("field", [
  z.strictObject({ field: z.enum(["enabled", "calendar", "tasks", "documents", "workspaceActivity", "desktopActivity", "recordings"]), value: z.boolean() }),
  z.strictObject({ field: z.literal("model"), value: captureSettingsSchema.shape.model.unwrap().nullable() }),
  z.strictObject({ field: z.literal("stopwatchMode"), value: captureSettingsSchema.shape.stopwatchMode.unwrap() }),
  z.strictObject({ field: z.literal("schedule"), value: workdayScheduleSchema }),
  z.strictObject({ field: z.literal("account"), account: captureAccountSchema, value: z.boolean() }),
]);
export const captureSettingsPatchSchema = z.strictObject({ type: z.literal("settings-patch"), change: captureSettingsChangeSchema });
export function captureEnabled(settings: CaptureSettings, accounts?: CaptureAccount[]) {
  return settings.enabled !== false && (
    settings.calendar ||
    settings.tasks ||
    settings.documents === true ||
    settings.workspaceActivity !== false || settings.desktopActivity === true || settings.recordings === true ||
    (accounts === undefined || accounts.length > 0)
  );
}
export const captureProposalSchema = z.object({
  key: z.uuid(),
  digest: z.string().length(64),
  date: z.iso.date(),
  source: z.enum(["calendar", "tasks", "documents", "stopwatch", "workspace", "agent", "desktop", "recordings", ...captureProviders]),
  account: z.string().length(64).optional(),
  matterId: z.string().max(200).optional(),
  documentId: z.string().min(1).max(200).optional(),
  workProductId: z.string().min(1).max(200).optional(),
  observation: z.enum(["foreground", "passive", "agent"]).optional(),
  agentVisibility: z.enum(["foreground", "background"]).optional(),
  observedAt: z.iso.datetime().optional(),
  fileUseSource: z.enum(["spotlight-last-used", "windows-shell-recent"]).optional(),
  desktopContext: z.object({ platform: z.enum(["darwin", "win32"]), application: z.string().max(240), documentName: z.string().max(240).optional() }).optional(),
  mailDirection: z.enum(["sent", "received"]).optional(),
  threadKey: z.string().length(64).optional(),
  changeSummary: z.string().trim().min(1).max(1000).optional(),
  parentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  projectId: z.string().nullable(),
  activity: z.string(),
  narrative: z.string(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  workedMinutes: z.number().int().nullable(),
  estimatedMinutes: z.number().int().min(1).max(1440).optional(),
  estimateReason: z.string().trim().min(1).max(500).optional(),
  chargeMinutes: z.number().int().min(0).max(1440).optional(),
  suggested: z.boolean().optional(),
  dismissed: z.boolean(),
  versions: z.array(z.string()).optional(),
});
const privateValuesSchema = z.record(z.string().max(200), BackOfficeValueSchema);
const privateRevision = z.number().int().nonnegative();
export const privateEntryDraftSchema = z.object({ date: z.iso.date(), values: privateValuesSchema,
  proposalDigest: z.string().length(64).optional(), revision: privateRevision.optional() });
export const privateDraftPatchSchema = z.strictObject({
  type: z.literal("draft-patch"), key: z.uuid(), date: z.iso.date(), proposalDigest: z.string().length(64).optional(),
  revision: privateRevision, changes: privateValuesSchema.nullable(), initial: privateValuesSchema.optional(),
});
export type PrivateDraftPatch = z.infer<typeof privateDraftPatchSchema>;
export const privateBookingRevisionSchema = z.strictObject({ date: z.iso.date(), revision: privateRevision });
export type PrivateBookingRevision = z.infer<typeof privateBookingRevisionSchema>;
const wordingSchema = z.object({ narrative: z.string().trim().min(1).max(2000), activity: z.string().trim().min(1).max(100) });
export const workdayStatusSchema = z.object({
  type: z.enum(["ready", "unavailable", "failed"]), message: z.string(), failedSources: z.array(captureAccountSchema).optional(),
  reason: z.enum(["timeout", "invalid_output", "model_unavailable", "provider_failed", "sources_failed"]).optional(),
});
export const workdayGuidelineSchema = z.strictObject({
  id: z.uuid(), revision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(240),
  scope: z.enum(["firm", "client", "matter"]), targetId: z.string().min(1).max(200), effectiveFrom: z.iso.date(),
  rules: TimePolicySchema.pick({
    language: true, actionWords: true, narrativeCorrections: true, narrativeExample: true, actionFirst: true,
    minimumMinutes: true, maxMinutes: true, activityLimits: true, incrementMinutes: true,
    enforceIncrement: true, rounding: true, stopwatchRoundUp: true,
  }).extend({ instructions: z.string().trim().min(1).max(20_000).optional() }),
});
export const workdayGuidelineActionSchema = z.strictObject({ type: z.literal("guideline"), guideline: workdayGuidelineSchema });
export const guidelineRuleFields = ["minimumMinutes", "maxMinutes", "incrementMinutes", "enforceIncrement", "rounding", "stopwatchRoundUp", "activityLimits"] as const;
export const guidelineRuleSuggestionsSchema = z.strictObject({
  rules: workdayGuidelineSchema.shape.rules.pick({ minimumMinutes: true, maxMinutes: true, incrementMinutes: true,
    enforceIncrement: true, rounding: true, stopwatchRoundUp: true, activityLimits: true }).strict(),
  evidence: z.partialRecord(z.enum(guidelineRuleFields), z.string().trim().min(1).max(2000)),
  notes: z.array(z.string().trim().min(1).max(1000)).max(10),
});
export type GuidelineRuleSuggestions = z.infer<typeof guidelineRuleSuggestionsSchema>;
export const captureStateSchema = z.object({
  settings: captureSettingsSchema,
  modelReady: z.boolean(),
  wording: z.record(z.string(), wordingSchema).optional(),
  proposals: z.array(captureProposalSchema),
  drafts: z.record(z.string(), privateEntryDraftSchema).default({}),
  connections: z.array(captureAccountSchema).default([]),
  guidelines: z.array(workdayGuidelineSchema).default([]),
  status: workdayStatusSchema.optional(),
  checkedThrough: z.iso.datetime().optional(),
});
export const workdayGenerationProgressSchema = z.object({
  runId: z.uuid(), date: z.iso.date(), phase: z.enum(["collecting", "grouping", "wording", "saving"]),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative().nullable(), proposals: z.array(captureProposalSchema),
});
export type WorkdayGenerationProgress = z.infer<typeof workdayGenerationProgressSchema>;
export type WorkdayGuideline = z.infer<typeof workdayGuidelineSchema>;
export type CaptureProposal = z.infer<typeof captureProposalSchema>;
/** Keep sub-minute stopwatch evidence when proposing invoice units, avoiding double rounding. */
export function captureChargeMinutes(p: Pick<CaptureProposal, "source" | "workedMinutes" | "estimatedMinutes" | "startAt" | "endAt">) {
  if (p.source === "stopwatch" && p.startAt && p.endAt) {
    const minutes = (Date.parse(p.endAt) - Date.parse(p.startAt)) / 60000;
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return p.workedMinutes ?? p.estimatedMinutes ?? null;
}
export type CaptureSettings = z.infer<typeof captureSettingsSchema>;
export type CaptureState = z.infer<typeof captureStateSchema>;

export type CaptureAction =
  | WorkdayCorrection
  | z.infer<typeof workdayGuidelineActionSchema>
  | { type: "settings"; settings: CaptureSettings }
  | z.infer<typeof captureSettingsPatchSchema>
  | { type: "suggest"; model?: WorkdayModel; runId?: string }
  | { type: "calendar" }
  | { type: "dismiss"; key: string; digest?: string }
  | { type: "draft"; key: string; date?: string; values: Record<string, BackOfficeValue> | null; proposalDigest?: string }
  | PrivateDraftPatch
  | ReconcileCapture;

export const reconcileCaptureSchema = z.strictObject({
  type: z.literal("reconcile"),
  key: z.uuid(),
  digest: z.string().length(64),
  recordId: z.uuid(),
  recordRevision: z.number().int().nonnegative(),
  draftRevision: privateRevision.optional(),
});
export type ReconcileCapture = z.infer<typeof reconcileCaptureSchema>;

export const workdayCorrectionSchema = z.strictObject({
  type: z.literal("correct"),
  key: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  draftRevision: privateRevision.optional(),
  narrative: z.string().trim().min(1).max(2000),
  activity: z.string().trim().min(1).max(100).nullable().optional(),
  matterId: z.string().min(1).max(200).nullable(),
  projectId: z.string().min(1).max(200).nullable(),
  startAt: z.iso.datetime({ offset: true }).nullable(),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  workedMinutes: z.number().int().min(1).max(1440).nullable(),
  clearEstimate: z.literal(true).optional(),
  split: z
    .strictObject({
      minutes: z.number().int().min(1).max(1439),
      matterId: z.string().min(1).max(200),
      projectId: z.string().max(200).nullable(),
    })
    .optional(),
});
export type WorkdayCorrection = z.infer<typeof workdayCorrectionSchema>;

const quickNote = z.string().trim().max(2000);
const stopwatchMatterId = z.string().min(1).max(200);
export const stopwatchActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), id: z.uuid(), matterId: stopwatchMatterId.nullish(), note: quickNote.optional() }),
  z.strictObject({ type: z.literal("assign"), id: z.uuid(), matterId: stopwatchMatterId.nullable() }),
  z.strictObject({ type: z.literal("stop"), id: z.uuid(), note: quickNote.optional() }),
]);
export const stopwatchStateSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: z.string().length(64),
  // Existing runs without a matter can still be resumed and assigned.
  active: z.object({ id: z.uuid(), startedAt: z.iso.datetime(), note: quickNote.optional(), matterId: stopwatchMatterId.nullable().default(null) }).nullable(),
  lastStopped: z.object({ id: z.uuid(), stoppedAt: z.iso.datetime(), date: z.iso.date() }).nullable(),
  matters: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
export type StopwatchAction = z.infer<typeof stopwatchActionSchema>;
export type StopwatchState = z.infer<typeof stopwatchStateSchema>;

export function visibleGuideline(
  guideline: WorkdayGuideline,
  state: Pick<TimesheetState, "clients" | "matters">,
) {
  if (guideline.scope === "firm") return guideline.targetId === "firm";
  return (guideline.scope === "client" ? state.clients : state.matters).some(
    (record) => record.id === guideline.targetId,
  );
}

function guidelineVersion(
  guidelines: WorkdayGuideline[],
  scope: "firm" | "client" | "matter",
  target?: string,
) {
  return guidelines
    .filter((item) => item.scope === scope && item.targetId === target)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.revision - a.revision ||
        a.id.localeCompare(b.id),
    )[0];
}

export function draftRules(
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  matter: TimesheetState["matters"][number],
  date: string,
  projectId?: string,
  clientId = visibleSingleClient(matter, state) ?? "",
) {
  const versions = effectiveWorkdayGuidelines(state, guidelines, {
    clientId,
    matterId: matter.id,
    date,
  });
  const guidelineInstructions: string[] = [];
  let policies = [...state.policies];
  for (const version of versions) {
    const {
      scope,
      targetId,
      effectiveFrom,
      revision,
      rules: { instructions, ...rules },
    } = version;
    if (instructions) guidelineInstructions.push(instructions);
    const published = appliedTimePolicies(state.policies, scope, targetId, date, clientId, projectId)
      .find(policy => !policy.agreementId && !(policy.revision === 0 && policy.effectiveFrom === "0001-01-01"));
    const imported: TimePolicy = { scope, targetId, effectiveFrom, revision, ...rules };
    if (!published) policies.push(imported);
    else {
      // Published fields win, while unrelated local drafting instructions and
      // limits remain available. Contractual agreement layers stay untouched.
      const merged: TimePolicy = { ...imported,
        ...Object.fromEntries(Object.entries(published).filter(([, value]) => value !== undefined)),
        scope: published.scope, targetId: published.targetId, effectiveFrom: published.effectiveFrom, revision: published.revision,
        actionWords: { ...rules.actionWords, ...published.actionWords },
        narrativeCorrections: { ...rules.narrativeCorrections, ...published.narrativeCorrections },
        activityLimits: { ...rules.activityLimits, ...published.activityLimits },
      };
      policies = policies.map(policy => policy === published ? merged : policy);
    }
  }
  const {
    language,
    actionWords,
    narrativeCorrections,
    narrativeExample,
    actionFirst,
    activityLabels,
    minimumMinutes = 0,
    maxMinutes,
    activityLimits,
    incrementMinutes,
    enforceIncrement,
    rounding,
    stopwatchRoundUp,
  } = resolveTimePolicy(
    policies,
    clientId,
    matter.id,
    date,
    projectId,
    // Private draft defaults cannot change the binding client term or its authorized exceptions.
    state.policies,
  );
  return {
    language,
    actionWords,
    narrativeCorrections,
    narrativeExample,
    actionFirst,
    activityLabels,
    guidelineInstructions,
    minimumMinutes,
    maxMinutes,
    activityLimits,
    incrementMinutes,
    enforceIncrement,
    rounding,
    stopwatchRoundUp,
  };
}

export function effectiveWorkdayGuidelines(
  state: TimesheetState,
  guidelines: WorkdayGuideline[],
  {
    clientId,
    matterId,
    date,
  }: { clientId: string; matterId: string; date: string },
) {
  const matter = state.matters.find((item) => item.id === matterId);
  if (!matter) return [];
  const client =
    matter.clientIds.includes(clientId) &&
    state.clients.some((item) => item.id === clientId)
      ? clientId
      : undefined;
  const eligible = guidelines.filter(
    (guideline) =>
      guideline.effectiveFrom <= date && visibleGuideline(guideline, state),
  );
  // Selection is shared by drafting and invoice review. Precedence belongs to
  // individual rule fields, never to an entire uploaded document.
  return [
    guidelineVersion(eligible, "firm", "firm"),
    guidelineVersion(eligible, "client", client),
    guidelineVersion(eligible, "matter", matter.id),
  ].flatMap(version => version ? [version] : []);
}

export function visibleSingleClient(
  matter: TimesheetState["matters"][number],
  state: TimesheetState,
) {
  if (
    matter.clientIds.length === 1 &&
    state.clients.some((client) => client.id === matter.clientIds[0])
  )
    return matter.clientIds[0];
}

export function workdayRuleSources(state: TimesheetState, matter: TimesheetState["matters"][number], date: string, projectId?: string) {
  const client = visibleSingleClient(matter, state);
  const targets = { firm: "firm", client, matter: matter.id, project: projectId };
  return (["firm", "client", "matter", "project"] as const).flatMap(scope =>
    appliedTimePolicies(state.policies, scope, targets[scope], date, client, projectId).map(policy => ({
      scope, targetId: policy.targetId, effectiveFrom: policy.effectiveFrom, revision: policy.revision,
      source: policy.agreementId ? "feeAgreement" as const : "billingPolicy" as const,
      recordId: policy.agreementId,
    }))
  );
}

export function workdayBillableMinutes(
  minutes: number,
  rules: Pick<ReturnType<typeof draftRules>, "activityLimits" | "minimumMinutes" | "maxMinutes" | "enforceIncrement" | "incrementMinutes" | "rounding" | "stopwatchRoundUp">,
  activity: string,
  stopwatch = false,
) {
  if (minutes <= 0) return;
  const maxMinutes =
    rules.activityLimits[activity] ?? rules.maxMinutes;
  if (rules.minimumMinutes > maxMinutes) return;
  const step =
    rules.enforceIncrement || stopwatch
      ? rules.incrementMinutes
      : 1;
  const lower = Math.ceil(rules.minimumMinutes / step) * step,
    upper = Math.floor(maxMinutes / step) * step;
  if (lower > upper) return;
  const charge =
    stopwatch
      ? proposedStopwatchCharge(minutes, rules)
      : proposedCharge(minutes, rules);
  if (step > 1 && charge % step !== 0 && charge >= lower && charge <= upper)
    return;
  return Math.min(upper, Math.max(lower, charge));
}
