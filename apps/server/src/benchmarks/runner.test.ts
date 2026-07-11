import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { BenchmarkRunner, type BenchmarkOpencodeClient } from "./runner.js";
import { openBenchmarkStore, resetBenchmarkStoreCache, type BenchmarkStore } from "./store.js";

let dir: string;
let config: ServerConfig;
let workspace: WorkspaceInfo;
let store: BenchmarkStore;

const PROVIDERS = [
  { id: "prov", models: { "model-a": {}, "model-b": {} } },
  { id: "deepseek", models: { "deepseek-v4-flash": {} } },
];

type FakeBehavior = {
  agentDelayMs?: number;
  agentNeverFinishes?: boolean;
  agentError?: string;
  writeDeliverables?: string[];
  judgeStructured?: () => unknown;
  judgeDelayMs?: number;
  /** Simulate providers that reject the structured-output tool call (DeepSeek thinking mode). */
  judgeStructuredUnsupported?: boolean;
  /** Reply text for the plain-JSON fallback attempt (no format param). */
  judgeFallbackText?: string;
  promptAsyncUnsupported?: boolean;
};

type FakeStats = {
  activeAgents: number;
  maxActiveAgents: number;
  activeJudges: number;
  agentStarts: number;
  judgeStarts: number;
  agentJudgeOverlap: number;
  abortedSessions: string[];
  deletedSessions: string[];
};

function createFake(behavior: FakeBehavior = {}) {
  const stats: FakeStats = {
    activeAgents: 0,
    maxActiveAgents: 0,
    activeJudges: 0,
    agentStarts: 0,
    judgeStarts: 0,
    agentJudgeOverlap: 0,
    abortedSessions: [],
    deletedSessions: [],
  };
  const sessions = new Map<string, { directory: string; state: "idle" | "busy"; aborted: boolean }>();
  let counter = 0;

  const client: BenchmarkOpencodeClient = {
    session: {
      create: async (params) => {
        const id = `ses-${++counter}`;
        sessions.set(id, { directory: String(params.directory ?? ""), state: "idle", aborted: false });
        return { data: { id } };
      },
      promptAsync: async (params) => {
        if (behavior.promptAsyncUnsupported) {
          return { error: { status: 404, message: "prompt_async unsupported" } };
        }
        const session = sessions.get(String(params.sessionID))!;
        stats.agentStarts += 1;
        stats.activeAgents += 1;
        stats.maxActiveAgents = Math.max(stats.maxActiveAgents, stats.activeAgents);
        if (stats.activeJudges > 0) stats.agentJudgeOverlap += 1;
        session.state = "busy";
        if (!behavior.agentNeverFinishes) {
          setTimeout(() => {
            for (const name of behavior.writeDeliverables ?? []) {
              writeFileSync(join(session.directory, name), `content of ${name}`);
            }
            session.state = "idle";
            stats.activeAgents -= 1;
          }, behavior.agentDelayMs ?? 10);
        }
        return { error: undefined };
      },
      prompt: async (params) => {
        if (params.system) {
          // batched judge call (attempt 0 sends format; the fallback attempt does not)
          stats.judgeStarts += 1;
          if (stats.activeAgents > 0) stats.agentJudgeOverlap += 1;
          stats.activeJudges += 1;
          if (behavior.judgeDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, behavior.judgeDelayMs));
          }
          stats.activeJudges -= 1;
          const promptText = String((params.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");
          const criterionIds = Array.from(
            new Set(Array.from(promptText.matchAll(/### (C-\d+):/g), (match) => match[1]!)),
          );
          if (params.format) {
            if (behavior.judgeStructuredUnsupported) {
              return {
                data: {
                  info: {
                    role: "assistant",
                    error: { name: "ProviderError", data: { message: "Thinking mode does not support this tool_choice" } },
                  },
                  parts: [],
                },
              };
            }
            const structured = behavior.judgeStructured
              ? behavior.judgeStructured()
              : { verdicts: criterionIds.map((id) => ({ id, verdict: "pass", reasoning: "looks good" })) };
            return { data: { info: { role: "assistant", structured }, parts: [] } };
          }
          const text =
            behavior.judgeFallbackText ??
            `Let me check the deliverable first. ${JSON.stringify({
              verdicts: criterionIds.map((id) => ({ id, verdict: "pass", reasoning: "fallback ok" })),
            })}`;
          return { data: { info: { role: "assistant" }, parts: [{ type: "text", text }] } };
        }
        // synchronous agent fallback
        const session = sessions.get(String(params.sessionID))!;
        stats.agentStarts += 1;
        for (const name of behavior.writeDeliverables ?? []) {
          writeFileSync(join(session.directory, name), `content of ${name}`);
        }
        return { data: { info: { role: "assistant", cost: 0.5, tokens: { input: 10, output: 20 } }, parts: [] } };
      },
      status: async () => {
        const map: Record<string, { type: string }> = {};
        for (const [id, session] of sessions) {
          map[id] = { type: session.state };
        }
        return { data: map };
      },
      messages: async (params) => {
        const info = behavior.agentError
          ? { role: "assistant", error: { name: "UnknownError", data: { message: behavior.agentError } } }
          : { role: "assistant", cost: 0.25, tokens: { input: 5, output: 9 } };
        return { data: [{ info: { role: "user" } }, { info }] };
      },
      abort: async (params) => {
        const session = sessions.get(String(params.sessionID));
        if (session) {
          session.state = "idle";
          session.aborted = true;
          stats.abortedSessions.push(String(params.sessionID));
          if (stats.activeAgents > 0) stats.activeAgents -= 1;
        }
        return { data: true };
      },
      delete: async (params) => {
        stats.deletedSessions.push(String(params.sessionID));
        return { data: true };
      },
    },
    provider: {
      list: async () => ({ data: { all: PROVIDERS } }),
    },
  };

  return { client, stats };
}

function makeRunner(client: BenchmarkOpencodeClient, overrides?: { itemTimeoutMs?: number; judgeConcurrency?: number }) {
  return new BenchmarkRunner({
    config,
    createClient: () => client,
    judgeConcurrency: overrides?.judgeConcurrency ?? 2,
    timings: {
      pollIntervalMs: 5,
      itemTimeoutMs: overrides?.itemTimeoutMs ?? 2_000,
      judgeTimeoutMs: 500,
    },
  });
}

async function seedCustomTask(id: string, criteria = 2): Promise<void> {
  store.upsertTask({
    workspaceId: workspace.id,
    id,
    source: "custom",
    title: `Task ${id}`,
    workType: "draft",
    tagsJson: '["Contracts"]',
    instructions: "Write the memo.",
    deliverablesJson: '["memo.docx"]',
    criteriaJson: JSON.stringify(
      Array.from({ length: criteria }, (_, index) => ({
        id: `C-${index + 1}`,
        title: `Criterion ${index + 1}`,
        deliverables: ["memo.docx"],
        matchCriteria: "PASS if memo is fine.",
      })),
    ),
    harveyDocumentsJson: null,
    catalogRef: null,
    documentsDir: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "benchmark-runner-"));
  process.env.LEGALWORK_BENCHMARKS_DB = join(dir, "benchmarks.sqlite");
  resetBenchmarkStoreCache();
  config = { configPath: join(dir, "config.json") } as ServerConfig;
  workspace = {
    id: "ws-1",
    name: "Test",
    path: join(dir, "workspace"),
    preset: "starter",
    workspaceType: "local",
  } as WorkspaceInfo;
  mkdtempSync(join(tmpdir(), "x-")); // noop to keep fs warm
  const { mkdirSync } = await import("node:fs");
  mkdirSync(workspace.path, { recursive: true });
  store = await openBenchmarkStore(config);
});

afterEach(() => {
  delete process.env.LEGALWORK_BENCHMARKS_DB;
  resetBenchmarkStoreCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("createRun validation", () => {
  test("rejects unknown models with a clear error", async () => {
    await seedCustomTask("ct-1");
    const { client } = createFake();
    const runner = makeRunner(client);
    await expect(
      runner.createRun(workspace, {
        tasks: ["ct-1"],
        models: [{ providerID: "prov", modelID: "nope" }],
      }),
    ).rejects.toThrow(/not available/);
  });

  test("rejects unknown custom tasks and non-local workspaces", async () => {
    const { client } = createFake();
    const runner = makeRunner(client);
    await expect(
      runner.createRun(workspace, {
        tasks: ["missing"],
        models: [{ providerID: "prov", modelID: "model-a" }],
      }),
    ).rejects.toThrow(/Unknown benchmark task/);

    const remote = { ...workspace, workspaceType: "remote" } as WorkspaceInfo;
    await expect(
      runner.createRun(remote, {
        tasks: ["missing"],
        models: [{ providerID: "prov", modelID: "model-a" }],
      }),
    ).rejects.toThrow(/local workspace/);
  });

  test("defaults the judge to deepseek-v4-flash", async () => {
    await seedCustomTask("ct-1");
    const { client } = createFake({ writeDeliverables: ["memo.docx"] });
    const runner = makeRunner(client);
    const run = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    expect(run.judgeModel).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
  });
});

describe("run execution", () => {
  test("happy path: items pass, verdicts stored, deliverables collected", async () => {
    await seedCustomTask("ct-1");
    await seedCustomTask("ct-2");
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"] });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      title: "My benchmark",
      tasks: [
        "ct-1",
        "ct-2",
      ],
      models: [
        { providerID: "prov", modelID: "model-a" },
        { providerID: "prov", modelID: "model-b" },
      ],
      concurrency: 2,
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");

    const items = store.listItems(runId);
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.status).toBe("passed");
      expect(item.score).toBe(1);
      expect(item.nCriteria).toBe(2);
      expect(item.nPassed).toBe(2);
      expect(item.sessionId).toBeTruthy();
      expect(JSON.parse(item.deliverablesFound!).deliverables[0].relativePath).toBe("memo.docx");
      expect(store.listVerdicts(item.id)).toHaveLength(2);
    }
    // judging is batched: exactly ONE judge call per task×model item
    expect(stats.judgeStarts).toBe(4);
    // judge sessions are throwaway and cleaned up
    expect(stats.deletedSessions.length).toBe(4);
    // bounded agent concurrency
    expect(stats.maxActiveAgents).toBeLessThanOrEqual(2);

    const summary = runner.serializeRunSummary(store.getRun(runId)!);
    expect(summary.aggregateScore).toBe(1);
    expect((summary.scoreByModel as Array<{ passed: number }>)[0]!.passed).toBe(2);
    expect(summary.taskCount).toBe(2);
  });

  test("judging is piped while other agent sessions still run", async () => {
    await seedCustomTask("ct-1", 1);
    await seedCustomTask("ct-2", 1);
    await seedCustomTask("ct-3", 1);
    // concurrency 1 forces sequential agents; the slow judge of item N overlaps agent N+1
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"], agentDelayMs: 40, judgeDelayMs: 80 });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: [
        "ct-1",
        "ct-2",
        "ct-3",
      ],
      models: [{ providerID: "prov", modelID: "model-a" }],
      concurrency: 1,
    });
    await waitFor(() => store.getRun(created.id as string)?.status === "completed");
    expect(stats.agentJudgeOverlap).toBeGreaterThan(0);
  });

  test("agent error marks the item error without failing the run", async () => {
    await seedCustomTask("ct-1", 1);
    const { client } = createFake({ agentError: "provider exploded" });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("error");
    expect(item.error).toContain("provider exploded");
  });

  test("judge failing both attempts surfaces the item as error, not a graded fail", async () => {
    await seedCustomTask("ct-1", 1);
    let structuredCalls = 0;
    const { client } = createFake({
      writeDeliverables: ["memo.docx"],
      judgeStructured: () => {
        structuredCalls += 1;
        return { nonsense: true };
      },
      judgeFallbackText: "no verdict anywhere in this reply",
    });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("error");
    expect(item.error).toContain("judging failed for every criterion");
    expect(item.nPassed).toBe(0);
    expect(structuredCalls).toBe(1); // the retry drops structured output
    const verdicts = store.listVerdicts(item.id);
    expect(verdicts[0]?.verdict).toBe("error");
  });

  test("judge falls back to plain-JSON text when the provider rejects structured output", async () => {
    await seedCustomTask("ct-1", 2);
    const { client, stats } = createFake({
      writeDeliverables: ["memo.docx"],
      judgeStructuredUnsupported: true,
    });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("passed");
    expect(item.nPassed).toBe(2);
    // one rejected structured attempt + one successful text fallback for the whole batch
    expect(stats.judgeStarts).toBe(2);
    const verdicts = store.listVerdicts(item.id);
    expect(verdicts.every((verdict) => verdict.verdict === "pass")).toBe(true);
    expect(verdicts[0]?.reasoning).toBe("fallback ok");
  });

  test("agent timeout aborts the session and errors the item", async () => {
    await seedCustomTask("ct-1", 1);
    const { client, stats } = createFake({ agentNeverFinishes: true });
    const runner = makeRunner(client, { itemTimeoutMs: 60 });
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("error");
    expect(item.error).toContain("timed out");
    expect(stats.abortedSessions.length).toBeGreaterThan(0);
  });

  test("falls back to synchronous prompt when prompt_async is unsupported", async () => {
    await seedCustomTask("ct-1", 1);
    const { client } = createFake({ promptAsyncUnsupported: true, writeDeliverables: ["memo.docx"] });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    expect(store.listItems(runId)[0]!.status).toBe("passed");
  });
});

describe("abort / resume / delete", () => {
  test("abort flips pending and in-flight items to aborted", async () => {
    await seedCustomTask("ct-1", 1);
    await seedCustomTask("ct-2", 1);
    const { client, stats } = createFake({ agentNeverFinishes: true });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: [
        "ct-1",
        "ct-2",
      ],
      models: [{ providerID: "prov", modelID: "model-a" }],
      concurrency: 1,
    });
    const runId = created.id as string;
    await waitFor(() => store.countItemsByStatus(runId).running >= 1);

    await runner.abortRun(workspace, runId);
    await waitFor(() => store.getRun(runId)?.status === "aborted");
    const counts = store.countItemsByStatus(runId);
    expect(counts.aborted).toBe(2);
    expect(stats.abortedSessions.length).toBeGreaterThan(0);

    // resume re-queues aborted items and completes them
    const { client: healthyClient } = createFake({ writeDeliverables: ["memo.docx"] });
    const resumingRunner = makeRunner(healthyClient);
    await resumingRunner.resumeRun(workspace, runId);
    await waitFor(() => store.getRun(runId)?.status === "completed");
    expect(store.countItemsByStatus(runId).passed).toBe(2);
  });

  test("delete refuses while running, works after abort, and clears rows", async () => {
    await seedCustomTask("ct-1", 1);
    const { client } = createFake({ agentNeverFinishes: true });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.countItemsByStatus(runId).running >= 1);
    await expect(runner.deleteRun(workspace, runId)).rejects.toThrow(/Abort the run/);

    await runner.abortRun(workspace, runId);
    await waitFor(() => store.getRun(runId)?.status === "aborted");
    await runner.deleteRun(workspace, runId);
    expect(store.getRun(runId)).toBeNull();
  });
});
