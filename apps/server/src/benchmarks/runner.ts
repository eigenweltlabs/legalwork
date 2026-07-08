/**
 * BenchmarkRunner — server-side background execution of benchmark runs.
 *
 * A run expands to task×model items. Items run through the standard opencode
 * harness (session per item in its own scratch dir) under a bounded agent
 * semaphore; each item's deliverables are judged criterion-by-criterion on a
 * separate judge semaphore as soon as its agent session finishes, while other
 * agent sessions are still running (piped judging). Every state transition is
 * persisted synchronously, so run status survives server restarts; on boot,
 * orphaned in-flight work is marked `interrupted` and can be resumed explicitly.
 */
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { z } from "zod";
import { ensureHarveyDocuments, type HarveyIndexEntry } from "./harvey-catalog.js";
import { extractDeliverableText } from "./extract-text.js";
import {
  buildAgentPrompt,
  buildJudgePrompt,
  buildJudgeSystemPrompt,
  JUDGE_BATCH_RESPONSE_SCHEMA,
  parseJudgeVerdicts,
  parseJudgeVerdictsFromText,
  scoreVerdicts,
  type JudgeDecision,
  type JudgeDeliverable,
} from "./judge.js";
import {
  openBenchmarkStore,
  type BenchmarkItemRow,
  type BenchmarkItemStatus,
  type BenchmarkModelRef,
  type BenchmarkRunRow,
  type BenchmarkStore,
  type NewBenchmarkItem,
} from "./store.js";
import { parseStoredTaskJson, type BenchmarkTaskDefinition } from "./task-schema.js";
import { join } from "node:path";
import { collectDeliverables, prepareItemWorkDir, removeRunScratchDir } from "./workdir.js";

// ---- opencode client surface (structural, so tests can inject fakes) --------

type SdkResult<T> = { data?: T; error?: unknown; response?: Response };

type AssistantMessageLike = {
  id?: string;
  role?: string;
  error?: { name?: string; data?: { message?: string } };
  cost?: number;
  tokens?: unknown;
  structured?: unknown;
};

type MessageEntryLike = { info?: AssistantMessageLike; parts?: Array<{ type?: string; text?: string }> };

export type BenchmarkOpencodeClient = {
  session: {
    create(params: Record<string, unknown>): Promise<SdkResult<{ id: string }>>;
    prompt(params: Record<string, unknown>): Promise<SdkResult<{ info: AssistantMessageLike; parts?: unknown[] }>>;
    promptAsync(params: Record<string, unknown>): Promise<SdkResult<unknown>>;
    status(params?: Record<string, unknown>): Promise<SdkResult<Record<string, { type?: string } | undefined>>>;
    messages(params: Record<string, unknown>): Promise<SdkResult<MessageEntryLike[]>>;
    abort(params: Record<string, unknown>): Promise<SdkResult<unknown>>;
    delete(params: Record<string, unknown>): Promise<SdkResult<unknown>>;
  };
  provider: {
    list(params?: Record<string, unknown>): Promise<
      SdkResult<{ all: Array<{ id: string; models: Record<string, unknown> }> }>
    >;
  };
};

export type CreateBenchmarkClient = (workspace: WorkspaceInfo, directory: string) => BenchmarkOpencodeClient;

// ---- input validation --------------------------------------------------------

const modelRefSchema = z.object({
  providerID: z.string().trim().min(1),
  modelID: z.string().trim().min(1),
});

const runInputSchema = z.object({
  title: z.string().trim().max(200).optional(),
  tasks: z.array(z.string().trim().min(1)).min(1).max(500),
  models: z.array(modelRefSchema).min(1).max(10),
  judgeModel: modelRefSchema.optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
});

// The agent session must never stall on a permission prompt in a headless run.
const ALLOW_ALL_PERMISSIONS = [{ permission: "*", pattern: "*", action: "allow" as const }];
// The judge only ever needs to read deliverables; mutating tools are switched off.
const JUDGE_TOOLS = { write: false, edit: false, patch: false, bash: false };

class BenchmarkAbortError extends Error {
  constructor() {
    super("benchmark item aborted");
  }
}

class BenchmarkTimeoutError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class Semaphore {
  private queue: Array<() => void> = [];
  private available: number;

  constructor(slots: number) {
    this.available = Math.max(1, slots);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next();
      } else {
        this.available += 1;
      }
    };
  }
}

type RunHandle = {
  abortRequested: boolean;
  sessions: Map<string, { client: BenchmarkOpencodeClient; sessionID: string; directory: string }>;
};

type RunnerTimings = {
  pollIntervalMs: number;
  itemTimeoutMs: number;
  judgeTimeoutMs: number;
};

export type BenchmarkRunnerOptions = {
  config: ServerConfig;
  createClient: CreateBenchmarkClient;
  judgeConcurrency?: number;
  timings?: Partial<RunnerTimings>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultJudgeModel(): BenchmarkModelRef {
  const raw = process.env.LEGALWORK_BENCHMARK_JUDGE_MODEL?.trim();
  if (raw && raw.includes("/")) {
    const separator = raw.indexOf("/");
    return { providerID: raw.slice(0, separator), modelID: raw.slice(separator + 1) };
  }
  return { providerID: "deepseek", modelID: "deepseek-v4-flash" };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function textFromParts(parts: Array<{ type?: string; text?: string }> | undefined): string {
  if (!parts) return "";
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

const TERMINAL_ITEM_STATUSES: BenchmarkItemStatus[] = ["passed", "failed", "error", "aborted", "interrupted"];

export class BenchmarkRunner {
  private readonly config: ServerConfig;
  private readonly createClient: CreateBenchmarkClient;
  private readonly judgeConcurrency: number;
  private readonly timings: RunnerTimings;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly active = new Map<string, RunHandle>();
  /**
   * Judge models whose provider rejects opencode's forced-tool-choice
   * structured output (e.g. DeepSeek thinking mode). Once a model lands here,
   * all further judge calls go straight to plain-JSON text mode instead of
   * burning one doomed structured attempt per criterion.
   */
  private readonly judgeTextOnlyModels = new Set<string>();
  private store!: BenchmarkStore;
  private ready: Promise<void> | null = null;

  constructor(options: BenchmarkRunnerOptions) {
    this.config = options.config;
    this.createClient = options.createClient;
    this.judgeConcurrency = options.judgeConcurrency ?? envInt("LEGALWORK_BENCHMARK_JUDGE_CONCURRENCY", 2);
    this.timings = {
      pollIntervalMs: options.timings?.pollIntervalMs ?? envInt("LEGALWORK_BENCHMARK_POLL_MS", 2000),
      itemTimeoutMs: options.timings?.itemTimeoutMs ?? envInt("LEGALWORK_BENCHMARK_ITEM_TIMEOUT_MS", 20 * 60_000),
      judgeTimeoutMs: options.timings?.judgeTimeoutMs ?? envInt("LEGALWORK_BENCHMARK_JUDGE_TIMEOUT_MS", 10 * 60_000),
    };
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Open the store and mark orphaned in-flight work from a previous process. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = openBenchmarkStore(this.config).then((store) => {
        this.store = store;
        store.recoverInterrupted(this.now());
      });
    }
    return this.ready;
  }

  dispose(): void {
    for (const handle of this.active.values()) {
      handle.abortRequested = true;
    }
  }

  // ---- run lifecycle ---------------------------------------------------------

  async createRun(workspace: WorkspaceInfo, body: unknown): Promise<Record<string, unknown>> {
    await this.ensureReady();
    if (workspace.workspaceType !== "local") {
      throw new ApiError(
        400,
        "benchmark_unsupported_workspace",
        "Benchmarks need a local workspace: the server stages task documents on disk",
      );
    }
    const parsed = runInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "invalid_payload", z.prettifyError(parsed.error));
    }
    const input = parsed.data;
    const judgeModel = input.judgeModel ?? defaultJudgeModel();

    await this.validateModels(workspace, [...input.models, judgeModel]);

    // Every task must already live in the workspace's task table (imported
    // from the Legal Agent Benchmark or created there) — runs never fetch
    // task definitions from the network.
    const uniqueTaskIds = Array.from(new Set(input.tasks));
    const resolvedTasks: Array<{ source: "harvey" | "custom"; key: string; task: BenchmarkTaskDefinition; vertical: string }> = [];
    let catalogRef: string | null = null;
    for (const taskId of uniqueTaskIds) {
      const row = this.store.getTask(workspace.id, taskId);
      if (!row) {
        throw new ApiError(400, "benchmark_task_not_found", `Unknown benchmark task: ${taskId}`);
      }
      const task: BenchmarkTaskDefinition = {
        title: row.title,
        workType: row.workType,
        tags: JSON.parse(row.tagsJson),
        instructions: row.instructions,
        deliverables: JSON.parse(row.deliverablesJson),
        criteria: JSON.parse(row.criteriaJson),
      };
      catalogRef = catalogRef ?? row.catalogRef;
      const vertical =
        task.tags[0] ?? (row.source === "harvey" ? row.id.split("/")[1] ?? "" : "Custom");
      resolvedTasks.push({ source: row.source, key: row.id, task, vertical });
    }

    const runId = `br_${this.now().toString(36)}_${shortId().slice(0, 8)}`;
    const items: NewBenchmarkItem[] = [];
    for (const resolved of resolvedTasks) {
      for (const model of input.models) {
        items.push({
          id: `bri_${shortId().slice(0, 12)}`,
          taskSource: resolved.source,
          taskKey: resolved.key,
          taskTitle: resolved.task.title,
          workType: resolved.task.workType,
          vertical: resolved.vertical,
          taskJson: JSON.stringify(resolved.task),
          providerId: model.providerID,
          modelId: model.modelID,
        });
      }
    }

    this.store.createRun(
      {
        id: runId,
        workspaceId: workspace.id,
        title: input.title || `Benchmark ${new Date(this.now()).toISOString().slice(0, 16).replace("T", " ")}`,
        status: "pending",
        judgeProviderId: judgeModel.providerID,
        judgeModelId: judgeModel.modelID,
        concurrency: input.concurrency ?? envInt("LEGALWORK_BENCHMARK_CONCURRENCY", 3),
        catalogRef,
        createdAt: this.now(),
      },
      input.models,
      items,
    );

    void this.executeRun(workspace, runId).catch(() => undefined);
    return this.serializeRunSummary(this.store.getRun(runId)!);
  }

  private async validateModels(workspace: WorkspaceInfo, models: BenchmarkModelRef[]): Promise<void> {
    const client = this.createClient(workspace, workspace.path);
    const result = await client.provider.list({ directory: workspace.path });
    const providers = result.data?.all;
    if (!providers) {
      throw new ApiError(502, "opencode_request_failed", "Could not list providers to validate benchmark models");
    }
    const missing = models.filter((model) => {
      const provider = providers.find((entry) => entry.id === model.providerID);
      return !provider || !(model.modelID in provider.models);
    });
    if (missing.length) {
      throw new ApiError(
        400,
        "benchmark_model_unavailable",
        `Model(s) not available on this workspace: ${missing.map((model) => `${model.providerID}/${model.modelID}`).join(", ")}`,
      );
    }
  }

  private async executeRun(workspace: WorkspaceInfo, runId: string): Promise<void> {
    const handle: RunHandle = { abortRequested: false, sessions: new Map() };
    this.active.set(runId, handle);
    try {
      this.store.updateRun(runId, { status: "running", startedAt: this.now() });
      const run = this.store.getRun(runId);
      if (!run) return;
      const items = this.store.listItemsByStatus(runId, ["pending"]);

      const agentSemaphore = new Semaphore(run.concurrency);
      const judgeSemaphore = new Semaphore(this.judgeConcurrency);
      await Promise.all(
        items.map((item) => this.processItem({ workspace, run, item, handle, agentSemaphore, judgeSemaphore })),
      );
      this.store.updateRun(runId, {
        status: handle.abortRequested ? "aborted" : "completed",
        finishedAt: this.now(),
      });
    } catch (error) {
      this.store.updateRun(runId, { status: "failed", error: errorMessage(error), finishedAt: this.now() });
    } finally {
      this.active.delete(runId);
    }
  }

  private async processItem(input: {
    workspace: WorkspaceInfo;
    run: BenchmarkRunRow;
    item: BenchmarkItemRow;
    handle: RunHandle;
    agentSemaphore: Semaphore;
    judgeSemaphore: Semaphore;
  }): Promise<void> {
    const { workspace, run, item, handle } = input;
    const task = parseStoredTaskJson(item.taskJson);
    if (!task) {
      this.store.updateItem(item.id, { status: "error", error: "corrupt task snapshot", finishedAt: this.now() });
      return;
    }

    const releaseAgent = await input.agentSemaphore.acquire();
    let workDir: string;
    let deliverables: JudgeDeliverable[];
    try {
      if (handle.abortRequested) {
        this.store.updateItem(item.id, { status: "aborted", finishedAt: this.now() });
        return;
      }
      this.store.updateItem(item.id, { status: "preparing", startedAt: this.now() });

      const documentsDir = await this.resolveDocumentsDir(workspace, item);
      workDir = await prepareItemWorkDir({
        workspacePath: workspace.path,
        runId: run.id,
        itemId: item.id,
        documentsDir,
      });
      this.store.updateItem(item.id, { workDir });

      const client = this.createClient(workspace, workDir);
      const session = await client.session.create({
        directory: workDir,
        title: `Benchmark: ${task.title} (${item.providerId}/${item.modelId})`,
        permission: ALLOW_ALL_PERMISSIONS,
      });
      const sessionID = session.data?.id;
      if (!sessionID) {
        throw new Error(`could not create benchmark session: ${errorMessage(session.error ?? "empty response")}`);
      }
      this.store.updateItem(item.id, { sessionId: sessionID, status: "running" });
      handle.sessions.set(item.id, { client, sessionID, directory: workDir });

      const assistant = await this.runAgentPrompt({
        client,
        sessionID,
        directory: workDir,
        handle,
        params: {
          sessionID,
          directory: workDir,
          model: { providerID: item.providerId, modelID: item.modelId },
          parts: [{ type: "text", text: buildAgentPrompt(task) }],
        },
      });
      handle.sessions.delete(item.id);

      if (assistant?.error) {
        const message = assistant.error.data?.message || assistant.error.name || "agent session failed";
        throw new Error(message);
      }
      this.store.updateItem(item.id, {
        cost: typeof assistant?.cost === "number" ? assistant.cost : null,
        tokensJson: assistant?.tokens ? JSON.stringify(assistant.tokens) : null,
      });

      const collected = await collectDeliverables(workDir, task.deliverables);
      this.store.updateItem(item.id, { deliverablesFound: JSON.stringify(collected) });
      // Extract deliverable text once per item so each judge call is a single
      // completion instead of a tool-reading loop (which times out slow models).
      deliverables = await Promise.all(
        collected.deliverables.map(async (deliverable) => ({
          ...deliverable,
          text: deliverable.relativePath
            ? await extractDeliverableText(join(workDir, deliverable.relativePath))
            : null,
        })),
      );
    } catch (error) {
      handle.sessions.delete(item.id);
      this.finalizeItemFailure(item.id, error);
      return;
    } finally {
      releaseAgent();
    }

    // Judging runs on its own semaphore so the agent slot frees up immediately.
    const releaseJudge = await input.judgeSemaphore.acquire();
    try {
      if (handle.abortRequested) throw new BenchmarkAbortError();
      this.store.updateItem(item.id, { status: "judging" });
      const verdicts = await this.judgeItem({ workspace, run, item, task, workDir, deliverables, handle });
      const { score, nCriteria, nPassed } = scoreVerdicts(verdicts);
      // A wall of judge errors is a broken pipeline (e.g. the judge provider
      // rejecting every call), not a graded failure — surface it as such.
      if (nCriteria > 0 && verdicts.every((verdict) => verdict.verdict === "error")) {
        const reason = this.store.listVerdicts(item.id)[0]?.reasoning ?? "unknown judge error";
        this.store.updateItem(item.id, {
          status: "error",
          error: `judging failed for every criterion: ${reason}`,
          score: null,
          nCriteria,
          nPassed,
          finishedAt: this.now(),
        });
        return;
      }
      this.store.updateItem(item.id, {
        status: score === 1 ? "passed" : "failed",
        score,
        nCriteria,
        nPassed,
        finishedAt: this.now(),
      });
    } catch (error) {
      this.finalizeItemFailure(item.id, error);
    } finally {
      releaseJudge();
    }
  }

  private finalizeItemFailure(itemId: string, error: unknown): void {
    if (error instanceof BenchmarkAbortError) {
      this.store.updateItem(itemId, { status: "aborted", finishedAt: this.now() });
    } else {
      this.store.updateItem(itemId, { status: "error", error: errorMessage(error), finishedAt: this.now() });
    }
  }

  /** Input documents come from the task row: uploaded dir for custom tasks, pinned download for Harvey. */
  private async resolveDocumentsDir(workspace: WorkspaceInfo, item: BenchmarkItemRow): Promise<string | null> {
    const row = this.store.getTask(workspace.id, item.taskKey);
    if (!row) return null;
    if (row.source === "custom") return row.documentsDir;
    if (!row.catalogRef) return null;
    let documents: string[] = [];
    try {
      documents = JSON.parse(row.harveyDocumentsJson ?? "[]");
    } catch {
      documents = [];
    }
    const entry: HarveyIndexEntry = {
      key: row.id,
      vertical: row.id.split("/")[1] ?? "",
      name: row.id.split("/")[2] ?? row.id,
      documents,
    };
    return ensureHarveyDocuments(this.config, row.catalogRef, entry);
  }

  /** promptAsync + status polling; falls back to a synchronous prompt when the engine lacks prompt_async. */
  private async runAgentPrompt(input: {
    client: BenchmarkOpencodeClient;
    sessionID: string;
    directory: string;
    handle: RunHandle;
    params: Record<string, unknown>;
  }): Promise<AssistantMessageLike | null> {
    const { client, sessionID, directory, handle } = input;
    let started: SdkResult<unknown>;
    try {
      started = await client.session.promptAsync(input.params);
    } catch (error) {
      started = { error };
    }

    if (started.error !== undefined) {
      const result = await this.withTimeout(
        client.session.prompt(input.params),
        this.timings.itemTimeoutMs,
        () => void client.session.abort({ sessionID, directory }).catch(() => undefined),
        "agent session timed out",
      );
      return result.data?.info ?? null;
    }

    const startedAt = this.now();
    for (;;) {
      await this.sleep(this.timings.pollIntervalMs);
      if (handle.abortRequested) {
        await client.session.abort({ sessionID, directory }).catch(() => undefined);
        throw new BenchmarkAbortError();
      }
      if (this.now() - startedAt > this.timings.itemTimeoutMs) {
        await client.session.abort({ sessionID, directory }).catch(() => undefined);
        throw new BenchmarkTimeoutError("agent session timed out");
      }
      const status = await client.session.status({ directory });
      const state = status.data?.[sessionID]?.type ?? "idle";
      if (state !== "idle") continue;
      const assistant = await this.lastAssistantMessage(client, sessionID, directory);
      if (assistant) return assistant;
      // promptAsync accepted but the engine has not started responding yet
    }
  }

  private async lastAssistantMessage(
    client: BenchmarkOpencodeClient,
    sessionID: string,
    directory: string,
  ): Promise<AssistantMessageLike | null> {
    return (await this.lastAssistantEntry(client, sessionID, directory))?.info ?? null;
  }

  private async lastAssistantEntry(
    client: BenchmarkOpencodeClient,
    sessionID: string,
    directory: string,
  ): Promise<MessageEntryLike | null> {
    const result = await client.session.messages({ sessionID, directory });
    const entries = result.data ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.info?.role === "assistant") return entry;
    }
    return null;
  }

  private async judgeItem(input: {
    workspace: WorkspaceInfo;
    run: BenchmarkRunRow;
    item: BenchmarkItemRow;
    task: BenchmarkTaskDefinition;
    workDir: string;
    deliverables: JudgeDeliverable[];
    handle: RunHandle;
  }): Promise<Array<{ verdict: "pass" | "fail" | "error" }>> {
    const { run, item, task, workDir, handle } = input;
    const judgeModel = { providerID: run.judgeProviderId, modelID: run.judgeModelId };
    const judgeModelKey = `${judgeModel.providerID}/${judgeModel.modelID}`;
    const client = this.createClient(input.workspace, workDir);
    const prompt = buildJudgePrompt({ task, deliverables: input.deliverables });

    // Batched judging: ONE session per task×model item. The judge gets the
    // deliverable content once plus every criterion and answers with a single
    // JSON array of independent verdicts.
    //
    // Attempt 0 uses opencode's structured output — implemented engine-side as
    // a StructuredOutput tool with toolChoice "required", which some providers
    // reject (DeepSeek thinking mode: "does not support this tool_choice").
    // Attempt 1 retries with a plain JSON-in-text prompt and lenient parsing.
    // A rejecting model is remembered so later items skip attempt 0 entirely.
    let decisions: Map<string, JudgeDecision> | null = null;
    let failureReason = "";
    let judgeSessionId: string | null = null;
    for (let attempt = 0; attempt < 2 && !decisions; attempt += 1) {
      if (handle.abortRequested) throw new BenchmarkAbortError();
      const useStructuredOutput = attempt === 0 && !this.judgeTextOnlyModels.has(judgeModelKey);
      try {
        const session = await client.session.create({
          directory: workDir,
          title: `Benchmark judge: ${item.taskTitle}`,
          permission: ALLOW_ALL_PERMISSIONS,
        });
        const sessionID = session.data?.id;
        if (!sessionID) throw new Error(errorMessage(session.error ?? "could not create judge session"));
        judgeSessionId = sessionID;
        const result = await this.withTimeout(
          client.session.prompt({
            sessionID,
            directory: workDir,
            model: judgeModel,
            system: buildJudgeSystemPrompt(),
            tools: JUDGE_TOOLS,
            ...(useStructuredOutput
              ? {
                  format: {
                    type: "json_schema",
                    schema: JUDGE_BATCH_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
                    retryCount: 2,
                  },
                }
              : {}),
            parts: [
              {
                type: "text",
                text: useStructuredOutput
                  ? prompt
                  : `${prompt}\n\nEnd your reply with ONLY the JSON verdicts object: {"verdicts": [{"id": "...", "verdict": "pass" | "fail", "reasoning": "..."}]}`,
              },
            ],
          }),
          this.timings.judgeTimeoutMs,
          () => void client.session.abort({ sessionID, directory: workDir }).catch(() => undefined),
          "judge call timed out",
        );
        void client.session.delete({ sessionID, directory: workDir }).catch(() => undefined);
        const info = result.data?.info;
        if (info?.error) throw new Error(info.error.data?.message || info.error.name || "judge session failed");
        decisions =
          parseJudgeVerdicts(info?.structured) ??
          parseJudgeVerdictsFromText(
            textFromParts((result.data?.parts as Array<{ type?: string; text?: string }>) ?? undefined),
          );
        if (!decisions) throw new Error("judge returned no parseable verdicts");
      } catch (error) {
        if (error instanceof BenchmarkAbortError) throw error;
        failureReason = errorMessage(error);
        // A timed-out or dropped HTTP response does not mean the engine failed:
        // the verdicts may already sit in the session. Try to recover them
        // before burning the retry.
        if (judgeSessionId && error instanceof BenchmarkTimeoutError) {
          const entry = await this.lastAssistantEntry(client, judgeSessionId, workDir).catch(() => null);
          decisions =
            parseJudgeVerdicts(entry?.info?.structured) ??
            parseJudgeVerdictsFromText(textFromParts(entry?.parts));
          if (decisions) continue;
        }
        if (useStructuredOutput && /tool_choice|structured|json_schema|response_format/i.test(failureReason)) {
          this.judgeTextOnlyModels.add(judgeModelKey);
        }
      }
    }

    const verdicts: Array<{ verdict: "pass" | "fail" | "error" }> = [];
    for (const criterion of task.criteria) {
      const decision = decisions?.get(criterion.id) ?? null;
      const verdict = decision?.verdict ?? "error";
      const reasoning =
        decision?.reasoning ?? (decisions ? "judge omitted this criterion from its verdicts" : failureReason);
      this.store.upsertVerdict({
        itemId: item.id,
        criterionId: criterion.id,
        criterionTitle: criterion.title,
        verdict,
        reasoning,
        judgeSessionId,
        judgedAt: this.now(),
      });
      verdicts.push({ verdict });
    }
    return verdicts;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
    message: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new BenchmarkTimeoutError(message));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ---- queries & control -----------------------------------------------------

  private async requireRun(workspaceId: string, runId: string): Promise<BenchmarkRunRow> {
    await this.ensureReady();
    const run = runId ? this.store.getRun(runId) : null;
    if (!run || run.workspaceId !== workspaceId) {
      throw new ApiError(404, "benchmark_run_not_found", "Benchmark run not found");
    }
    return run;
  }

  async listRuns(
    workspace: WorkspaceInfo,
    options?: { limit?: number; start?: number },
  ): Promise<Array<Record<string, unknown>>> {
    await this.ensureReady();
    return this.store
      .listRuns(workspace.id, { limit: options?.limit ?? 50, start: options?.start })
      .map((run) => this.serializeRunSummary(run));
  }

  async getRunDetail(workspace: WorkspaceInfo, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const items = this.store.listItems(run.id).map((item) => this.serializeItem(item));
    return { run: this.serializeRunSummary(run), items };
  }

  async getRunProgress(workspace: WorkspaceInfo, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const counts = this.store.countItemsByStatus(run.id);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const completed = TERMINAL_ITEM_STATUSES.reduce((sum, status) => sum + counts[status], 0);
    return { status: run.status, counts, progress: { completed, total }, updatedAt: this.now() };
  }

  async getItemDetail(workspace: WorkspaceInfo, runId: string, itemId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const item = itemId ? this.store.getItem(itemId) : null;
    if (!item || item.runId !== run.id) {
      throw new ApiError(404, "benchmark_item_not_found", "Benchmark run item not found");
    }
    const verdicts = this.store.listVerdicts(item.id).map((verdict) => ({
      criterionId: verdict.criterionId,
      criterionTitle: verdict.criterionTitle,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
      judgedAt: verdict.judgedAt,
    }));
    const task = parseStoredTaskJson(item.taskJson);
    let deliverables: unknown = null;
    if (item.deliverablesFound) {
      try {
        deliverables = JSON.parse(item.deliverablesFound);
      } catch {
        deliverables = null;
      }
    }
    return { item: this.serializeItem(item), task, verdicts, deliverables };
  }

  async abortRun(workspace: WorkspaceInfo, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    if (!["pending", "running", "aborting"].includes(run.status)) {
      return this.serializeRunSummary(run);
    }
    const handle = this.active.get(run.id);
    this.store.updateRun(run.id, { status: "aborting" });
    if (handle) {
      handle.abortRequested = true;
      for (const session of handle.sessions.values()) {
        void session.client.session
          .abort({ sessionID: session.sessionID, directory: session.directory })
          .catch(() => undefined);
      }
    } else {
      // Not active in this process (should only happen around restarts): finalize directly.
      for (const item of this.store.listItemsByStatus(run.id, ["pending", "preparing", "running", "judging"])) {
        this.store.updateItem(item.id, { status: "aborted", finishedAt: this.now() });
      }
      this.store.updateRun(run.id, { status: "aborted", finishedAt: this.now() });
    }
    return this.serializeRunSummary(this.store.getRun(run.id)!);
  }

  async resumeRun(workspace: WorkspaceInfo, runId: string): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    if (!["interrupted", "aborted", "failed"].includes(run.status)) {
      throw new ApiError(409, "benchmark_run_active", "Only interrupted, aborted or failed runs can be resumed");
    }
    const requeue = this.store.listItemsByStatus(run.id, ["pending", "interrupted", "aborted", "error"]);
    for (const item of requeue) {
      this.store.deleteVerdictsForItem(item.id);
      this.store.updateItem(item.id, {
        status: "pending",
        sessionId: null,
        workDir: null,
        score: null,
        nCriteria: null,
        nPassed: null,
        deliverablesFound: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        cost: null,
        tokensJson: null,
      });
    }
    this.store.updateRun(run.id, { status: "pending", error: null, finishedAt: null });
    void this.executeRun(workspace, run.id).catch(() => undefined);
    return this.serializeRunSummary(this.store.getRun(run.id)!);
  }

  async deleteRun(workspace: WorkspaceInfo, runId: string): Promise<void> {
    const run = await this.requireRun(workspace.id, runId);
    if (this.active.has(run.id) || ["pending", "running", "aborting"].includes(run.status)) {
      throw new ApiError(409, "benchmark_run_active", "Abort the run before deleting it");
    }
    this.store.deleteRun(run.id);
    await removeRunScratchDir(workspace.path, run.id);
  }

  // ---- serialization ---------------------------------------------------------

  serializeRunSummary(run: BenchmarkRunRow): Record<string, unknown> {
    /** Mean rubric pass rate: average of nPassed/nCriteria over judged items. */
    function meanRubricPassRate(list: BenchmarkItemRow[]): number | null {
      const judged = list.filter((item) => item.nCriteria !== null && item.nCriteria > 0 && item.nPassed !== null);
      if (!judged.length) return null;
      return judged.reduce((sum, item) => sum + item.nPassed! / item.nCriteria!, 0) / judged.length;
    }
    const items = this.store.listItems(run.id);
    const models = this.store.runModels(run.id);
    const counts = this.store.countItemsByStatus(run.id);
    const total = items.length;
    const completed = items.filter((item) => TERMINAL_ITEM_STATUSES.includes(item.status)).length;
    const taskCount = new Set(items.map((item) => item.taskKey)).size;

    const scoreByModel = models.map((model) => {
      const modelItems = items.filter(
        (item) => item.providerId === model.providerID && item.modelId === model.modelID,
      );
      const scored = modelItems.filter((item) => item.score !== null);
      return {
        providerID: model.providerID,
        modelID: model.modelID,
        passed: modelItems.filter((item) => item.status === "passed").length,
        failed: modelItems.filter((item) => item.status === "failed").length,
        error: modelItems.filter((item) => item.status === "error").length,
        avgScore: scored.length
          ? scored.reduce((sum, item) => sum + (item.score ?? 0), 0) / scored.length
          : null,
        rubricPassRate: meanRubricPassRate(modelItems),
        criteriaPassed: modelItems.reduce((sum, item) => sum + (item.nPassed ?? 0), 0),
        criteriaTotal: modelItems.reduce((sum, item) => sum + (item.nCriteria ?? 0), 0),
      };
    });
    const allScored = items.filter((item) => item.score !== null);

    return {
      id: run.id,
      title: run.title,
      status: run.status,
      judgeModel: { providerID: run.judgeProviderId, modelID: run.judgeModelId },
      models,
      concurrency: run.concurrency,
      catalogRef: run.catalogRef,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error: run.error,
      taskCount,
      counts,
      progress: { completed, total },
      aggregateScore: meanRubricPassRate(items),
      scoreByModel,
    };
  }

  private serializeItem(item: BenchmarkItemRow): Record<string, unknown> {
    let tokens: unknown = null;
    if (item.tokensJson) {
      try {
        tokens = JSON.parse(item.tokensJson);
      } catch {
        tokens = null;
      }
    }
    return {
      id: item.id,
      taskSource: item.taskSource,
      taskKey: item.taskKey,
      taskTitle: item.taskTitle,
      workType: item.workType,
      vertical: item.vertical,
      tags: parseStoredTaskJson(item.taskJson)?.tags ?? [],
      providerID: item.providerId,
      modelID: item.modelId,
      status: item.status,
      score: item.score,
      nCriteria: item.nCriteria,
      nPassed: item.nPassed,
      sessionId: item.sessionId,
      error: item.error,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      cost: item.cost,
      tokens,
    };
  }
}
