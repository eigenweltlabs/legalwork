import { describe, expect, test } from "bun:test";
import { aggregateModelAnalytics, type AnalyticsRow } from "./analytics.js";

function row(patch: Partial<AnalyticsRow>): AnalyticsRow {
  return {
    taskKey: "tasks/tax/x",
    providerID: "p",
    modelID: "a",
    vertical: "Tax",
    tags: ["Tax"],
    nPassed: 2,
    nCriteria: 4,
    ...patch,
  };
}

describe("aggregateModelAnalytics", () => {
  test("per-model overall + per-tag means, ranked best first, multi-tag membership", () => {
    const rows: AnalyticsRow[] = [
      row({ modelID: "a", tags: ["Tax", "US"], taskKey: "t1", nPassed: 2, nCriteria: 4 }), // 0.5
      row({ modelID: "a", tags: ["Tax"], taskKey: "t2", nPassed: 4, nCriteria: 4 }), // 1.0
      row({ modelID: "a", tags: ["M&A"], taskKey: "t3", nPassed: 3, nCriteria: 3 }), // 1.0
      row({ modelID: "b", tags: ["Tax"], taskKey: "t1", nPassed: 1, nCriteria: 4 }), // 0.25
    ];
    const result = aggregateModelAnalytics(rows);

    // Model a overall = mean(0.5, 1.0, 1.0) = 0.8333…, model b = 0.25 → a ranked first.
    expect(result.models.map((m) => m.modelID)).toEqual(["a", "b"]);
    const a = result.models[0];
    expect(a.overall.tasks).toBe(3);
    expect(a.overall.criteriaPassed).toBe(9);
    expect(a.overall.criteriaTotal).toBe(11);
    expect(a.overall.rate).toBeCloseTo((0.5 + 1 + 1) / 3, 5);
    // Tax: t1 (0.5) + t2 (1.0) → 0.75 over 2 tasks.
    const aTax = a.byTag.find((entry) => entry.tag === "Tax");
    expect(aTax?.rate).toBeCloseTo(0.75, 5);
    expect(aTax?.tasks).toBe(2);
    // US only comes from t1 → 0.5, 1 task (multi-tag membership).
    const aUs = a.byTag.find((entry) => entry.tag === "US");
    expect(aUs?.rate).toBe(0.5);
    expect(aUs?.tasks).toBe(1);
  });

  test("skips unjudged rows and empty rubrics", () => {
    const result = aggregateModelAnalytics([
      row({ nPassed: null, nCriteria: null }),
      row({ nPassed: 0, nCriteria: 0 }),
    ]);
    expect(result.models).toHaveLength(0);
    expect(result.tags).toHaveLength(0);
  });

  test("a task with no tags still counts toward overall but adds no tag columns", () => {
    const result = aggregateModelAnalytics([row({ tags: [], nPassed: 1, nCriteria: 2 })]);
    expect(result.models[0].overall.tasks).toBe(1);
    expect(result.models[0].byTag).toHaveLength(0);
    expect(result.tags).toHaveLength(0);
  });

  test("returns all tags and filters rows by selected tags", () => {
    const rows: AnalyticsRow[] = [
      row({ modelID: "a", taskKey: "t1", tags: ["Tax", "US"], nPassed: 4, nCriteria: 4 }),
      row({ modelID: "a", taskKey: "t2", tags: ["Arbitration"], nPassed: 1, nCriteria: 4 }),
    ];
    // Unfiltered: both rows → tags list is the union, sorted.
    const all = aggregateModelAnalytics(rows);
    expect(all.tags).toEqual(["Arbitration", "Tax", "US"]);
    expect(all.models[0].overall.tasks).toBe(2);

    // Filtered to Tax: only the first row contributes, but the tag list is unchanged.
    const filtered = aggregateModelAnalytics(rows, ["Tax"]);
    expect(filtered.tags).toEqual(["Arbitration", "Tax", "US"]);
    expect(filtered.models[0].overall.tasks).toBe(1);
    expect(filtered.models[0].overall.rate).toBe(1);
  });
});
