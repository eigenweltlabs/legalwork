import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import type { CostUsage } from "@legalwork/types/session-cost";
import { CostBreakdown, costLabel, formatCost } from "../src/components/chat/cost-indicator";

const usage: CostUsage = { amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032 }], calls: 3, unpricedCalls: 0, pendingCalls: 0,
  tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } },
  models: [{ providerId: "example", modelId: "internal-model-route", modelName: "Sample model", amounts: [{ currency: "USD", cost: 0.032, knownCost: 0.032 }], calls: 3,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 900, write: 200 } } }],
};
test("cost disclosures keep each answer's details before the conversation row", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/cost-disclosures.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Cost disclosure flow passed");
}, 30_000);

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
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0 }] })).toBe("Cost unavailable (USD)");
    expect(costLabel({ amounts: [{ currency: "USD", cost: null, knownCost: 0.1 }] })).toBe("Partial ~$0.10");
  });
  test("cost rows start closed with usage details hidden", () => {
    const html = renderToStaticMarkup(React.createElement(CostBreakdown, { usage, conversation: usage, title: "This answer", busy: true }));
    for (const text of ["Estimated AI cost", "This answer", "This conversation", "$0.03", "so far"]) expect(html).toContain(text);
    for (const text of ["new input stored for later reuse", "output excludes reasoning", "External service charges", "without conversion", "Input from cache", "Other input", "Advanced details", "Saved for reuse", "Not saved", "ESTIMATE ·"]) expect(html).not.toContain(text);
    expect(html).not.toContain("internal-model-route");
    expect(html).toContain('role="group"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    for (const text of ['aria-expanded="true"', 'role="tab"', 'role="tabpanel"', "Sample model", "Input tokens", "<details", "<summary", "View usage details"]) expect(html).not.toContain(text);
  });
});

test("mixed currencies stay separate and tiny EUR never rounds to free", () => {
  expect(costLabel({ amounts: [
    { currency: "EUR", cost: 0.03, knownCost: 0.03 },
    { currency: "USD", cost: 0.02, knownCost: 0.02 },
  ] })).toBe("~€0.03 + ~$0.02");
  expect(formatCost(0.000008, "EUR")).toBe("<€0.01");
  const html = renderToStaticMarkup(React.createElement(CostBreakdown, { title: "This answer", usage: { ...usage,
    pendingCalls: 1, amounts: [{ currency: "EUR", cost: 0.03, knownCost: 0.03 }] } }));
  expect(html).toContain("AI cost");
  expect(html).toContain("Estimated AI cost");
  expect(html).not.toContain("Updating costs");
  expect(html).not.toContain("without conversion");
});
