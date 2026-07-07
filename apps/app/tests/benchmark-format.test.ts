import { describe, expect, test } from "bun:test";
import type { BenchmarkRunItem } from "../src/app/lib/benchmark-types";
import {
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
