import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDeliverables,
  itemWorkDir,
  prepareItemWorkDir,
  removeRunScratchDir,
} from "./workdir.js";

let workspace: string;
let docsSource: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "benchmark-workspace-"));
  docsSource = mkdtempSync(join(tmpdir(), "benchmark-docs-"));
  writeFileSync(join(docsSource, "input.docx"), "INPUT");
  mkdirSync(join(docsSource, "nested"));
  writeFileSync(join(docsSource, "nested", "data.xlsx"), "DATA");
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(docsSource, { recursive: true, force: true });
});

describe("prepareItemWorkDir", () => {
  test("creates a clean dir with staged documents and a scratch gitignore", async () => {
    const workDir = await prepareItemWorkDir({
      workspacePath: workspace,
      runId: "run-1",
      itemId: "item-1",
      documentsDir: docsSource,
    });
    expect(workDir).toBe(itemWorkDir(workspace, "run-1", "item-1"));
    expect(readFileSync(join(workDir, "documents", "input.docx"), "utf8")).toBe("INPUT");
    expect(readFileSync(join(workDir, "documents", "nested", "data.xlsx"), "utf8")).toBe("DATA");
    expect(readFileSync(join(workspace, ".legalwork", "benchmarks", ".gitignore"), "utf8")).toBe("*\n");

    // Re-preparing wipes stale content.
    writeFileSync(join(workDir, "stale.md"), "old");
    const again = await prepareItemWorkDir({
      workspacePath: workspace,
      runId: "run-1",
      itemId: "item-1",
      documentsDir: null,
    });
    expect(existsSync(join(again, "stale.md"))).toBe(false);
    expect(existsSync(join(again, "documents"))).toBe(false);
  });
});

describe("collectDeliverables", () => {
  test("matches basenames case-insensitively, ignores staged documents, prefers shallow files", async () => {
    const workDir = await prepareItemWorkDir({
      workspacePath: workspace,
      runId: "run-1",
      itemId: "item-1",
      documentsDir: docsSource,
    });
    writeFileSync(join(workDir, "Memo.DOCX"), "OUTPUT-MEMO");
    mkdirSync(join(workDir, "drafts"));
    writeFileSync(join(workDir, "drafts", "memo.docx"), "DEEP-MEMO");
    writeFileSync(join(workDir, "notes.txt"), "notes");

    const { deliverables, outputFiles } = await collectDeliverables(workDir, ["memo.docx", "summary.md"]);
    expect(deliverables[0]).toEqual({ name: "memo.docx", relativePath: "Memo.DOCX", size: 11 });
    expect(deliverables[1]).toEqual({ name: "summary.md", relativePath: null, size: null });
    // staged inputs never count as output
    expect(outputFiles).not.toContain(join("documents", "input.docx"));
    expect(outputFiles).toContain("notes.txt");
  });
});

describe("stageTaskDocuments", () => {
  test("mirrors documents into the workspace scratch area with workspace-relative paths", async () => {
    const { stageTaskDocuments } = await import("./workdir.js");
    const staged = await stageTaskDocuments(workspace, "tasks/tax/draft-memo", docsSource);
    expect(staged).toEqual([
      {
        name: "input.docx",
        relativePath: ".legalwork/benchmarks/task-docs/tasks_tax_draft-memo/input.docx",
        size: 5,
      },
      {
        name: "nested/data.xlsx",
        relativePath: ".legalwork/benchmarks/task-docs/tasks_tax_draft-memo/nested/data.xlsx",
        size: 4,
      },
    ]);
    expect(readFileSync(join(workspace, staged[0]!.relativePath), "utf8")).toBe("INPUT");
    expect(existsSync(join(workspace, ".legalwork", "benchmarks", ".gitignore"))).toBe(true);

    // second stage is a no-op copy but still lists everything
    const again = await stageTaskDocuments(workspace, "tasks/tax/draft-memo", docsSource);
    expect(again).toHaveLength(2);

    // no source documents → empty list, nothing staged
    const none = await stageTaskDocuments(workspace, "ct_1", null);
    expect(none).toEqual([]);
  });
});

describe("removeRunScratchDir", () => {
  test("removes the whole run directory", async () => {
    const workDir = await prepareItemWorkDir({
      workspacePath: workspace,
      runId: "run-1",
      itemId: "item-1",
      documentsDir: null,
    });
    writeFileSync(join(workDir, "memo.docx"), "x");
    await removeRunScratchDir(workspace, "run-1");
    expect(existsSync(workDir)).toBe(false);
  });
});
