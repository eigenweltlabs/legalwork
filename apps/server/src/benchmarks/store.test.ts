import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkStore, type BenchmarkModelRef, type NewBenchmarkItem } from "./store.js";

let dir: string;
let store: BenchmarkStore;

const MODELS: BenchmarkModelRef[] = [
  { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
  { providerID: "openai", modelID: "gpt-5.4" },
];

function makeItems(runId: string): NewBenchmarkItem[] {
  const items: NewBenchmarkItem[] = [];
  for (const taskKey of ["tasks/tax/draft-memo", "custom-1"]) {
    for (const model of MODELS) {
      items.push({
        id: `${runId}-${taskKey.replaceAll("/", "_")}-${model.providerID}`,
        taskSource: taskKey.startsWith("tasks/") ? "harvey" : "custom",
        taskKey,
        taskTitle: `Title for ${taskKey}`,
        workType: "draft",
        vertical: "tax",
        taskJson: JSON.stringify({ title: `Title for ${taskKey}` }),
        providerId: model.providerID,
        modelId: model.modelID,
      });
    }
  }
  return items;
}

function createRun(id: string, workspaceId = "ws-1"): void {
  store.createRun(
    {
      id,
      workspaceId,
      title: `Run ${id}`,
      status: "pending",
      judgeProviderId: "deepseek",
      judgeModelId: "deepseek-v4-flash",
      concurrency: 3,
      catalogRef: "abc123",
      createdAt: 1000,
    },
    MODELS,
    makeItems(id),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "benchmark-store-"));
  store = await BenchmarkStore.open(join(dir, "benchmarks.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("runs", () => {
  test("create/get/list roundtrip", () => {
    createRun("run-1");
    const run = store.getRun("run-1");
    expect(run?.status).toBe("pending");
    expect(run?.judgeModelId).toBe("deepseek-v4-flash");
    expect(run?.catalogRef).toBe("abc123");
    expect(store.listRuns("ws-1")).toHaveLength(1);
    expect(store.listRuns("ws-other")).toHaveLength(0);
    expect(store.runModels("run-1")).toEqual(MODELS);
    expect(store.listItems("run-1")).toHaveLength(4);
  });

  test("update run status and timestamps", () => {
    createRun("run-1");
    store.updateRun("run-1", { status: "running", startedAt: 2000 });
    expect(store.getRun("run-1")?.status).toBe("running");
    expect(store.getRun("run-1")?.startedAt).toBe(2000);
    store.updateRun("run-1", { status: "completed", finishedAt: 3000 });
    const run = store.getRun("run-1");
    expect(run?.status).toBe("completed");
    expect(run?.finishedAt).toBe(3000);
    expect(run?.startedAt).toBe(2000);
  });

  test("delete cascades to items, models and verdicts", () => {
    createRun("run-1");
    const item = store.listItems("run-1")[0]!;
    store.upsertVerdict({
      itemId: item.id,
      criterionId: "C-001",
      criterionTitle: "t",
      verdict: "pass",
      reasoning: "ok",
      judgeSessionId: null,
      judgedAt: 1,
    });
    store.deleteRun("run-1");
    expect(store.getRun("run-1")).toBeNull();
    expect(store.listItems("run-1")).toHaveLength(0);
    expect(store.runModels("run-1")).toHaveLength(0);
    expect(store.listVerdicts(item.id)).toHaveLength(0);
  });
});

describe("items", () => {
  test("status transitions and counts", () => {
    createRun("run-1");
    const items = store.listItems("run-1");
    store.updateItem(items[0]!.id, { status: "running", sessionId: "ses-1", startedAt: 10 });
    store.updateItem(items[1]!.id, { status: "passed", score: 1, nCriteria: 3, nPassed: 3, finishedAt: 20 });
    const counts = store.countItemsByStatus("run-1");
    expect(counts.pending).toBe(2);
    expect(counts.running).toBe(1);
    expect(counts.passed).toBe(1);
    const item = store.getItem(items[0]!.id);
    expect(item?.sessionId).toBe("ses-1");
    expect(store.listItemsByStatus("run-1", ["pending"])).toHaveLength(2);
  });

  test("partial patch leaves other columns intact", () => {
    createRun("run-1");
    const id = store.listItems("run-1")[0]!.id;
    store.updateItem(id, { sessionId: "ses-9" });
    store.updateItem(id, { status: "judging" });
    const item = store.getItem(id);
    expect(item?.sessionId).toBe("ses-9");
    expect(item?.status).toBe("judging");
  });
});

describe("verdicts", () => {
  test("upsert replaces existing verdict", () => {
    createRun("run-1");
    const itemId = store.listItems("run-1")[0]!.id;
    store.upsertVerdict({
      itemId,
      criterionId: "C-001",
      criterionTitle: "t",
      verdict: "fail",
      reasoning: "missing section",
      judgeSessionId: "judge-1",
      judgedAt: 1,
    });
    store.upsertVerdict({
      itemId,
      criterionId: "C-001",
      criterionTitle: "t",
      verdict: "pass",
      reasoning: "found on retry",
      judgeSessionId: "judge-2",
      judgedAt: 2,
    });
    const verdicts = store.listVerdicts(itemId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.verdict).toBe("pass");
    expect(verdicts[0]?.judgedAt).toBe(2);
  });
});

describe("tasks", () => {
  const baseTask = {
    workspaceId: "ws-1",
    id: "ct_1",
    source: "custom" as const,
    title: "Review NDA",
    workType: "review" as const,
    tagsJson: '["Contracts"]',
    instructions: "Review it.",
    deliverablesJson: '["findings.md"]',
    criteriaJson: "[]",
    harveyDocumentsJson: null,
    catalogRef: null,
    documentsDir: null,
    createdAt: 1,
    updatedAt: 1,
  };

  test("upsert/get/list/delete roundtrip scoped by workspace", () => {
    store.upsertTask(baseTask);
    store.upsertTask({
      ...baseTask,
      id: "tasks/tax/draft-memo",
      source: "harvey",
      harveyDocumentsJson: '["input.docx"]',
      catalogRef: "sha-1",
      createdAt: 2,
      updatedAt: 2,
    });
    expect(store.listTasks("ws-1")).toHaveLength(2);
    expect(store.listTasks("ws-2")).toHaveLength(0);
    expect(store.getTask("ws-1", "tasks/tax/draft-memo")?.catalogRef).toBe("sha-1");
    expect(store.getTask("ws-2", "ct_1")).toBeNull();

    // re-importing the same key replaces the row instead of duplicating it
    store.upsertTask({ ...baseTask, title: "Review NDA v2", updatedAt: 5 });
    expect(store.listTasks("ws-1")).toHaveLength(2);
    expect(store.getTask("ws-1", "ct_1")?.title).toBe("Review NDA v2");

    store.deleteTask("ws-1", "ct_1");
    expect(store.getTask("ws-1", "ct_1")).toBeNull();
  });
});

describe("latestResults", () => {
  test("returns the item from the most recent run per task×model", () => {
    // run-1 (older) and run-2 (newer) share a task×model pair
    createRun("run-1");
    createRun("run-2");
    store.updateRun("run-1", { status: "completed" });
    store.updateRun("run-2", { status: "completed" });
    // make run-2 newer
    for (const item of store.listItems("run-1")) {
      store.updateItem(item.id, { status: "failed", score: 0, nCriteria: 2, nPassed: 1 });
    }
    for (const item of store.listItems("run-2")) {
      store.updateItem(item.id, { status: "passed", score: 1, nCriteria: 2, nPassed: 2 });
    }
    // both runs were created with createdAt 1000; bump run-2 to be newer
    // (updateRun has no createdAt patch — write directly through a new run instead)
    store.deleteRun("run-2");
    store.createRun(
      {
        id: "run-2",
        workspaceId: "ws-1",
        title: "Run run-2",
        status: "pending",
        judgeProviderId: "deepseek",
        judgeModelId: "deepseek-v4-flash",
        concurrency: 3,
        catalogRef: "abc123",
        createdAt: 2000,
      },
      MODELS,
      makeItems("run-2"),
    );
    for (const item of store.listItems("run-2")) {
      store.updateItem(item.id, { status: "passed", score: 1, nCriteria: 2, nPassed: 2 });
    }

    const results = store.latestResults("ws-1");
    // 2 tasks × 2 models = 4 latest entries, all from run-2
    expect(results).toHaveLength(4);
    expect(results.every((row) => row.runId === "run-2")).toBe(true);
    expect(results.every((row) => row.status === "passed")).toBe(true);
    expect(results[0]).toMatchObject({ nPassed: 2, nCriteria: 2, runCreatedAt: 2000 });
    expect(store.latestResults("ws-other")).toHaveLength(0);
  });
});

describe("catalog cache", () => {
  test("head, index and task cache", () => {
    expect(store.getCatalogHead()).toBeNull();
    store.setCatalogHead("sha-1", 100);
    store.setCatalogHead("sha-2", 200);
    expect(store.getCatalogHead()).toEqual({ ref: "sha-2", fetchedAt: 200 });

    store.setCatalogIndex("sha-2", '{"items":[]}', 200);
    expect(store.getCatalogIndex("sha-2")).toBe('{"items":[]}');
    expect(store.getCatalogIndex("sha-1")).toBeNull();

    store.setCachedTask("sha-2", "tasks/tax/draft-memo", '{"title":"x"}', 201);
    store.setCachedTask("sha-2", "tasks/tax/draft-memo", '{"title":"y"}', 202);
    expect(store.getCachedTask("sha-2", "tasks/tax/draft-memo")).toBe('{"title":"y"}');
    expect(store.countCachedTasks("sha-2")).toBe(1);
    expect(store.listCachedTasks("sha-2")).toHaveLength(1);
  });
});

describe("recovery", () => {
  test("marks in-flight runs and items interrupted", () => {
    createRun("run-1");
    createRun("run-2");
    const items1 = store.listItems("run-1");
    store.updateRun("run-1", { status: "running", startedAt: 1 });
    store.updateItem(items1[0]!.id, { status: "running" });
    store.updateItem(items1[1]!.id, { status: "judging" });
    store.updateItem(items1[2]!.id, { status: "passed", score: 1 });
    store.updateRun("run-2", { status: "completed", finishedAt: 5 });
    for (const item of store.listItems("run-2")) {
      store.updateItem(item.id, { status: "passed" });
    }

    const result = store.recoverInterrupted(999);
    expect(result.runs).toBe(1);
    // run-1: two in-flight + one still pending = 3 interrupted; the passed one is kept
    expect(result.items).toBe(3);
    expect(store.getRun("run-1")?.status).toBe("interrupted");
    expect(store.getRun("run-2")?.status).toBe("completed");
    const counts = store.countItemsByStatus("run-1");
    expect(counts.interrupted).toBe(3);
    expect(counts.passed).toBe(1);
  });
});
