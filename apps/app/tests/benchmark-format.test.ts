import { describe, expect, test } from "bun:test";
import type { BenchmarkRunItem } from "../src/app/lib/benchmark-types";
import {
  aggregateByTag,
  formatCellScore,
  formatScorePercent,
  isItemActive,
  isRunActive,
  runStatusTone,
} from "../src/react-app/domains/benchmark/format";

function item(patch: Partial<BenchmarkRunItem>): BenchmarkRunItem {
  return {
    id: "i",
    taskSource: "harvey",
    taskKey: "tasks/tax/x",
    taskTitle: "X",
    workType: "draft",
    vertical: "tax",
    tags: ["tax"],
    providerID: "prov",
    modelID: "m",
    status: "pending",
    score: null,
    nCriteria: null,
    nPassed: null,
    sessionId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    cost: null,
    tokens: null,
    ...patch,
  };
}

describe("format helpers", () => {
  test("formatScorePercent", () => {
    expect(formatScorePercent(null)).toBe("—");
    expect(formatScorePercent(0)).toBe("0%");
    expect(formatScorePercent(0.5)).toBe("50%");
    expect(formatScorePercent(1)).toBe("100%");
  });

  test("formatCellScore uses pass counts", () => {
    expect(formatCellScore(item({}))).toBe("—");
    expect(formatCellScore(item({ nPassed: 3, nCriteria: 4 }))).toBe("3/4");
    expect(formatCellScore(item({ nPassed: 0, nCriteria: 2 }))).toBe("0/2");
  });

  test("run/item activity", () => {
    expect(isRunActive("running")).toBe(true);
    expect(isRunActive("aborting")).toBe(true);
    expect(isRunActive("completed")).toBe(false);
    expect(isRunActive("interrupted")).toBe(false);
    expect(isItemActive("judging")).toBe(true);
    expect(isItemActive("passed")).toBe(false);
  });

  test("status tones", () => {
    expect(runStatusTone("completed")).toBe("ready");
    expect(runStatusTone("failed")).toBe("error");
    expect(runStatusTone("aborted")).toBe("warning");
    expect(runStatusTone("running")).toBe("neutral");
  });
});

describe("aggregateByTag", () => {
  const models = [
    { providerID: "p", modelID: "a" },
    { providerID: "p", modelID: "b" },
  ];

  test("means rubric pass rate per tag × model, most-tested first, multi-tag membership", () => {
    const items: BenchmarkRunItem[] = [
      item({ tags: ["tax", "us"], providerID: "p", modelID: "a", nPassed: 2, nCriteria: 4 }), // 0.5
      item({ tags: ["tax"], providerID: "p", modelID: "a", nPassed: 4, nCriteria: 4 }), // 1.0 → tax mean 0.75
      item({ tags: ["tax"], providerID: "p", modelID: "b", nPassed: 1, nCriteria: 4 }), // 0.25
      item({ tags: ["m&a"], providerID: "p", modelID: "a", nPassed: 3, nCriteria: 3 }), // 1.0
    ];
    const rows = aggregateByTag(items, models);
    // tax appears 3×, then us/m&a once each (alpha tiebreak).
    expect(rows.map((row) => row.tag)).toEqual(["tax", "m&a", "us"]);
    expect(rows[0].byModel["p/a"]).toEqual({ rate: 0.75, count: 2 });
    expect(rows[0].byModel["p/b"]).toEqual({ rate: 0.25, count: 1 });
    // us only from the first item (multi-tag membership).
    const us = rows.find((row) => row.tag === "us")!;
    expect(us.byModel["p/a"]).toEqual({ rate: 0.5, count: 1 });
    expect(us.byModel["p/b"]).toEqual({ rate: null, count: 0 });
  });

  test("ignores unjudged items", () => {
    const rows = aggregateByTag(
      [
        item({ tags: ["tax"], providerID: "p", modelID: "a", nPassed: null, nCriteria: null }),
        item({ tags: ["tax"], providerID: "p", modelID: "a", nPassed: 0, nCriteria: 0 }),
      ],
      models,
    );
    expect(rows).toHaveLength(0);
  });
});
