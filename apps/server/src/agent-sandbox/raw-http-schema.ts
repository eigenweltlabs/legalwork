import { z } from "zod";

/** Private native dispatch contract. Never advertise this as a model tool. */
export const rawHttpToolName = "legalwork_raw_http";
export const rawHttpInputSchema = z.object({
  url: z.string(), method: z.string(), headers: z.record(z.string(), z.string()),
  bodyBase64: z.string().optional(),
}).strict();
export const rawHttpOutputSchema = z.object({
  url: z.string(), status: z.number().int(), statusText: z.string(),
  headers: z.record(z.string(), z.string()), bodyBase64: z.string(), redirected: z.boolean(),
}).strict();
export type RawHttpInput = z.infer<typeof rawHttpInputSchema>;
export type RawHttpOutput = z.infer<typeof rawHttpOutputSchema>;
