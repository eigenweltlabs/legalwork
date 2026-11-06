import { z } from "zod";

export const ScratchpadWriteSchema = z.object({
  revision: z.number().int().nonnegative(),
  text: z.string().trim().max(6000).describe("Replace the concise scratchpad with current topics, exact event conditions, the user-requested response and end conditions. For explicitly authorized conditional work, retain the original human instruction and source chat reference, authorized action and skill. Future case details are not required to register the condition. Empty clears it. Only the Assistant maintains this text; events never add topics."),
});
export const BriefingActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("offer") }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("create"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekdaysOnly: z.boolean(), timeZone: z.string().min(1).max(100).optional(),
    userAccepted: z.literal(true).describe("Only true after the human accepted the briefing and these schedule details.") }),
]);
export const ProactiveEventSchema = z.object({
  id: z.string(), source: z.string(), projectId: z.string().nullable(), at: z.number(),
  text: z.string().max(12000), link: z.string().optional(),
});
export type ProactiveEvent = z.infer<typeof ProactiveEventSchema>;
