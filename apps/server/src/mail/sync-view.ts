import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Public progress contains durable counts and fixed error codes, never provider responses or cursors. */
export const mailSyncViewSchema = z.object({
  accountId: z.string().min(1).max(4096),
  provider: z.literal("gmail"),
  state: z.enum(["idle", "syncing", "paused", "waiting", "complete", "attention"]),
  enumerated: count,
  downloaded: count,
  projected: count,
  failed: count,
  pending: count,
  nextRetryAt: count.nullable(),
  error: z.enum(["reconsent_required", "configuration_invalid", "provider_unavailable", "rate_limited",
    "message_unavailable", "content_incomplete", "storage_unavailable", "sync_failed"]).nullable(),
}).strict();
export type MailSyncView = z.infer<typeof mailSyncViewSchema>;
