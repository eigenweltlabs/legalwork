import { z } from "zod";

const checkoutSelection = z.object({
  interval: z.enum(["month", "year"]),
  seats: z.number().int().min(1).max(500),
});

/** Billing choices confirmed in LegalWork; the platform authorizes the firm and prices. */
export type EigenweltCheckoutSelection = z.infer<typeof checkoutSelection>;

export function parseEigenweltCheckoutSelection(value: unknown): EigenweltCheckoutSelection | null {
  const result = checkoutSelection.safeParse(value);
  return result.success ? result.data : null;
}
