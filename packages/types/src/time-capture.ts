import { z } from "zod";

export const captureProviders = ["gmail", "outlook", "google-calendar", "outlook-calendar"] as const;
export const captureAccountSchema = z.object({
  provider: z.enum(captureProviders),
  account: z.string().length(64),
});
export type CaptureAccount = z.infer<typeof captureAccountSchema>;
export function sameCaptureAccount(a: CaptureAccount, b: CaptureAccount) {
  return a.provider === b.provider && a.account === b.account;
}
export const captureSettingsSchema = z.strictObject({
  calendar: z.boolean(),
  tasks: z.boolean(),
  documents: z.boolean().optional(),
  connections: z.array(captureAccountSchema).max(16).optional(),
  intervalMinutes: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]),
});
export function captureEnabled(settings: CaptureSettings) {
  return (
    settings.calendar ||
    settings.tasks ||
    settings.documents === true ||
    Boolean(settings.connections?.length)
  );
}
export const captureProposalSchema = z.object({
  key: z.uuid(),
  digest: z.string().length(64),
  date: z.iso.date(),
  source: z.enum(["calendar", "tasks", "documents", ...captureProviders]),
  account: z.string().length(64).optional(),
  matterId: z.string().max(200).optional(),
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
  dismissed: z.boolean(),
  versions: z.array(z.string()).optional(),
});
export const captureStateSchema = z.object({
  settings: captureSettingsSchema,
  modelReady: z.boolean(),
  proposals: z.array(captureProposalSchema),
  connections: z.array(captureAccountSchema).default([]),
});
export type CaptureProposal = z.infer<typeof captureProposalSchema>;
export type CaptureSettings = z.infer<typeof captureSettingsSchema>;
export type CaptureState = z.infer<typeof captureStateSchema>;

export type CaptureAction =
  | WorkdayCorrection
  | { type: "settings"; settings: CaptureSettings }
  | { type: "run" | "calendar" }
  | { type: "dismiss"; key: string };

export const workdayCorrectionSchema = z.strictObject({
  type: z.literal("correct"),
  key: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  narrative: z.string().trim().min(1).max(2000),
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
