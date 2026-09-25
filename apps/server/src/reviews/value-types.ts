import { z } from "zod";
import type { ReviewColumn } from "./schema.js";

const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const amount = z.object({ amount: z.number().finite(), currency: z.string().regex(/^[A-Z]{3}$/) });
export function columnValueInstructions(column: ReviewColumn): string {
  const instructions: Record<ReviewColumn["kind"], string> = {
    text: "Return concise text.",
    yes_no: "Return Yes or No.",
    classification: "Return exactly one of the fixed answer options.",
    date: "Return one exact date as YYYY-MM-DD. Never infer missing day/month/year or invent an exact date from a relative condition. Ambiguous dates require Needs review.",
    number: "Return a decimal number as a string without grouping, units or scientific notation. Do not combine different quantities. State the unit in the reason.",
    percentage: "Return a decimal percentage without the percent sign: 12.5 means 12.5%, not 0.125. Never infer a rate from unrelated figures.",
    currency: 'Return value as a JSON-encoded object with a numeric amount and the explicit ISO 4217 currency code, e.g. "{\\"amount\\":1500,\\"currency\\":\\"EUR\\"}". Never assume a currency or combine distinct amounts.',
    multi_select: "Return value as a JSON-encoded array of distinct exact answer options. Include all supported options. Do not invent options. Use Not found if none are supported.",
  };
  return `${instructions[column.kind]} In every type, use Not found for absent evidence and Needs review for uncertainty; never coerce these to zero or a date.`;
}

/** Type validation is enforced for API/agent-created columns too. */
export function validateColumnValue(column: ReviewColumn, value: string) {
  if (value === "Not found" || value === "Needs review") return;
  if (column.kind === "date") {
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
      throw new Error("The model did not return a valid date (YYYY-MM-DD).");
  }
  if ((column.kind === "number" || column.kind === "percentage") && (!decimal.test(value) || !Number.isFinite(Number(value))))
    throw new Error("The model did not return a valid decimal number.");
  if (column.kind === "currency") amount.parse(JSON.parse(value));
  if (column.kind === "multi_select") {
    const selected = z.array(z.string()).min(1).max(30).parse(JSON.parse(value));
    if (new Set(selected).size !== selected.length || selected.some(option => !column.options.includes(option)))
      throw new Error("The model returned undefined or duplicate answer options.");
  }
}
