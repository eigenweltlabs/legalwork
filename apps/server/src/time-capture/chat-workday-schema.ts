import { z } from "zod";

const date = z.iso.date();
const entryRef = { date, id: z.string().min(1).max(200), revision: z.number().int().positive() };
const entryChanges = z.strictObject({
  narrative: z.string().trim().min(1).max(2000).optional(),
  matterId: z.string().min(1).max(200).optional(),
  serviceDate: date.optional(),
  recordedMinutes: z.number().int().min(0).max(1440).optional(),
  billableMinutes: z.number().int().min(0).max(1440).optional(),
}).refine(value => Object.keys(value).length > 0, "Choose a field to update.");
export const chatWorkdayAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("read"), date }),
  z.strictObject({ action: z.literal("update_suggestion"), date, key: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
    draftRevision: z.number().int().nonnegative(), changes: z.strictObject({
      narrative: z.string().trim().min(1).max(2000).optional(),
      matterId: z.string().min(1).max(200).nullable().optional(),
      activity: z.string().trim().min(1).max(100).nullable().optional(),
      recordedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      startAt: z.iso.datetime({ offset: true }).nullable().optional(),
      endAt: z.iso.datetime({ offset: true }).nullable().optional(),
    }).refine(value => Object.keys(value).length > 0, "Choose a field to update.")
      .refine(value => (value.startAt === undefined) === (value.endAt === undefined), "Provide both clock fields.") }),
  z.strictObject({ action: z.literal("list_entries"), date }),
  z.strictObject({ action: z.literal("update_entry"), ...entryRef, changes: entryChanges }),
  z.strictObject({ action: z.literal("remove_entry"), ...entryRef }),
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
