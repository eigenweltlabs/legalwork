import { describe, expect, test } from "bun:test";
import type { BenchmarkRunItem } from "../src/app/lib/benchmark-types";
import {
  aggregateByVertical,
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

describe("aggregateByVertical", () => {
  const models = [
    { providerID: "p", modelID: "a" },
    { providerID: "p", modelID: "b" },
  ];

  test("means rubric pass rate per vertical × model, first-seen order", () => {
    const items: BenchmarkRunItem[] = [
      item({ vertical: "tax", providerID: "p", modelID: "a", nPassed: 2, nCriteria: 4 }), // 0.5
      item({ vertical: "tax", providerID: "p", modelID: "a", nPassed: 4, nCriteria: 4 }), // 1.0 → mean 0.75
      item({ vertical: "tax", providerID: "p", modelID: "b", nPassed: 1, nCriteria: 4 }), // 0.25
      item({ vertical: "m&a", providerID: "p", modelID: "a", nPassed: 3, nCriteria: 3 }), // 1.0
    ];
    const rows = aggregateByVertical(items, models);
    expect(rows.map((row) => row.vertical)).toEqual(["tax", "m&a"]);
    expect(rows[0].byModel["p/a"]).toEqual({ rate: 0.75, count: 2 });
    expect(rows[0].byModel["p/b"]).toEqual({ rate: 0.25, count: 1 });
    expect(rows[1].byModel["p/a"]).toEqual({ rate: 1, count: 1 });
    // model b has no m&a items → null
    expect(rows[1].byModel["p/b"]).toEqual({ rate: null, count: 0 });
  });

  test("ignores unjudged items", () => {
    const rows = aggregateByVertical(
      [
        item({ vertical: "tax", providerID: "p", modelID: "a", nPassed: null, nCriteria: null }),
        item({ vertical: "tax", providerID: "p", modelID: "a", nPassed: 0, nCriteria: 0 }),
      ],
      models,
    );
    expect(rows).toHaveLength(0);
  });
});
