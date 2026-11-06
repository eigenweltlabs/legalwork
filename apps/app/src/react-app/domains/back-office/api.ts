import { z } from "@legalwork/types/back-office";
import {
  BackOfficeModelSchema,
  BackOfficeRecordSchema,
  BackOfficeViewSchema,
} from "@legalwork/types/back-office";
export const BackOfficeStateSchema = z.object({
  model: BackOfficeModelSchema,
  records: z.array(BackOfficeRecordSchema),
  views: z.array(BackOfficeViewSchema),
  permissions: z.object({
    userId: z.string(),
    model: z.boolean(),
    edit: z.boolean(),
    finance: z.boolean(),
  }),
  sync: z.object({
    enabled: z.boolean(),
    cursor: z.number(),
    pending: z.number(),
    error: z.string().nullable(),
  }),
});
export type BackOfficeState = z.infer<typeof BackOfficeStateSchema>;

export const ModelPreviewSchema = z.object({
  changes: z.array(
    z.object({ object: z.string(), action: z.string(), records: z.number() }),
  ),
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type ModelPreview = z.infer<typeof ModelPreviewSchema>;
