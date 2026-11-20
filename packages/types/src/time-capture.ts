import { z } from "zod";
import { BackOfficeValueSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import { TimePolicySchema } from "@legalwork/types/timesheet";

export const captureProviders = ["gmail", "outlook", "google-calendar", "outlook-calendar"] as const;
export const captureAccountSchema = z.object({
  provider: z.enum(captureProviders),
  account: z.string().length(64),
});
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
export const captureSettingsSchema = z.strictObject({
  calendar: z.boolean(),
  tasks: z.boolean(),
  documents: z.boolean().optional(),
  workspaceActivity: z.boolean().optional(),
  stopwatchMode: z.enum(["always", "evidence"]).optional(),
  aiSuggestions: z.boolean().optional(),
  model: workdayModelSchema.partial({ workspaceId: true }).optional(),
  connections: z.array(captureAccountSchema).max(16).optional(),
  disabledConnections: z.array(captureAccountSchema).optional(),
  intervalMinutes: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]),
});
type AccountSelection = Pick<CaptureSettings, "connections" | "disabledConnections">;
export function captureAccountEnabled(settings: AccountSelection, account: CaptureAccount) {
  if (settings.connections) return settings.connections.some(choice => sameCaptureAccount(choice, account));
  return !settings.disabledConnections?.some(choice => sameCaptureAccount(choice, account));
}
export function captureEnabled(settings: CaptureSettings, accounts?: CaptureAccount[]) {
  return (
    settings.calendar ||
    settings.tasks ||
    settings.documents === true ||
    settings.workspaceActivity !== false ||
    settings.stopwatchMode === "evidence" ||
    (accounts ? accounts.some(account => captureAccountEnabled(settings, account)) : settings.connections === undefined || settings.connections.length > 0)
  );
}
export const captureProposalSchema = z.object({
  key: z.uuid(),
  digest: z.string().length(64),
  date: z.iso.date(),
  source: z.enum(["calendar", "tasks", "documents", "stopwatch", "workspace", "agent", ...captureProviders]),
  account: z.string().length(64).optional(),
  matterId: z.string().max(200).optional(),
  documentId: z.string().min(1).max(200).optional(),
  workProductId: z.string().min(1).max(200).optional(),
  observation: z.enum(["foreground", "passive", "agent"]).optional(),
  observedAt: z.iso.datetime().optional(),
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
  chargeMinutes: z.number().int().min(0).max(1440).optional(),
  suggested: z.boolean().optional(),
  dismissed: z.boolean(),
  versions: z.array(z.string()).optional(),
});
export const privateEntryDraftSchema = z.object({ date: z.iso.date(), values: z.record(z.string(), BackOfficeValueSchema), proposalDigest: z.string().length(64).optional() });
const wordingSchema = z.object({ narrative: z.string().trim().min(1).max(2000), activity: z.string().trim().min(1).max(100) });
const allScopes = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("personal") }),
  z.strictObject({ scope: z.literal("matter"), matterId: z.string().min(1).max(200) }),
  z.strictObject({ scope: z.literal("document"), documentId: z.string().min(1).max(200), matterId: z.string().min(1).max(200).optional() }),
]);
const instructionText = z.string().trim().min(1).max(2000);
export const workdayChatSchema = z.object({
  id: z.uuid(), role: z.enum(["user", "assistant"]), text: instructionText,
  permanent: z.boolean().optional(), replyTo: z.uuid().optional(),
});
export const savedWorkdayInstructionSchema = z.object({
  id: z.uuid(), text: instructionText, scope: z.enum(["personal", "matter", "document"]),
  matterId: z.string().min(1).max(200).optional(), documentId: z.string().min(1).max(200).optional(),
});
export const workdayChatActionSchema = z.strictObject({
  type: z.literal("chat"), id: z.uuid(), text: instructionText, model: workdayModelSchema.optional(), instruction: allScopes.optional(),
});
export const workdayInstructionActionSchema = z.strictObject({
  type: z.literal("instruction"), id: z.uuid(), text: instructionText.nullable(),
});
export const workdayStatusSchema = z.object({ type: z.enum(["ready", "unavailable", "failed"]), message: z.string() });
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
export const captureStateSchema = z.object({
  settings: captureSettingsSchema,
  modelReady: z.boolean(),
  wording: z.record(z.string(), wordingSchema).optional(),
  proposals: z.array(captureProposalSchema),
  drafts: z.record(z.string(), privateEntryDraftSchema).default({}),
  connections: z.array(captureAccountSchema).default([]),
  chat: z.array(workdayChatSchema).default([]),
  instructions: z.array(savedWorkdayInstructionSchema).default([]),
  guidelines: z.array(workdayGuidelineSchema).default([]),
  status: workdayStatusSchema.optional(),
});
export type WorkdayInstruction = z.infer<typeof savedWorkdayInstructionSchema>;
export type WorkdayGuideline = z.infer<typeof workdayGuidelineSchema>;
export type CaptureProposal = z.infer<typeof captureProposalSchema>;
/** Keep sub-minute stopwatch evidence when proposing invoice units, avoiding double rounding. */
export function captureChargeMinutes(p: Pick<CaptureProposal, "source" | "workedMinutes" | "startAt" | "endAt">) {
  if (p.source === "stopwatch" && p.startAt && p.endAt) {
    const minutes = (Date.parse(p.endAt) - Date.parse(p.startAt)) / 60000;
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return p.workedMinutes;
}
export type CaptureSettings = z.infer<typeof captureSettingsSchema>;
export type CaptureState = z.infer<typeof captureStateSchema>;

export type CaptureAction =
  | WorkdayCorrection
  | z.infer<typeof workdayChatActionSchema>
  | z.infer<typeof workdayInstructionActionSchema>
  | z.infer<typeof workdayGuidelineActionSchema>
  | { type: "settings"; settings: CaptureSettings }
  | { type: "suggest" | "refresh"; model?: WorkdayModel }
  | { type: "run" | "calendar" }
  | { type: "dismiss"; key: string; digest?: string }
  | { type: "draft"; key: string; date?: string; values: Record<string, BackOfficeValue> | null; proposalDigest?: string }
  | ReconcileCapture;

export const reconcileCaptureSchema = z.strictObject({
  type: z.literal("reconcile"),
  key: z.uuid(),
  digest: z.string().length(64),
  recordId: z.uuid(),
  recordRevision: z.number().int().nonnegative(),
});
export type ReconcileCapture = z.infer<typeof reconcileCaptureSchema>;

export const workdayCorrectionSchema = z.strictObject({
  type: z.literal("correct"),
  key: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  narrative: z.string().trim().min(1).max(2000),
  activity: z.string().min(1).max(100).optional(),
  matterId: z.string().min(1).max(200).nullable(),
  projectId: z.string().min(1).max(200).nullable(),
  startAt: z.iso.datetime({ offset: true }).nullable(),
  endAt: z.iso.datetime({ offset: true }).nullable(),
  workedMinutes: z.number().int().min(1).max(1440).nullable(),
  split: z
    .strictObject({
      minutes: z.number().int().min(1).max(1439),
      matterId: z.string().min(1).max(200),
      projectId: z.string().max(200).nullable(),
    })
    .optional(),
});
export type WorkdayCorrection = z.infer<typeof workdayCorrectionSchema>;

export const stopwatchActionSchema = z.strictObject({
  type: z.enum(["start", "stop", "assign"]),
  id: z.uuid(),
  projectId: z.string().min(1).max(200).optional(),
});
export const stopwatchStateSchema = z.object({
  profileId: z.string().length(64),
  active: z.object({ id: z.uuid(), startedAt: z.iso.datetime(), projectId: z.string().nullable().default(null) }).nullable(),
  lastStopped: z.object({ id: z.uuid(), stoppedAt: z.iso.datetime(), date: z.iso.date() }).nullable(),
  projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type StopwatchAction = z.infer<typeof stopwatchActionSchema>;
export type StopwatchState = z.infer<typeof stopwatchStateSchema>;
