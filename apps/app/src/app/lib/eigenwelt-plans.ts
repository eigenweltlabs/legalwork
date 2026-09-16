/**
 * The Eigenwelt plans as the plan screen shows them. A mirror of
 * model-api/apps/platform/src/lib/plans.ts (the billing source of truth) and
 * of the platform's plan cards: update both places together. Prices are net
 * euro cents per seat; VAT is added at checkout.
 *
 * Pure and dependency-free, so the plan screen and its tests share it.
 */

export type EigenweltPlanId = "plus" | "pro";

export type EigenweltPlan = {
  id: EigenweltPlanId;
  /** The marketed name, the same in every language. */
  name: string;
  /** Per seat per month when billed yearly: the headline price. */
  yearlyPerMonthCents: number;
  /** Per seat per month when billed monthly. */
  monthlyCents: number;
  /** AI usage included per seat per month. */
  includedMonthlyUsageCents: number;
};

export const EIGENWELT_PLANS: readonly EigenweltPlan[] = [
  {
    id: "plus",
    name: "Plus",
    yearlyPerMonthCents: 2900,
    monthlyCents: 3900,
    includedMonthlyUsageCents: 3000,
  },
  {
    id: "pro",
    name: "Pro",
    yearlyPerMonthCents: 6900,
    monthlyCents: 8900,
    includedMonthlyUsageCents: 7000,
  },
];

export function isEigenweltPlanId(value: unknown): value is EigenweltPlanId {
  return value === "plus" || value === "pro";
}

/**
 * Euro amount for a price tag: whole euros without decimals ("€29" in
 * English, "29 €" in German), cents only when the amount has any.
 */
export function formatEuroCents(cents: number, locale: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
