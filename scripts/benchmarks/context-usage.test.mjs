import assert from "node:assert/strict";
import test from "node:test";
import { summarizeContextUsage } from "./context-usage.mjs";

test("partial provider measurements retain observed consumption and mark full totals unknown", () => {
  const result = summarizeContextUsage([
    { requestId: "known", providerUsage: { input: 120, output: 25, cacheRead: 80 }, gatewayUsageReportedCostEur: 0.12, gatewayCostHeader: "0.12" },
    { requestId: "missing", providerUsage: { input: null, output: 5, cacheRead: null }, gatewayUsageReportedCostEur: null, gatewayCostHeader: null },
    { requestId: "unreported" },
  ]);
  assert.equal(result.inputTokens, null);
  assert.equal(result.outputTokens, null);
  assert.equal(result.cacheReadTokens, null);
  assert.equal(result.gatewayUsageReportedCostEur, null);
  assert.equal(result.observedInputTokens, 120);
  assert.equal(result.observedOutputTokens, 30);
  assert.equal(result.observedCacheReadTokens, 80);
  assert.equal(result.observedGatewayUsageReportedCostEur, 0.12);
  assert.deepEqual(result.missingInputRequests, ["missing", "unreported"]);
  assert.deepEqual(result.missingOutputRequests, ["unreported"]);
  assert.deepEqual(result.missingCacheReadRequests, ["missing", "unreported"]);
  assert.deepEqual(result.missingGatewayUsageCostRequests, ["missing", "unreported"]);
  assert.deepEqual(result.headerCostMissingRequests, ["missing", "unreported"]);
});

test("explicit measured zero is a complete measurement while absent requests are not", () => {
  const measured = summarizeContextUsage([{ requestId: "zero", providerUsage: { input: 0, output: 0, cacheRead: 0 }, gatewayUsageReportedCostEur: 0, gatewayCostHeader: "0" }]);
  assert.equal(measured.inputTokens, 0);
  assert.equal(measured.outputTokens, 0);
  assert.equal(measured.cacheReadTokens, 0);
  assert.equal(measured.gatewayUsageReportedCostEur, 0);
  assert.deepEqual(measured.missingCacheReadRequests, []);
  const empty = summarizeContextUsage([]);
  assert.equal(empty.inputTokens, null);
  assert.equal(empty.gatewayUsageReportedCostEur, null);
});

test("complete finite measurements sum without counting cache reads twice", () => {
  const result = summarizeContextUsage([
    { requestId: "a", providerUsage: { input: 100, output: 10, cacheRead: 70 }, gatewayUsageReportedCostEur: 0.02 },
    { requestId: "b", providerUsage: { input: 200, output: 20, cacheRead: 150 }, gatewayUsageReportedCostEur: 0.03 },
  ]);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.outputTokens, 30);
  assert.equal(result.cacheReadTokens, 220);
  assert.equal(result.gatewayUsageReportedCostEur, 0.05);
});
