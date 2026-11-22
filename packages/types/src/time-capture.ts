import { z } from "zod";
import { BackOfficeValueSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { TimePolicySchema } from "@legalwork/types/timesheet";

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
export function sameCaptureAccount(a: CaptureAccount, b: CaptureAccount) {
  return a.provider === b.provider && a.account === b.account;
}
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
export function workdaySchedule(settings: Pick<CaptureSettings, "schedule" | "intervalMinutes">): WorkdaySchedule {
  return settings.schedule ?? (Boolean(settings.intervalMinutes) ? { frequency: "hourly" } : { frequency: "daily", times: ["08:00", "20:00"] });
}
export const captureSettingsSchema = z.strictObject({
  calendar: z.boolean(),
  tasks: z.boolean(),
  documents: z.boolean().optional(),
  workspaceActivity: z.boolean().optional(),
  desktopActivity: z.boolean().optional(),
  recordings: z.boolean().optional(),
  stopwatchMode: z.enum(["always", "evidence"]).optional(),
  enabled: z.boolean().optional(),
  schedule: workdayScheduleSchema.optional(),
  /** Read profiles written before scheduling was introduced. */
  aiSuggestions: z.boolean().optional(),
  model: workdayModelSchema.partial({ workspaceId: true }).optional(),
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
type AccountSelection = Pick<CaptureSettings, "connections" | "disabledConnections" | "fileConnections">;
export function captureAccountEnabled(settings: AccountSelection, account: CaptureAccount) {
  if (settings.connections) return settings.connections.some(choice => sameCaptureAccount(choice, account));
  if (captureFileSource(account.provider)) return Boolean(settings.fileConnections?.some(choice => sameCaptureAccount(choice, account)));
  return !settings.disabledConnections?.some(choice => sameCaptureAccount(choice, account));
}
export function captureEnabled(settings: CaptureSettings, accounts?: CaptureAccount[]) {
  return settings.enabled !== false && (
    settings.calendar ||
    settings.tasks ||
    settings.documents === true ||
    settings.workspaceActivity !== false || settings.desktopActivity === true || settings.recordings === true ||
    settings.stopwatchMode === "evidence" ||
    (accounts ? accounts.some(account => captureAccountEnabled(settings, account)) : settings.connections === undefined || settings.connections.length > 0)
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
  | { type: "suggest"; model?: WorkdayModel }
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

const stopwatchMatterId = z.string().min(1).max(200);
export const stopwatchActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), id: z.uuid(), matterId: stopwatchMatterId }),
  z.strictObject({ type: z.literal("assign"), id: z.uuid(), matterId: stopwatchMatterId }),
  z.strictObject({ type: z.literal("stop"), id: z.uuid() }),
]);
export const stopwatchStateSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: z.string().length(64),
  // Existing runs without a matter can still be resumed and assigned.
  active: z.object({ id: z.uuid(), startedAt: z.iso.datetime(), matterId: stopwatchMatterId.nullable().default(null) }).nullable(),
  lastStopped: z.object({ id: z.uuid(), stoppedAt: z.iso.datetime(), date: z.iso.date() }).nullable(),
  matters: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
export type StopwatchAction = z.infer<typeof stopwatchActionSchema>;
export type StopwatchState = z.infer<typeof stopwatchStateSchema>;
