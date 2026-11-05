// Missing provider measurements must never look like zero consumption.
export function summarizeContextUsage(rows) {
  const totals = { requests: rows.length };
  for (const [field, total, observed, missing] of [
    ["input", "inputTokens", "observedInputTokens", "missingInputRequests"],
    ["output", "outputTokens", "observedOutputTokens", "missingOutputRequests"],
    ["cacheRead", "cacheReadTokens", "observedCacheReadTokens", "missingCacheReadRequests"],
  ]) {
    const absent = rows.filter(row => !Number.isFinite(row.providerUsage?.[field])).map(row => row.requestId);
    const subtotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.providerUsage?.[field]) ? row.providerUsage[field] : 0), 0);
    totals[total] = rows.length > 0 && absent.length === 0 ? subtotal : null;
    totals[observed] = subtotal;
    totals[missing] = absent;
  }
  const costMissing = rows.filter(row => !Number.isFinite(row.gatewayUsageReportedCostEur)).map(row => row.requestId);
  const observedCost = rows.reduce((sum, row) => sum + (Number.isFinite(row.gatewayUsageReportedCostEur) ? row.gatewayUsageReportedCostEur : 0), 0);
  totals.gatewayUsageReportedCostEur = rows.length > 0 && costMissing.length === 0 ? observedCost : null;
  totals.observedGatewayUsageReportedCostEur = observedCost;
  totals.missingGatewayUsageCostRequests = costMissing;
  totals.headerCostMissingRequests = rows.filter(row => row.gatewayCostHeader == null).map(row => row.requestId);
  return totals;
}
