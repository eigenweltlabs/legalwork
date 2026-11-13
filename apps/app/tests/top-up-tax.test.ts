import { expect, test } from "bun:test";
import { parseTopUpResult } from "../src/react-app/domains/connections/usage-control/top-up-result";

const quote = { status: "requires_confirmation", operationId: "purchase", amountCents: 5000, taxCents: 950, totalCents: 5950 };
test("retains separate usable credits, tax and the amount requiring consent", () => {
  expect(parseTopUpResult(quote)).toEqual(quote);
  expect(parseTopUpResult({ ...quote, taxCents: 0, totalCents: 5000 })).toMatchObject({ taxCents: 0, amountCents: 5000 });
});
test("rejects inconsistent or invalid payment quotes", () => {
  for (const bad of [{ ...quote, totalCents: 5000 }, { ...quote, taxCents: -1 },
    { ...quote, amountCents: 0 }, { ...quote, taxCents: 0.5 }, { ...quote, totalCents: null }])
    expect(() => parseTopUpResult(bad)).toThrow("response");
});
test("includes invoice credits or debits in the amount requiring consent", () => {
  for (const balanceCents of [4875, 5950, -3500]) {
    const adjusted = { ...quote, balanceCents, totalCents: 5950 - balanceCents };
    expect(parseTopUpResult(adjusted)).toEqual(adjusted);
  }
  for (const balanceCents of ["4875", 0.5, null, NaN])
    expect(() => parseTopUpResult({ ...quote, balanceCents })).toThrow("response");
  expect(() => parseTopUpResult({ ...quote, balanceCents: 6000, totalCents: -50 })).toThrow("response");
  expect(() => parseTopUpResult({ ...quote, balanceCents: 4875 })).toThrow("response");
});
test("continues to handle payment confirmation and bank verification responses", () => {
  expect(parseTopUpResult({ status: "paid", operationId: "purchase" })).toEqual({ status: "paid", operationId: "purchase" });
  expect(parseTopUpResult({ status: "requires_action", operationId: "purchase", url: "https://hooks.stripe.com/test" })).toMatchObject({ status: "requires_action" });
});
