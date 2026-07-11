import { beforeEach, describe, expect, test } from "bun:test";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { BenchmarkRunSummary, BenchmarkTaskItem } from "../src/app/lib/benchmark-types";
import {
  attachBenchmarkContext,
  useBenchmarkStore,
} from "../src/react-app/domains/benchmark/store";

function runSummary(patch: Partial<BenchmarkRunSummary>): BenchmarkRunSummary {
  return {
    id: "run-1",
    title: "Run",
    status: "completed",
    judgeModel: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    models: [{ providerID: "prov", modelID: "m" }],
    concurrency: 3,
    catalogRef: "sha",
    createdAt: 1,
    startedAt: 1,
    finishedAt: 2,
    error: null,
    taskCount: 1,
    counts: {
      pending: 0,
      preparing: 0,
      running: 0,
      judging: 0,
      passed: 1,
      failed: 0,
      error: 0,
      aborted: 0,
      interrupted: 0,
    },
    progress: { completed: 1, total: 1 },
    aggregateScore: 1,
    scoreByModel: [],
    ...patch,
  };
}

function taskItem(patch: Partial<BenchmarkTaskItem>): BenchmarkTaskItem {
  return {
    id: "tasks/tax/draft-memo",
    source: "harvey",
    title: "Draft memo",
    workType: "draft",
    tags: ["Tax"],
    instructions: "Draft it.",
    deliverables: ["memo.docx"],
    criteria: [],
    criteriaCount: 2,
    docCount: 1,
    catalogRef: "sha",
    createdAt: 1,
    updatedAt: 1,
    latestResults: [],
    ...patch,
  };
}

type Calls = Array<{ method: string; args: unknown[] }>;

function fakeClient(overrides: Partial<Record<string, (...args: any[]) => unknown>> = {}) {
  const calls: Calls = [];
  const handler = (method: string, fallback: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      const custom = overrides[method];
      if (custom) return custom(...args);
      return fallback;
    };
  const client = {
    benchmarkListTasks: handler("benchmarkListTasks", { items: [taskItem({}), taskItem({ id: "ct_1", source: "custom" })] }),
    benchmarkImportTasks: handler("benchmarkImportTasks", { items: [taskItem({})], failed: [] }),
    benchmarkCreateTask: handler("benchmarkCreateTask", { item: taskItem({ id: "ct_new", source: "custom" }) }),
    benchmarkUpdateTask: handler("benchmarkUpdateTask", { item: taskItem({ id: "ct_1", source: "custom", title: "v2" }) }),
    benchmarkDeleteTask: handler("benchmarkDeleteTask", { ok: true }),
    benchmarkListRuns: handler("benchmarkListRuns", { items: [runSummary({})] }),
    benchmarkCreateRun: handler("benchmarkCreateRun", { run: runSummary({ id: "run-new", status: "pending" }) }),
    benchmarkGetRun: handler("benchmarkGetRun", { run: runSummary({}), items: [] }),
    benchmarkGetRunProgress: handler("benchmarkGetRunProgress", {}),
    benchmarkGetRunItem: handler("benchmarkGetRunItem", { item: {}, task: null, verdicts: [], deliverables: null }),
    benchmarkAbortRun: handler("benchmarkAbortRun", { run: runSummary({ status: "aborted" }) }),
    benchmarkResumeRun: handler("benchmarkResumeRun", { run: runSummary({ status: "pending" }) }),
    benchmarkDeleteRun: handler("benchmarkDeleteRun", { ok: true }),
    benchmarkGetCatalog: handler("benchmarkGetCatalog", {
      ref: "sha",
      verticals: [{ id: "tax", label: "Tax", count: 1 }],
      items: [
        {
          key: "tasks/tax/draft-memo",
          source: "harvey",
          vertical: "tax",
          verticalLabel: "Tax",
          name: "draft-memo",
          docCount: 1,
          hydrated: true,
          title: "Draft memo",
          workType: "draft",
        },
      ],
      hydration: { hydrated: 1, total: 1 },
    }),
  } as unknown as LegalworkServerClient;
  return { client, calls };
}

beforeEach(() => {
  attachBenchmarkContext(null, "");
  useBenchmarkStore.getState().reset();
});

describe("benchmark store", () => {
  test("actions are inert without an attached context", async () => {
    await useBenchmarkStore.getState().refreshTasks();
    expect(useBenchmarkStore.getState().tasksStatus).toBe("idle");
  });

  test("refreshTasks loads the task table and prunes stale selection", async () => {
    const { client, calls } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    useBenchmarkStore.getState().setTaskSelection(["tasks/tax/draft-memo", "gone"]);
    await useBenchmarkStore.getState().refreshTasks();
    const state = useBenchmarkStore.getState();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasksStatus).toBe("ready");
    expect(state.selectedTaskIds).toEqual(["tasks/tax/draft-memo"]);
    expect(calls[0]).toMatchObject({ method: "benchmarkListTasks", args: ["ws-1"] });
  });

  test("selection toggles single and all", () => {
    const { client } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    const store = useBenchmarkStore.getState();
    store.toggleTaskSelection("a");
    store.toggleTaskSelection("b");
    store.toggleTaskSelection("a");
    expect(useBenchmarkStore.getState().selectedTaskIds).toEqual(["b"]);
    store.setTaskSelection(["a", "b", "b"]);
    expect(useBenchmarkStore.getState().selectedTaskIds).toEqual(["a", "b"]);
    store.clearTaskSelection();
    expect(useBenchmarkStore.getState().selectedTaskIds).toEqual([]);
  });

  test("importSelected posts keys, clears selection and refreshes tasks", async () => {
    const { client, calls } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    useBenchmarkStore.getState().setImportSelection(["tasks/tax/draft-memo"]);
    const count = await useBenchmarkStore.getState().importSelected();
    expect(count).toBe(1);
    expect(useBenchmarkStore.getState().importSelection).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["benchmarkImportTasks", "benchmarkListTasks"]);
    expect(calls[0]?.args).toEqual(["ws-1", ["tasks/tax/draft-memo"]]);
  });

  test("import failures surface as importError", async () => {
    const { client } = fakeClient({
      benchmarkImportTasks: () => ({ items: [], failed: [{ key: "tasks/x/y", error: "not found" }] }),
    });
    attachBenchmarkContext(client, "ws-1");
    useBenchmarkStore.getState().setImportSelection(["tasks/x/y"]);
    await useBenchmarkStore.getState().importSelected();
    expect(useBenchmarkStore.getState().importError).toContain("tasks/x/y");
  });

  test("createTask prepends to the table", async () => {
    const { client } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    const item = await useBenchmarkStore.getState().createTask({
      title: "Custom",
      workType: "review",
      instructions: "x",
      criteria: [{ matchCriteria: "PASS" }],
    });
    expect(item?.id).toBe("ct_new");
    expect(useBenchmarkStore.getState().tasks[0]?.id).toBe("ct_new");
  });

  test("createRun posts selected task ids and resets draft + selection", async () => {
    const { client, calls } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    const store = useBenchmarkStore.getState();
    store.setTaskSelection(["tasks/tax/draft-memo", "ct_1"]);
    store.toggleModel({ providerID: "prov", modelID: "a" });
    store.setDraftName("My run");

    const run = await useBenchmarkStore.getState().createRun();
    expect(run?.id).toBe("run-new");
    const createCall = calls.find((call) => call.method === "benchmarkCreateRun");
    expect(createCall?.args[1]).toMatchObject({
      title: "My run",
      tasks: ["tasks/tax/draft-memo", "ct_1"],
      models: [{ providerID: "prov", modelID: "a" }],
      judgeModel: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    });
    const state = useBenchmarkStore.getState();
    expect(state.runs[0]?.id).toBe("run-new");
    expect(state.selectedTaskIds).toEqual([]);
    expect(state.draft.models).toEqual([]);
  });

  test("createRun without selection or models is a no-op", async () => {
    const { client, calls } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    expect(await useBenchmarkStore.getState().createRun()).toBeNull();
    useBenchmarkStore.getState().setTaskSelection(["ct_1"]);
    expect(await useBenchmarkStore.getState().createRun()).toBeNull();
    expect(calls.find((call) => call.method === "benchmarkCreateRun")).toBeUndefined();
  });

  test("run completion triggers a task-table refresh", async () => {
    let active = true;
    const { client, calls } = fakeClient({
      benchmarkListRuns: () => ({ items: [runSummary({ status: active ? "running" : "completed" })] }),
    });
    attachBenchmarkContext(client, "ws-1");
    await useBenchmarkStore.getState().refreshRuns();
    active = false;
    await useBenchmarkStore.getState().refreshRuns();
    expect(calls.map((call) => call.method)).toContain("benchmarkListTasks");
  });

  test("loadRun + abort updates active run state", async () => {
    const { client, calls } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    await useBenchmarkStore.getState().loadRun("run-1");
    expect(useBenchmarkStore.getState().activeRun?.run.id).toBe("run-1");
    await useBenchmarkStore.getState().abortRun("run-1");
    expect(calls.some((call) => call.method === "benchmarkAbortRun")).toBe(true);
  });

  test("catalog loads for the import modal", async () => {
    const { client } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    await useBenchmarkStore.getState().refreshCatalog();
    const state = useBenchmarkStore.getState();
    expect(state.catalogStatus).toBe("ready");
    expect(state.catalogItems).toHaveLength(1);
    expect(state.catalogHydration).toEqual({ hydrated: 1, total: 1 });
  });

  test("attaching a different workspace resets state", async () => {
    const { client } = fakeClient();
    attachBenchmarkContext(client, "ws-1");
    await useBenchmarkStore.getState().refreshTasks();
    expect(useBenchmarkStore.getState().tasks).toHaveLength(2);
    attachBenchmarkContext(client, "ws-2");
    expect(useBenchmarkStore.getState().tasks).toHaveLength(0);
    expect(useBenchmarkStore.getState().tasksStatus).toBe("idle");
  });
});
