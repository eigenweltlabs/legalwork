import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CostUsage } from "@legalwork/types/session-cost";
import { CostBreakdown, costLabel, formatCost } from "../src/components/chat/cost-indicator";
import { Popover } from "../src/components/ui/popover";

const usage: CostUsage = { amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032, source: "estimate" }], calls: 3, unpricedCalls: 0, pendingCalls: 0,
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } },
  models: [{ providerId: "example", modelId: "internal-model-route", modelName: "Sample model", amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032, source: "estimate" }], calls: 3,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } } }],
};
describe("cost display", () => {
  test("small nonzero costs never look free", () => {
    expect(formatCost(0, "USD")).toBe("$0.00");
    expect(formatCost(0.00002, "USD")).toBe("<$0.001");
    expect(formatCost(0.032, "USD")).toBe("$0.032");
    expect(formatCost(1.234, "USD")).toBe("$1.23");
    expect(formatCost(0.032, "USD", "de")).toContain("0,032");
  });
  test("unknown and partially priced usage stay distinct from zero", () => {
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0, source: "estimate" }] })).toBe("Cost unavailable (USD)");
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0.1, source: "estimate" }] })).toBe("≥ ~$0.10");
  });
  test("breakdown shows total input including cache writes, its categories and estimate wording", () => {
    const html = renderToStaticMarkup(React.createElement(Popover, {}, React.createElement(CostBreakdown, { usage, title: "Prompt cost", busy: true })));
    for (const text of ["Sample model", "$0.032", "75%", "Model calls", "Token breakdown", "Total input", "1,200", "Other input", "Reasoning", "Reused from cache", "Saved to cache", "new input stored for later reuse", "output excludes reasoning", "so far", "ESTIMATE", "External service charges are excluded"]) expect(html).toContain(text);
    expect(html).not.toContain("internal-model-route");
  });
});

test("mixed currencies are displayed separately with provenance and tiny EUR never rounds to free", () => {
  expect(costLabel({ amounts: [
    { currency: "EUR", cost: 0.03, knownCost: 0.03, source: "gateway" },
    { currency: "USD", cost: 0.02, knownCost: 0.02, source: "estimate" },
  ] })).toBe("€0.03 + ~$0.02");
  expect(formatCost(0.000008, "EUR")).toBe("<€0.001");
  const html = renderToStaticMarkup(React.createElement(CostBreakdown, { inline: true, title: "Prompt cost", usage: { ...usage,
    pendingCalls: 1, amounts: [{ currency: "EUR", cost: 0.03, knownCost: 0.03, source: "gateway" }] } }));
  expect(html).toContain("GATEWAY · EUR");
  expect(html).toContain("settle recent calls");
  expect(html).toContain("without conversion");
});
