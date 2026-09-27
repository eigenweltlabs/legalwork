import { z } from "zod";
export const JevSearchProgressSchema = z.object({
  jobId: z.string().uuid(), status: z.enum(["running", "complete", "cancelled", "interrupted"]),
  total: z.number().nonnegative(), processed: z.number().nonnegative(), counts: z.record(z.string(), z.number()),
});
export type JevSearchProgress = z.infer<typeof JevSearchProgressSchema>;
export const JevSearchCardSchema = z.object({ ok: z.literal(true), workspaceId: z.string(), data: JevSearchProgressSchema });
