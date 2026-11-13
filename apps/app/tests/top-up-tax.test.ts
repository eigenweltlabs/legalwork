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
test("continues to handle payment confirmation and bank verification responses", () => {
  expect(parseTopUpResult({ status: "paid", operationId: "purchase" })).toEqual({ status: "paid", operationId: "purchase" });
  expect(parseTopUpResult({ status: "requires_action", operationId: "purchase", url: "https://hooks.stripe.com/test" })).toMatchObject({ status: "requires_action" });
});

test("parses an invoiced saved-card confirmation and rejects missing credentials or changed totals", () => {
  const payment = { ...quote, status: "requires_client_confirmation", clientSecret: "cs_synthetic_secret",
    publishableKey: "pk_test_synthetic", paymentMethodId: "pm_saved" };
  expect(parseTopUpResult(payment)).toEqual(payment);
  for (const bad of [{ ...payment, totalCents: 5000 }, { ...payment, clientSecret: undefined },
    { ...payment, publishableKey: "sk_test_secret" }, { ...payment, paymentMethodId: "other" },
    { ...payment, balanceCents: 4875, totalCents: 1075 }])
    expect(() => parseTopUpResult(bad)).toThrow("response");
});
