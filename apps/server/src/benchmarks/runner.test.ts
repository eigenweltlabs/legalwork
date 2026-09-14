import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import type { BenchmarkArm } from "./ablation.js";
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
  /**
   * How many agent turns (per session, in order) end cut off at the output
   * limit — `finish: "length"`, nothing written — before turns finish normally.
   */
  cutOffTurns?: number;
  /** Cut-off turns still write the deliverables (cut off afterwards, e.g. in the summary). */
  cutOffAfterWriting?: boolean;
  /**
   * Delay before the engine picks a prompt up. Until then the session reads
   * idle and its last assistant message is the previous turn's reply.
   */
  startDelayMs?: number;
  /** Model limits the fake provider list reports, keyed by model id. */
  modelLimits?: Record<string, { context: number; output: number }>;
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
  /** Every agent prompt the runner sent, for asserting ablation reached the engine. */
  agentPrompts: Array<{ tools: Record<string, boolean> | undefined; text: string }>;
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
    agentPrompts: [],
  };
  type FakeSession = {
    directory: string;
    state: "idle" | "busy";
    aborted: boolean;
    turns: number;
    replies: Array<Record<string, unknown>>;
    /** The in-flight turn, cancelled by abort like a real engine stops generating. */
    timer?: ReturnType<typeof setTimeout>;
  };
  const sessions = new Map<string, FakeSession>();
  let counter = 0;
  let replyCounter = 0;

  const client: BenchmarkOpencodeClient = {
    session: {
      create: async (params) => {
        const id = `ses-${++counter}`;
        sessions.set(id, { directory: String(params.directory ?? ""), state: "idle", aborted: false, turns: 0, replies: [] });
        return { data: { id } };
      },
      promptAsync: async (params) => {
        stats.agentPrompts.push({
          tools: params.tools as Record<string, boolean> | undefined,
          text: String((params.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? ""),
        });
        if (behavior.promptAsyncUnsupported) {
          return { error: { status: 404, message: "prompt_async unsupported" } };
        }
        const session = sessions.get(String(params.sessionID))!;
        session.turns += 1;
        const cutOff = session.turns <= (behavior.cutOffTurns ?? 0);
        stats.agentStarts += 1;
        stats.activeAgents += 1;
        stats.maxActiveAgents = Math.max(stats.maxActiveAgents, stats.activeAgents);
        if (stats.activeJudges > 0) stats.agentJudgeOverlap += 1;
        const begin = () => {
          session.state = "busy";
          if (behavior.agentNeverFinishes) return;
          session.timer = setTimeout(() => {
            session.timer = undefined;
            if (!cutOff || behavior.cutOffAfterWriting) {
              for (const name of behavior.writeDeliverables ?? []) {
                writeFileSync(join(session.directory, name), `content of ${name}`);
              }
            }
            const id = `msg-${++replyCounter}`;
            session.replies.push(
              behavior.agentError
                ? { id, role: "assistant", error: { name: "UnknownError", data: { message: behavior.agentError } } }
                : cutOff
                  ? { id, role: "assistant", finish: "length", cost: 0, tokens: { input: 5, output: 0 } }
                  : { id, role: "assistant", finish: "stop", cost: 0.25, tokens: { input: 5, output: 9 } },
            );
            session.state = "idle";
            stats.activeAgents -= 1;
          }, behavior.agentDelayMs ?? 10);
        };
        if (behavior.startDelayMs) session.timer = setTimeout(begin, behavior.startDelayMs);
        else begin();
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
        const session = sessions.get(String(params.sessionID));
        const replies = (session?.replies ?? []).map((info) => ({ info }));
        return { data: [{ info: { role: "user" } }, ...replies] };
      },
      abort: async (params) => {
        const session = sessions.get(String(params.sessionID));
        if (session) {
          // Stop the in-flight turn: a pending write would otherwise land after
          // the test has already removed the work dir.
          if (session.timer) clearTimeout(session.timer);
          session.timer = undefined;
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
      list: async () => ({
        data: {
          all: PROVIDERS.map((provider) => ({
            ...provider,
            models: Object.fromEntries(
              Object.keys(provider.models).map((id) => [
                id,
                behavior.modelLimits?.[id] ? { limit: behavior.modelLimits[id] } : {},
              ]),
            ),
          })),
        },
      }),
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

describe("ablation arms", () => {
  test("expands the grid by arm and sends each arm's ablation to the engine", async () => {
    await seedCustomTask("ct-1");
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"] });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
      arms: [
        { label: "Full" },
        { label: "No bash", config: { tools: { bash: false } } },
        { label: "No skills", config: { skills: { mode: "none" } } },
        { label: "No tabular", config: { skills: { mode: "deny", names: ["tabular-review"] } } },
      ],
      concurrency: 4,
    });
    await waitFor(() => store.getRun(created.id as string)?.status === "completed");

    // 1 task × 1 model × 4 arms.
    const detail = await runner.getRunDetail(workspace, created.id as string);
    const items = detail.items as Array<{ armId: string; armLabel: string }>;
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.armId).sort()).toEqual(["full", "no-bash", "no-skills", "no-tabular"]);

    // Tool ablation rides the engine's native tools map...
    const toolMaps = stats.agentPrompts.map((prompt) => prompt.tools);
    expect(toolMaps).toContainEqual({ bash: false });
    // ...and "no skills" collapses into it as the single skill tool.
    expect(toolMaps).toContainEqual({ skill: false });
    // Two arms send no tools override: the baseline (nothing ablated) and the
    // named-skill arm, which the tools map cannot express — one `skill` tool
    // gates every skill, so denying one by name is the plugin's job.
    expect(toolMaps.filter((tools) => tools === undefined)).toHaveLength(2);
    expect(toolMaps).not.toContainEqual({ skill: false, "tabular-review": false });

    // The model is told what it lost, appended to the task prompt rather than
    // replacing the system prompt.
    const ablated = stats.agentPrompts.filter((prompt) => prompt.text.includes("ablation arm"));
    expect(ablated).toHaveLength(3);
    for (const prompt of ablated) expect(prompt.text).toContain("Write the memo");
  });

  test("a run without arms keeps the plain tasks × models shape", async () => {
    await seedCustomTask("ct-1");
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"] });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    await waitFor(() => store.getRun(created.id as string)?.status === "completed");

    const detail = await runner.getRunDetail(workspace, created.id as string);
    expect(detail.items as unknown[]).toHaveLength(1);
    expect((detail.run as { arms: BenchmarkArm[] }).arms).toEqual([
      { id: "full", label: "Full", config: {} },
    ]);
    // No ablation means no tools override and no restriction note.
    expect(stats.agentPrompts[0]?.tools).toBeUndefined();
    expect(stats.agentPrompts[0]?.text).not.toContain("ablation arm");
  });
});

describe("replies cut off at the output limit", () => {
  const RECOVERY_PROMPT = /cut off because it reached the model's output token limit/;

  test("a cut-off reply is followed up, and the finished work is judged", async () => {
    await seedCustomTask("ct-1", 1);
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"], cutOffTurns: 1 });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
      arms: [{ label: "No bash", config: { tools: { bash: false } } }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");

    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("passed");
    expect(item.nPassed).toBe(1);
    // The task prompt, then exactly one follow-up.
    expect(stats.agentPrompts).toHaveLength(2);
    expect(stats.agentPrompts[1]!.text).toMatch(RECOVERY_PROMPT);
    // The follow-up keeps the arm's ablation — recovery must not hand bash back.
    expect(stats.agentPrompts[1]!.tools).toEqual({ bash: false });
  });

  test("still cut off after the follow-ups with nothing written: an error, never a 0% score", async () => {
    await seedCustomTask("ct-1", 1);
    const { client, stats } = createFake({
      writeDeliverables: ["memo.docx"],
      cutOffTurns: 99,
      modelLimits: { "model-a": { context: 1_048_576, output: 16_384 } },
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
    // Names the limit the engine enforced, so a stale default is recognisable.
    expect(item.error).toContain("output limit (16,384 tokens)");
    // Never judged: no rubric counts, so it stays off every score.
    expect(item.nCriteria).toBeNull();
    expect(item.nPassed).toBeNull();
    expect(stats.judgeStarts).toBe(0);
    // The task prompt plus both follow-ups.
    expect(stats.agentPrompts).toHaveLength(3);
  });

  test("the reported limit is the one the engine enforces, not a higher configured value", async () => {
    await seedCustomTask("ct-1", 1);
    const { client } = createFake({
      cutOffTurns: 99,
      modelLimits: { "model-a": { context: 1_048_576, output: 65_536 } },
    });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    expect(store.listItems(runId)[0]!.error).toContain("output limit (32,000 tokens)");
  });

  test("a reply cut off after the deliverable was written is judged normally", async () => {
    await seedCustomTask("ct-1", 1);
    const { client } = createFake({ writeDeliverables: ["memo.docx"], cutOffTurns: 99, cutOffAfterWriting: true });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    // A tool call runs whole or not at all, so a written file is complete work.
    expect(store.listItems(runId)[0]!.status).toBe("passed");
  });

  test("a follow-up is not answered by the previous turn's reply", async () => {
    await seedCustomTask("ct-1", 1);
    // The engine takes a moment to pick each prompt up. Meanwhile the session
    // reads idle and still ends with the cut-off reply — counting that as the
    // answer would burn every follow-up without the agent ever running.
    const { client, stats } = createFake({ writeDeliverables: ["memo.docx"], cutOffTurns: 1, startDelayMs: 40 });
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    expect(store.listItems(runId)[0]!.status).toBe("passed");
    expect(stats.agentPrompts).toHaveLength(2);
  });

  test("an output-length error on the message is treated as the same cut-off", async () => {
    await seedCustomTask("ct-1", 1);
    const { client, stats } = createFake({ agentError: "unused" });
    // Swap the fake's generic error for the engine's MessageOutputLengthError.
    const messages = client.session.messages;
    client.session.messages = async (params) => {
      const result = await messages(params);
      for (const entry of result.data ?? []) {
        if (entry.info?.error) entry.info.error = { name: "MessageOutputLengthError", data: {} };
      }
      return result;
    };
    const runner = makeRunner(client);
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");

    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("error");
    expect(item.error).toContain("cut off at the model's output limit");
    expect(stats.agentPrompts).toHaveLength(3);
  });

  test("follow-ups share the item's time budget instead of getting a fresh one each", async () => {
    await seedCustomTask("ct-1", 1);
    // Each turn takes 200ms against a 300ms item budget: the cut-off turn ends
    // at ~200ms, so the follow-up cannot finish in time. A fresh window per
    // prompt would let it run to ~400ms and pass.
    const { client } = createFake({ writeDeliverables: ["memo.docx"], cutOffTurns: 1, agentDelayMs: 200 });
    const runner = makeRunner(client, { itemTimeoutMs: 300 });
    const created = await runner.createRun(workspace, {
      tasks: ["ct-1"],
      models: [{ providerID: "prov", modelID: "model-a" }],
    });
    const runId = created.id as string;
    await waitFor(() => store.getRun(runId)?.status === "completed");
    const item = store.listItems(runId)[0]!;
    expect(item.status).toBe("error");
    expect(item.error).toContain("timed out");
  });
});
