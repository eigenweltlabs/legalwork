import { describe, expect, test } from "bun:test";
import {
  EMPTY_CUSTOM_TASK_DRAFT,
  validateCustomTask,
} from "../src/react-app/domains/benchmark/validate-custom-task";

describe("validateCustomTask", () => {
  test("valid draft normalizes into the wire input", () => {
    const result = validateCustomTask({
      title: "  Review NDA  ",
      workType: "review",
      tags: [" Contracts ", "NDA", "Contracts"],
      instructions: "Review it and write findings.md",
      deliverables: ["findings.md", "", "  "],
      criteria: ["PASS if the non-compete is flagged.", "", "PASS if term length is called out."],
      documents: [{ name: "nda.txt", contentBase64: "aGVsbG8=" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Review NDA");
    expect(result.input.tags).toEqual(["Contracts", "NDA"]);
    expect(result.input.deliverables).toEqual(["findings.md"]);
    expect(result.input.criteria).toHaveLength(2);
    expect(result.input.criteria[0]).toEqual({ matchCriteria: "PASS if the non-compete is flagged." });
    expect(result.input.documents).toEqual([{ name: "nda.txt", contentBase64: "aGVsbG8=" }]);
  });

  test("requires title, instructions and at least one criterion", () => {
    const result = validateCustomTask({ ...EMPTY_CUSTOM_TASK_DRAFT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toBeTruthy();
    expect(result.errors.instructions).toBeTruthy();
    expect(result.errors.criteria).toBeTruthy();
  });

  test("whitespace-only criteria are rejected", () => {
    const result = validateCustomTask({
      ...EMPTY_CUSTOM_TASK_DRAFT,
      title: "T",
      instructions: "I",
      criteria: ["   ", "\n"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.criteria).toBeTruthy();
  });

  test("deliverables with path separators are rejected", () => {
    const result = validateCustomTask({
      ...EMPTY_CUSTOM_TASK_DRAFT,
      title: "T",
      instructions: "I",
      criteria: ["PASS"],
      deliverables: ["out/memo.docx"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.deliverables).toBeTruthy();
  });
});
