import { z } from "zod";
import { currencyScale } from "./invoice-template.js";

const legacyMinorUnitScale = 100;

const exactAmount = z.object({
  amountMinor: z.number().int().safe(),
  minorUnitScale: z.literal([1, 10, 100, 1000, 10000]),
});
function legacyAmountMinor(amountMinor: number, scale: number): number {
  return scale < legacyMinorUnitScale
    ? amountMinor * (legacyMinorUnitScale / scale)
    : Math.round(amountMinor / (scale / legacyMinorUnitScale));
}

export const BackOfficeCentMoneySchema = z.object({
  // Older readers use 100 units per whole amount in every currency.
  amountMinor: z.number().int().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const BackOfficeMoneySchema = BackOfficeCentMoneySchema.extend({
  exactAmount: exactAmount.optional(),
}).refine(value => !value.exactAmount || value.amountMinor === legacyAmountMinor(value.exactAmount.amountMinor, value.exactAmount.minorUnitScale), {
  message: "The legacy amount must match the rounded exact amount.",
});
export type BackOfficeMoney = z.infer<typeof BackOfficeMoneySchema>;

export function backOfficeMoneyFromMinor(amountMinor: number, currency: string, scale: number): BackOfficeMoney {
  if (scale === legacyMinorUnitScale) return { amountMinor, currency };
  const precise = exactAmount.parse({ amountMinor, minorUnitScale: scale });
  const fallback = legacyAmountMinor(amountMinor, scale);
  // When the legacy amount holds the full value, the original shape suffices.
  return scale < legacyMinorUnitScale || amountMinor % (scale / legacyMinorUnitScale) === 0
    ? { amountMinor: fallback, currency }
    : { amountMinor: fallback, currency, exactAmount: precise };
}

export function backOfficeMoneyFromMajor(amount: number, currency: string): BackOfficeMoney {
  const scale = Math.max(legacyMinorUnitScale, currencyScale(currency));
  return backOfficeMoneyFromMinor(Math.round(amount * scale), currency, scale);
}

export function backOfficeMajorAmount(value: BackOfficeMoney): number {
  return value.exactAmount
    ? value.exactAmount.amountMinor / value.exactAmount.minorUnitScale
    : value.amountMinor / legacyMinorUnitScale;
}

export function sumBackOfficeMoney(values: readonly BackOfficeMoney[]): number {
  const scale = values.reduce((max, value) => Math.max(max, value.exactAmount?.minorUnitScale ?? legacyMinorUnitScale), legacyMinorUnitScale);
  let total = 0n;
  for (const value of values) {
    const valueScale = value.exactAmount?.minorUnitScale ?? legacyMinorUnitScale;
    total += BigInt(value.exactAmount?.amountMinor ?? value.amountMinor) * BigInt(scale / valueScale);
  }
  return Number(total) / scale;
}

export function compareBackOfficeMoney(left: BackOfficeMoney, right: BackOfficeMoney): number {
  const leftScale = left.exactAmount?.minorUnitScale ?? legacyMinorUnitScale;
  const rightScale = right.exactAmount?.minorUnitScale ?? legacyMinorUnitScale;
  const leftMinor = left.exactAmount?.amountMinor ?? left.amountMinor;
  const rightMinor = right.exactAmount?.amountMinor ?? right.amountMinor;
  if (leftScale === rightScale) return leftMinor - rightMinor;
  const difference = BigInt(leftMinor) * BigInt(rightScale) - BigInt(rightMinor) * BigInt(leftScale);
  return difference < 0n ? -1 : Number(difference > 0n);
}
