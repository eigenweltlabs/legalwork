import { z } from "zod";

export const epostAddress = z.object({
  name: z.string().max(80),
  street: z.string().max(80),
  postalCode: z.string().max(16),
  city: z.string().max(80),
});
export const emptyEpostAddress = { name: "", street: "", postalCode: "", city: "" };
export const epostDraftInput = z.object({
  sender: epostAddress.optional(),
  recipient: epostAddress.extend({ country: z.string().max(80).optional() }).optional(),
  registered: z.enum(["none", "dropoff", "signature", "receipt"]).default("none"),
  color: z.boolean().default(false),
  duplex: z.boolean().default(false),
  files: z.array(z.string().min(1).max(2048)).min(1).max(20),
});
export const epostDraft = epostDraftInput.extend({ id: z.uuid(), workspaceId: z.string().min(1) });
export const epostStatus = z.object({ available: z.boolean(), enabled: z.boolean(), wordAvailable: z.boolean() });
export const epostQuote = z.object({
  reviewId: z.uuid(), amountCents: z.number().int().positive(), pages: z.number().int().positive(),
  sheets: z.number().int().positive(), expires: z.number().int(),
});
export const epostReceipt = z.object({
  state: z.enum(["pending", "accepted", "processed", "rejected"]), amountCents: z.number().int().positive(),
  letterId: z.number().int().positive().optional(),
});
export type EpostDraft = z.infer<typeof epostDraft>;
export type EpostStatus = z.infer<typeof epostStatus>;
export type EpostQuote = z.infer<typeof epostQuote>;
export type EpostReceipt = z.infer<typeof epostReceipt>;
