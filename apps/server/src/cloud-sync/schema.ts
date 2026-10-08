import { z } from "zod";
import { projectDetailsSchema } from "../project-store.js";

export const SyncId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const BlobSchema = z.object({
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  chunks: z.array(Sha256).max(4096),
}).strict();
export type BlobReference = z.infer<typeof BlobSchema>;

export const ProjectSchema = z.object({
  id: SyncId,
  name: z.string().max(512),
  preset: z.string().max(128),
  sourcePath: z.string().max(4096),
  projectId: z.string().uuid().nullable().default(null),
  details: projectDetailsSchema.optional(),
}).strict();
export type SyncProject = z.infer<typeof ProjectSchema>;

export const CheckpointSchema = z.object({
  version: z.literal(1),
  engineVersion: z.string(),
  timeZone: z.string().refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }),
  approval: z.object({ mode: z.enum(["manual", "auto"]), timeoutMs: z.number().int().positive() }).optional(),
  projects: z.array(ProjectSchema).max(5000),
  runtime: BlobSchema.nullable(),
  engine: BlobSchema.nullable(),
}).strict().refine(value => new Set(value.projects.map(project => project.id)).size === value.projects.length, "Duplicate project identities");
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const ControlSchema = z.object({
  version: z.literal(1),
  epoch: z.number().int().nonnegative(),
  owner: SyncId.nullable(),
  expiresAt: z.number().int().nonnegative(),
  checkpoint: BlobSchema.nullable(),
  checkpointAt: z.number().int().nonnegative(),
  nextRunAt: z.string().nullable(),
}).strict();
export type SyncControl = z.infer<typeof ControlSchema>;
export const emptyControl: SyncControl = { version: 1, epoch: 0, owner: null, expiresAt: 0, checkpoint: null, checkpointAt: 0, nextRunAt: null };

export const SyncConfigSchema = z.object({
  version: z.literal(1),
  accountId: SyncId,
  deviceId: SyncId,
  deviceName: z.string().min(1).max(128),
  store: z.object({ type: z.literal("platform") }).strict(),
  // Files can sync from any device; only this device runs the copied assistant.
  role: z.enum(["executor", "files"]),
  projectIds: z.array(SyncId).default([]),
  projectsDirectory: z.string().optional(),
  intervalMs: z.number().int().min(5000).max(300000).default(30000),
  leaseMs: z.number().int().min(60000).max(900000).default(180000),
}).strict();
export type CloudSyncConfig = z.infer<typeof SyncConfigSchema>;
