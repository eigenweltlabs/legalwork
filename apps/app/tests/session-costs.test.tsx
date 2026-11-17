import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CostUsage } from "@legalwork/types/session-cost";
import { CostBreakdown, costLabel, formatCost } from "../src/components/chat/cost-indicator";

const usage: CostUsage = { amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032, source: "estimate" }], calls: 3, unpricedCalls: 0, pendingCalls: 0,
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } },
  models: [{ providerId: "example", modelId: "internal-model-route", modelName: "Sample model", amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032, source: "estimate" }], calls: 3,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } } }],
};
describe("cost display", () => {
  test("small nonzero costs never look free", () => {
    expect(formatCost(0, "USD")).toBe("$0.00");
    expect(formatCost(0.00002, "USD")).toBe("<$0.01");
    expect(formatCost(0.032, "USD")).toBe("$0.03");
    expect(formatCost(0.00938955, "EUR")).toBe("<€0.01");
    expect(formatCost(0.00938955, "EUR", "en", true)).toBe("€0.0094");
    expect(formatCost(1.234, "USD")).toBe("$1.23");
    expect(formatCost(0.032, "USD", "de")).toContain("0,03");
  });
  test("unknown and partially priced usage stay distinct from zero", () => {
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0, source: "estimate" }] })).toBe("Cost unavailable (USD)");
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0.1, source: "estimate" }] })).toBe("Partial ~$0.10");
  });
  test("cost overview keeps model usage and token categories in one collapsed dropdown", () => {
    const html = renderToStaticMarkup(React.createElement(CostBreakdown, { usage, conversation: usage, title: "This answer", busy: true }));
    for (const text of ["Estimated AI cost", "This answer", "This conversation", "$0.03", "View usage details", "Sample model", "$0.032", "3 calls", "Input tokens", "1,200", "New input", "300", "Reasoning", "Reused input", "so far"]) expect(html).toContain(text);
    for (const text of ["new input stored for later reuse", "output excludes reasoning", "External service charges", "without conversion", "Input from cache", "Other input", "Advanced details", "Saved for reuse", "Not saved", "ESTIMATE ·"]) expect(html).not.toContain(text);
    expect(html).not.toContain("internal-model-route");
  });
});

test("mixed currencies are displayed separately with provenance and tiny EUR never rounds to free", () => {
  expect(costLabel({ amounts: [
    { currency: "EUR", cost: 0.03, knownCost: 0.03, source: "gateway" },
    { currency: "USD", cost: 0.02, knownCost: 0.02, source: "estimate" },
  ] })).toBe("€0.03 + ~$0.02");
  expect(formatCost(0.000008, "EUR")).toBe("<€0.01");
  const html = renderToStaticMarkup(React.createElement(CostBreakdown, { title: "This answer", usage: { ...usage,
    pendingCalls: 1, amounts: [{ currency: "EUR", cost: 0.03, knownCost: 0.03, source: "gateway" }] } }));
  expect(html).toContain("AI cost");
  expect(html).not.toContain("Estimated AI cost");
  expect(html).toContain("Updating costs");
  expect(html).not.toContain("without conversion");
});
