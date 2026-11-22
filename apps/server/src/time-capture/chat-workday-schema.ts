import { z } from "zod";

const date = z.iso.date();
export const chatWorkdayAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read"), date }),
  z.strictObject({ action: z.literal("guidelines"), date, matterId: z.string().min(1).max(200) }),
  z.strictObject({
    action: z.literal("publish"), date, revision: z.string().min(1).max(80),
    guidelineReceipts: z.array(z.string().max(80)).max(100).optional(),
    suggestions: z.array(z.strictObject({
      evidence: z.array(z.string().min(1).max(80)).min(1).max(200),
      narrative: z.string().trim().min(1).max(2000),
      activity: z.string().min(1).max(100).optional(),
      startAt: z.iso.datetime({ offset: true }).optional(),
      endAt: z.iso.datetime({ offset: true }).optional(),
      estimatedMinutes: z.number().int().min(1).max(1440).optional(),
      estimateReason: z.string().trim().min(1).max(500).optional(),
    })).max(100),
    remove: z.array(z.uuid()).max(100).optional(),
    complete: z.boolean().optional(),
  }),
]);
