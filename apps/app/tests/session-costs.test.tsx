import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CostUsage } from "@legalwork/types/session-cost";
import { CostBreakdown, costLabel, formatCostUsd } from "../src/components/chat/cost-indicator";
import { Popover } from "../src/components/ui/popover";

const usage: CostUsage = { costUsd: 0.032, knownCostUsd: 0.032, calls: 3, unpricedCalls: 0,
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 0 } },
  models: [{ providerId: "example", modelId: "Sample model", costUsd: 0.032, knownCostUsd: 0.032, calls: 3,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 0 } } }],
};
describe("cost display", () => {
  test("small nonzero costs never look free", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.00002)).toBe("<$0.001");
    expect(formatCostUsd(0.032)).toBe("$0.032");
    expect(formatCostUsd(1.234)).toBe("$1.23");
    expect(formatCostUsd(0.032, "de")).toContain("0,032");
  });
  test("unknown and partially priced usage stay distinct from zero", () => {
    expect(costLabel({ costUsd: null, knownCostUsd: 0 })).toBe("Cost unavailable");
    expect(costLabel({ costUsd: null, knownCostUsd: 0.1 })).toBe("≥ $0.10");
  });
  test("breakdown exposes cache, model calls, all five token buckets and estimate wording", () => {
    const html = renderToStaticMarkup(React.createElement(Popover, {}, React.createElement(CostBreakdown, { usage, title: "Prompt cost", busy: true })));
    for (const text of ["Sample model", "$0.032", "90%", "Model calls", "Token breakdown", "Reasoning", "Cache reads", "Cache writes", "so far", "ESTIMATE", "subscription allowance"]) expect(html).toContain(text);
  });
});
