import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isHarveyTaskKey,
  parseCustomTaskInput,
  parseHarveyTaskJson,
  parseStoredTaskJson,
  taskNameFromHarveyKey,
  verticalFromHarveyKey,
  verticalLabel,
} from "./task-schema.js";

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
}

describe("parseHarveyTaskJson", () => {
  test("parses a real draft task fixture", () => {
    const result = parseHarveyTaskJson(loadFixture("harvey-draft-antitrust-complaint.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.workType).toBe("draft");
    expect(result.task.deliverables).toEqual(["antitrust-complaint.docx"]);
    expect(result.task.criteria.length).toBeGreaterThan(10);
    expect(result.task.criteria[0]?.id).toBeTruthy();
    expect(result.task.criteria[0]?.matchCriteria).toContain("PASS");
    expect(result.task.tags[0]).toBe("Antitrust & Competition");
  });

  test("parses a real research task fixture", () => {
    const result = parseHarveyTaskJson(loadFixture("harvey-research-leniency-comparison.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.workType).toBe("research");
    expect(result.task.deliverables).toEqual(["leniency-comparison-memo.docx"]);
  });

  test("accepts deliverables as an array", () => {
    const result = parseHarveyTaskJson({
      title: "T",
      work_type: "analyze",
      tags: ["Tax"],
      instructions: "Do the thing.",
      deliverables: ["memo.docx", "memo.docx", " table.xlsx "],
      criteria: [{ match_criteria: "PASS if memo exists." }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.deliverables).toEqual(["memo.docx", "table.xlsx"]);
    expect(result.task.criteria[0]?.id).toBe("C-001");
    expect(result.task.criteria[0]?.deliverables).toEqual(["memo.docx", "table.xlsx"]);
  });

  test("rejects unknown work_type", () => {
    const result = parseHarveyTaskJson({
      title: "T",
      work_type: "summarize",
      instructions: "x",
      deliverables: {},
      criteria: [{ match_criteria: "PASS" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects empty criteria", () => {
    const result = parseHarveyTaskJson({
      title: "T",
      work_type: "draft",
      instructions: "x",
      deliverables: { "a.docx": "a.docx" },
      criteria: [],
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseCustomTaskInput", () => {
  test("normalizes a minimal custom task", () => {
    const result = parseCustomTaskInput({
      title: "Review NDA",
      workType: "review",
      instructions: "Review the NDA and write findings to findings.md.",
      deliverables: ["findings.md"],
      criteria: [
        { matchCriteria: "PASS if the non-compete clause is flagged." },
        { id: "C-XYZ", title: "Term length", matchCriteria: "PASS if the 5-year term is called out." },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.criteria).toHaveLength(2);
    expect(result.task.criteria[0]?.id).toBe("C-001");
    expect(result.task.criteria[1]?.id).toBe("C-XYZ");
    expect(result.task.criteria[1]?.title).toBe("Term length");
    expect(result.task.criteria[0]?.deliverables).toEqual(["findings.md"]);
  });

  test("rejects whitespace-only criteria", () => {
    const result = parseCustomTaskInput({
      title: "T",
      workType: "analyze",
      instructions: "x",
      criteria: [{ matchCriteria: "   " }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing title", () => {
    const result = parseCustomTaskInput({
      workType: "analyze",
      instructions: "x",
      criteria: [{ matchCriteria: "PASS" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("stored task roundtrip", () => {
  test("normalized task survives JSON snapshot", () => {
    const parsed = parseHarveyTaskJson(loadFixture("harvey-draft-antitrust-complaint.json"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const restored = parseStoredTaskJson(JSON.stringify(parsed.task));
    expect(restored).toEqual(parsed.task);
  });

  test("returns null for malformed snapshots", () => {
    expect(parseStoredTaskJson("not json")).toBeNull();
    expect(parseStoredTaskJson('{"title": 5}')).toBeNull();
  });
});

describe("harvey key helpers", () => {
  test("key pattern and derivation", () => {
    expect(isHarveyTaskKey("tasks/tax/draft-memo")).toBe(true);
    expect(isHarveyTaskKey("tasks/tax/draft-memo/task.json")).toBe(false);
    expect(isHarveyTaskKey("other/tax/draft-memo")).toBe(false);
    expect(verticalFromHarveyKey("tasks/antitrust-competition/draft-antitrust-complaint")).toBe(
      "antitrust-competition",
    );
    expect(taskNameFromHarveyKey("tasks/antitrust-competition/draft-antitrust-complaint")).toBe(
      "draft-antitrust-complaint",
    );
  });

  test("vertical label prefers first tag, falls back to slug", () => {
    const parsed = parseHarveyTaskJson(loadFixture("harvey-draft-antitrust-complaint.json"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(verticalLabel(parsed.task, "antitrust-competition")).toBe("Antitrust & Competition");
    expect(verticalLabel(null, "antitrust-competition")).toBe("Antitrust Competition");
  });
});
