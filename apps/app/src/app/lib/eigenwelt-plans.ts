/**
 * The Eigenwelt plans as the plan screen shows them. A mirror of
 * model-api/apps/platform/src/lib/plans.ts (the billing source of truth) and
 * of the platform's plan cards: update both places together. Prices are net
 * euro cents per seat; VAT is added at checkout.
 *
 * Pure and dependency-free, so the plan screen and its tests share it.
 */

export type EigenweltPlanId = "sync" | "plus" | "pro" | "max";
/** One tax-inclusive EUR fee per new firm, separate from subscription payments. */
export const EIGENWELT_TRIAL_FEE_CENTS = 100;

export type EigenweltPlan = {
  id: Exclude<EigenweltPlanId, "sync">;
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
    yearlyPerMonthCents: 3000,
    monthlyCents: 4000,
    includedMonthlyUsageCents: 3000,
  },
  {
    id: "pro",
    name: "Pro",
    yearlyPerMonthCents: 9000,
    monthlyCents: 10000,
    includedMonthlyUsageCents: 10000,
  },
  { id: "max", name: "Max", yearlyPerMonthCents: 19000, monthlyCents: 20000, includedMonthlyUsageCents: 21000 },
];

export function isEigenweltPlanId(value: unknown): value is EigenweltPlanId {
  return value === "sync" || value === "plus" || value === "pro" || value === "max";
}

/**
 * Euro amount for a price tag: whole euros without decimals ("€30" in
 * English, "30 €" in German), cents only when the amount has any.
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
