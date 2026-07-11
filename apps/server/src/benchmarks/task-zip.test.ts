import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { buildTasksZip, parseTasksZip } from "./task-zip.js";
import type { BenchmarkTaskRow } from "./store.js";

function customRow(overrides: Partial<BenchmarkTaskRow> = {}): BenchmarkTaskRow {
  const now = 1_700_000_000_000;
  return {
    workspaceId: "ws",
    id: "ct_test",
    source: "custom",
    title: "Draft Tax Memo",
    workType: "draft",
    tagsJson: JSON.stringify(["Tax", "Corporate"]),
    instructions: "Draft the memo covering sections A and B.",
    deliverablesJson: JSON.stringify(["memo.docx"]),
    criteriaJson: JSON.stringify([
      { id: "C-001", title: "Has section A", deliverables: ["memo.docx"], matchCriteria: "PASS if section A present." },
    ]),
    harveyDocumentsJson: null,
    catalogRef: null,
    documentsDir: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("parseTasksZip", () => {
  test("reads task.json + sibling documents from a folder", () => {
    const zip = zipSync({
      "draft-tax-memo/task.json": strToU8(
        JSON.stringify({
          title: "Draft Tax Memo",
          work_type: "draft",
          tags: ["Tax"],
          instructions: "Draft it.",
          deliverables: { "memo.docx": "memo.docx" },
          criteria: [{ id: "C-001", match_criteria: "PASS if present." }],
        }),
      ),
      "draft-tax-memo/documents/brief.txt": strToU8("hello"),
    });
    const { tasks, failed } = parseTasksZip(zip);
    expect(failed).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].definition.title).toBe("Draft Tax Memo");
    expect(tasks[0].definition.criteria[0].id).toBe("C-001");
    expect(tasks[0].documents).toHaveLength(1);
    expect(tasks[0].documents[0].name).toBe("brief.txt");
  });

  test("reports malformed task.json in failed and keeps valid ones", () => {
    const zip = zipSync({
      "bad/task.json": strToU8("{ not json"),
      "good/task.json": strToU8(
        JSON.stringify({
          title: "Good",
          work_type: "review",
          instructions: "Review it.",
          criteria: [{ match_criteria: "PASS." }],
        }),
      ),
    });
    const { tasks, failed } = parseTasksZip(zip);
    expect(tasks.map((task) => task.definition.title)).toEqual(["Good"]);
    expect(failed).toHaveLength(1);
    expect(failed[0].path).toBe("bad/task.json");
  });

  test("throws when the archive has no task.json", () => {
    const zip = zipSync({ "readme.txt": strToU8("nope") });
    expect(() => parseTasksZip(zip)).toThrow();
  });

  test("drops documents with unsafe path segments", () => {
    const zip = zipSync({
      "t/task.json": strToU8(
        JSON.stringify({ title: "T", work_type: "draft", instructions: "Do it.", criteria: [{ match_criteria: "P." }] }),
      ),
      "t/documents/../escape.txt": strToU8("x"),
    });
    const { tasks } = parseTasksZip(zip);
    expect(tasks[0].documents).toHaveLength(0);
  });
});

describe("buildTasksZip round-trip", () => {
  test("a custom task with documents survives export then import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-zip-"));
    try {
      await writeFile(join(dir, "memo.docx"), Buffer.from("deliverable-input"));
      const zip = await buildTasksZip({ configPath: join(dir, "config.json") }, [customRow({ documentsDir: dir })]);
      const { tasks, failed } = parseTasksZip(zip);
      expect(failed).toHaveLength(0);
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.definition.title).toBe("Draft Tax Memo");
      expect(task.definition.tags).toEqual(["Tax", "Corporate"]);
      expect(task.definition.deliverables).toEqual(["memo.docx"]);
      expect(task.definition.criteria[0].matchCriteria).toBe("PASS if section A present.");
      const doc = task.documents.find((entry) => entry.name === "memo.docx");
      expect(doc).toBeDefined();
      expect(Buffer.from(doc!.bytes).toString()).toBe("deliverable-input");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("distinct tasks with the same title get unique folders", async () => {
    const zip = await buildTasksZip({ configPath: "/tmp/none.json" }, [
      customRow({ id: "a", documentsDir: null }),
      customRow({ id: "b", documentsDir: null }),
    ]);
    const { tasks } = parseTasksZip(zip);
    expect(tasks).toHaveLength(2);
  });
});
