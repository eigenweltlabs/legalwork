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
import {
  armIdFromLabel,
  armSchema,
  BASELINE_ARM,
  describeArmRestrictions,
  resolveToolOverrides,
  type BenchmarkArm,
} from "./ablation.js";
import {
  ensureHarveyDocuments,
  type HarveyIndexEntry,
} from "./harvey-catalog.js";
import type {
  OpenCodeClient,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionPromptInput,
  PermissionRule,
} from "@opencode/client";
import { listEngineMessages } from "../engine-client.js";
import { mkdir, writeFile } from "node:fs/promises";
import { extractDeliverableText } from "./extract-text.js";
import {
  buildAgentPrompt,
  buildJudgePrompt,
  buildJudgeSystemPrompt,
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
import {
  parseStoredTaskJson,
  type BenchmarkTaskDefinition,
} from "./task-schema.js";
import {join,relative,isAbsolute,sep} from "node:path";
import {canonicalFilePath} from "../file-write-lock.js";
import {
  itemWorkDir,
  collectDeliverables,
  prepareItemWorkDir,
  removeRunScratchDir,
} from "./workdir.js";

// The real native public client is also used by protocol fixtures. No legacy
// SDK envelope or method facade is retained at the runner boundary.
export type BenchmarkOpencodeClient = OpenCodeClient;
export type CreateBenchmarkClient = (
  workspace: WorkspaceInfo,
  directory: string,
) => OpenCodeClient;
type AssistantMessageLike = SessionMessageAssistant;

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
  /**
   * Ablation arms. Each one re-runs every task×model with a different
   * capability set, so items = tasks × models × arms. Omitted (or empty) means
   * a single baseline arm, which is what every pre-ablation run was.
   */
  arms: z.array(armSchema).min(1).max(6).optional(),
});

/**
 * Arms for a run, with ids assigned and de-duplicated. No arms means the single
 * baseline arm, so a caller that knows nothing about ablation keeps the old
 * tasks × models shape.
 */
function resolveArms(
  input:
    | Array<{ id?: string; label: string; config?: BenchmarkArm["config"] }>
    | undefined,
): BenchmarkArm[] {
  if (!input?.length) return [BASELINE_ARM];
  const taken = new Set<string>();
  return input.map((arm) => {
    const id = arm.id?.trim() || armIdFromLabel(arm.label, taken);
    taken.add(id);
    return { id, label: arm.label.trim(), config: arm.config ?? {} };
  });
}

/**
 * Whether a reply was cut off at the model's output limit. The engine reports
 * it two ways: a step that ends with `finish: "length"` and no error (what a
 * cut-off tool call looks like — the unfinished call is dropped), or a
 * MessageOutputLengthError on the message.
 */
function wasCutOffAtOutputLimit(message: AssistantMessageLike | null): boolean {
  return (
    message?.finish === "length" ||
    message?.error?.type === "MessageOutputLengthError"
  );
}

/**
 * Follow-ups sent after a cut-off reply before the item is given up on. A
 * cut-off usually means the agent tried to write a whole deliverable in one
 * tool call; asked once or twice, it will split the work.
 */

const OUTPUT_LIMIT_RECOVERY_PROMPT =
  "Your previous response was cut off because it reached the model's output token limit, so nothing from that " +
  "response was saved. Continue the task from where you left off. Write large files in several smaller steps — " +
  "for example, create the document with its first sections, then add the remaining sections in separate tool " +
  "calls — so that no single response is too long.";

// The agent session must never stall on a permission prompt in a headless run.
const ALLOW_ALL_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
];
// The judge only ever needs to read deliverables; mutating tools are switched off.
const JUDGE_TOOLS = {
  write: false,
  edit: false,
  patch: false,
  bash: false,
  shell: false,
  apply_patch: false,
};

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
  sessions: Map<
    string,
    { client: BenchmarkOpencodeClient; sessionID: string; directory: string }
  >;
};

type RunnerTimings = {
  pollIntervalMs: number;
  itemTimeoutMs: number | null;
  judgeTimeoutMs: number | null;
};

export type BenchmarkRunnerOptions = {
  config: ServerConfig;
  createClient: CreateBenchmarkClient;
  judgeConcurrency?: number;
  timings?: Partial<RunnerTimings>;
  scenario?: {
    permissionMode?: "normal" | "unattended-all-allow";
    outputLimitRecoveryAttempts?: number;
    judgeAttempts?: number;
  };
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
    return {
      providerID: raw.slice(0, separator),
      modelID: raw.slice(separator + 1),
    };
  }
  return { providerID: "deepseek", modelID: "deepseek-v4-flash" };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function textFromMessage(message: SessionMessageAssistant | null): string {
  return (
    message?.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n") ?? ""
  );
}
function tokenTotals(messages: SessionMessageInfo[]) {
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  let cost = 0;
  let reported = false;
  for (const message of messages) {
    if (message.type !== "assistant" && message.type !== "compaction") continue;
    const tokens = "tokens" in message ? message.tokens : undefined;
    if (tokens) {
      totals.input += tokens.input;
      totals.output += tokens.output;
      totals.reasoning += tokens.reasoning;
      totals.cache.read += tokens.cache.read;
      totals.cache.write += tokens.cache.write;
    }
    if ("cost" in message && message.cost !== undefined) {
      cost += message.cost;
      reported = true;
    }
  }
  return {
    tokens: totals,
    cost: reported ? cost : null,
    currency: "USD-declared-by-native-MoneyUSD",
  };
}

const TERMINAL_ITEM_STATUSES: BenchmarkItemStatus[] = [
  "passed",
  "failed",
  "error",
  "aborted",
  "interrupted",
];

export class BenchmarkRunner {
  private readonly config: ServerConfig;
  private readonly createClient: CreateBenchmarkClient;
  private readonly judgeConcurrency: number;
  private readonly timings: RunnerTimings;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly active = new Map<string, RunHandle>();
  private readonly scenario: {
    permissionMode: "normal" | "unattended-all-allow";
    outputLimitRecoveryAttempts: number;
    judgeAttempts: number;
  };
  private store!: BenchmarkStore;
  private ready: Promise<void> | null = null;

  constructor(options: BenchmarkRunnerOptions) {
    this.config = options.config;
    this.createClient = options.createClient;
    this.judgeConcurrency =
      options.judgeConcurrency ??
      envInt("LEGALWORK_BENCHMARK_JUDGE_CONCURRENCY", 2);
    this.timings = {
      pollIntervalMs:
        options.timings?.pollIntervalMs ??
        envInt("LEGALWORK_BENCHMARK_POLL_MS", 2000),
      itemTimeoutMs:
        options.timings?.itemTimeoutMs === null
          ? null
          : (options.timings?.itemTimeoutMs ??
            envInt("LEGALWORK_BENCHMARK_ITEM_TIMEOUT_MS", 20 * 60_000)),
      judgeTimeoutMs:
        options.timings?.judgeTimeoutMs === null
          ? null
          : (options.timings?.judgeTimeoutMs ??
            envInt("LEGALWORK_BENCHMARK_JUDGE_TIMEOUT_MS", 10 * 60_000)),
    };
    this.scenario = {
      permissionMode:
        options.scenario?.permissionMode ?? "unattended-all-allow",
      outputLimitRecoveryAttempts:
        options.scenario?.outputLimitRecoveryAttempts ?? 2,
      judgeAttempts: options.scenario?.judgeAttempts ?? 2,
    };
    if (
      !Number.isInteger(this.scenario.outputLimitRecoveryAttempts) ||
      this.scenario.outputLimitRecoveryAttempts < 0 ||
      !Number.isInteger(this.scenario.judgeAttempts) ||
      this.scenario.judgeAttempts < 1
    )
      throw new Error("Invalid explicit benchmark recovery/judge scenario");
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  async createRun(
    workspace: WorkspaceInfo,
    body: unknown,
  ): Promise<Record<string, unknown>> {
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
    const resolvedTasks: Array<{
      source: "harvey" | "custom";
      key: string;
      task: BenchmarkTaskDefinition;
      vertical: string;
    }> = [];
    let catalogRef: string | null = null;
    for (const taskId of uniqueTaskIds) {
      const row = this.store.getTask(workspace.id, taskId);
      if (!row) {
        throw new ApiError(
          400,
          "benchmark_task_not_found",
          `Unknown benchmark task: ${taskId}`,
        );
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
        task.tags[0] ??
        (row.source === "harvey" ? (row.id.split("/")[1] ?? "") : "Custom");
      resolvedTasks.push({ source: row.source, key: row.id, task, vertical });
    }

    const arms = resolveArms(input.arms);

    const runId = `br_${this.now().toString(36)}_${shortId().slice(0, 8)}`;
    const items: NewBenchmarkItem[] = [];
    for (const resolved of resolvedTasks) {
      for (const model of input.models) {
        for (const arm of arms) {
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
            armId: arm.id,
            armLabel: arm.label,
          });
        }
      }
    }

    this.store.createRun(
      {
        id: runId,
        workspaceId: workspace.id,
        title:
          input.title ||
          `Eval ${new Date(this.now()).toISOString().slice(0, 16).replace("T", " ")}`,
        status: "pending",
        judgeProviderId: judgeModel.providerID,
        judgeModelId: judgeModel.modelID,
        concurrency:
          input.concurrency ?? envInt("LEGALWORK_BENCHMARK_CONCURRENCY", 3),
        catalogRef,
        scenarioJson: JSON.stringify(this.limitManifest()),
        createdAt: this.now(),
      },
      input.models,
      items,
      arms,
    );

    void this.executeRun(workspace, runId).catch(() => undefined);
    return this.serializeRunSummary(this.store.getRun(runId)!);
  }

  /** Registered native tool IDs and their permission aliases for scoped ablation. */
  private async toolCatalog(client: OpenCodeClient, directory: string) {
    await client.model.list({ location: { directory } });
    const result = await client.rpc.call({
      rpcID: "legalwork.benchmarks",
      method: "tools",
      input: {},
      location: { directory },
    });
    return z
      .object({
        tools: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            permission: z.string().optional(),
          }),
        ),
      })
      .parse(result.output).tools;
  }
  async listToolIds(workspace: WorkspaceInfo): Promise<string[]> {
    return (
      await this.toolCatalog(
        this.createClient(workspace, workspace.path),
        workspace.path,
      )
    ).map((tool) => tool.id);
  }
  private async toolPermissions(
    client: OpenCodeClient,
    directory: string,
    overrides: Record<string, boolean> | undefined,
  ): Promise<PermissionRule[]> {
    const rules: PermissionRule[] =
      this.scenario.permissionMode === "unattended-all-allow"
        ? [...ALLOW_ALL_PERMISSIONS]
        : [];
    if (!overrides) return rules;
    const tools = await this.toolCatalog(client, directory);
    for (const [name, enabled] of Object.entries(overrides)) {
      const tool = tools.find((tool) => tool.id === name || tool.name === name);
      rules.push({
        action: tool?.permission ?? name,
        resource: "*",
        effect: enabled ? "allow" : "deny",
      });
    }
    return rules;
  }
  private async validateModels(
    workspace: WorkspaceInfo,
    models: BenchmarkModelRef[],
  ): Promise<void> {
    const available = (
      await this.createClient(workspace, workspace.path).model.list({
        location: { directory: workspace.path },
      })
    ).data;
    const missing = models.filter(
      (model) =>
        !available.some(
          (entry) =>
            entry.providerID === model.providerID && entry.id === model.modelID,
        ),
    );
    if (missing.length)
      throw new ApiError(
        400,
        "benchmark_model_unavailable",
        `Model(s) not available on this workspace: ${missing.map((model) => `${model.providerID}/${model.modelID}`).join(", ")}`,
      );
  }
  private async evidence(workDir: string, name: string, value: unknown) {
    const directory = join(workDir, ".benchmark-evidence");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(directory, name),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  private limitManifest() {
    return {
      protocol: "native-v2",
      ...this.scenario,
      ...this.timings,
      outputCaps: false,
      extractionCaps: false,
      judgeMode:
        "JSON-text-with-schema-validation; native public session prompt has no forced structured output",
      notes: [
        "Server benchmark unattended permissions/recovery are explicit scenario behavior; this is not the real Electron migration regression driver.",
        "Watchdogs, when set, fail the item and retain full partial evidence. null means no task deadline.",
        "Engine history cost is declared USD; gateway actual currency and all auxiliary requests require the transparent provider capture.",
      ],
    };
  }

  private async executeRun(
    workspace: WorkspaceInfo,
    runId: string,
  ): Promise<void> {
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
        items.map((item) =>
          this.processItem({
            workspace,
            run,
            item,
            handle,
            agentSemaphore,
            judgeSemaphore,
          }),
        ),
      );
      this.store.updateRun(runId, {
        status: handle.abortRequested ? "aborted" : "completed",
        finishedAt: this.now(),
      });
    } catch (error) {
      this.store.updateRun(runId, {
        status: "failed",
        error: errorMessage(error),
        finishedAt: this.now(),
      });
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
      this.store.updateItem(item.id, {
        status: "error",
        error: "corrupt task snapshot",
        finishedAt: this.now(),
      });
      return;
    }

    const releaseAgent = await input.agentSemaphore.acquire();
    let workDir: string;
    let deliverables: JudgeDeliverable[];
    try {
      if (handle.abortRequested) {
        this.store.updateItem(item.id, {
          status: "aborted",
          finishedAt: this.now(),
        });
        return;
      }
      this.store.updateItem(item.id, {
        status: "preparing",
        startedAt: this.now(),
      });

      const documentsDir = await this.resolveDocumentsDir(workspace, item);
      workDir = await prepareItemWorkDir({
        workspacePath: workspace.path,
        runId: run.id,
        itemId: item.id,
        documentsDir,
      });
      this.store.updateItem(item.id, { workDir });

      const client = this.createClient(workspace, workDir);
      await client.model.list({ location: { directory: workDir } });
      const armConfig =
        this.store.listRunArms(run.id).find((arm) => arm.id === item.armId)
          ?.config ?? {};
      const toolOverrides = resolveToolOverrides(armConfig);
      const permissions = await this.toolPermissions(
        client,
        workDir,
        toolOverrides,
      );
      await this.evidence(workDir, "scenario.json", {
        ...this.limitManifest(),
        permissions,
        armConfig,
      });
      const session = await client.session.create({
        location: { directory: workDir },
        title: `Benchmark: ${task.title} (${item.providerId}/${item.modelId})`,
        model: { providerID: item.providerId, id: item.modelId },
        permissions,
        metadata: {
          legalworkBenchmark: {
            runId: run.id,
            itemId: item.id,
            scenario: this.limitManifest(),
          },
        },
      });
      const sessionID = session.id;
      this.store.updateItem(item.id, {
        sessionId: sessionID,
        status: "running",
      });
      handle.sessions.set(item.id, { client, sessionID, directory: workDir });

      // The restriction note is appended to the task prompt, NOT sent as
      // `system`: on this endpoint `system` REPLACES the agent's system prompt,
      // which would strip the normal harness instructions along with it.
      const restrictions = describeArmRestrictions(armConfig);
      const promptText = restrictions
        ? `${buildAgentPrompt(task)}\n\n${restrictions}`
        : buildAgentPrompt(task);
      const promptParams = (text: string): SessionPromptInput => ({
        sessionID,
        text,
        resume: true,
      });
      const deadline =
        this.timings.itemTimeoutMs === null
          ? null
          : this.now() + this.timings.itemTimeoutMs;
      let assistant = await this.runAgentPrompt({
        client,
        sessionID,
        directory: workDir,
        handle,
        deadline,
        params: promptParams(promptText),
      });
      // A reply cut off at the output limit loses whatever it was writing —
      // typically the whole deliverable in one tool call — and the session just
      // ends. Ask the agent to carry on in smaller steps before giving up.
      for (
        let attempt = 0;
        attempt < this.scenario.outputLimitRecoveryAttempts &&
        wasCutOffAtOutputLimit(assistant);
        attempt += 1
      ) {
        assistant = await this.runAgentPrompt({
          client,
          sessionID,
          directory: workDir,
          handle,
          deadline,
          afterMessageId: assistant?.id,
          params: promptParams(OUTPUT_LIMIT_RECOVERY_PROMPT),
        });
      }
      handle.sessions.delete(item.id);

      const cutOff = wasCutOffAtOutputLimit(assistant);
      if (assistant?.error && !cutOff) {
        const message =
          assistant.error.message ||
          assistant.error.type ||
          "agent session failed";
        throw new Error(message);
      }
      const history = await listEngineMessages(client, sessionID);
      const usage = tokenTotals(history);
      await this.evidence(workDir, "agent-history.json", {
        session: await client.session.get({ sessionID }),
        messages: history,
        usage,
      });
      this.store.updateItem(item.id, {
        cost: usage.cost,
        tokensJson: JSON.stringify(usage.tokens),
      });

      const collected = await collectDeliverables(workDir, task.deliverables);
      this.store.updateItem(item.id, {
        deliverablesFound: JSON.stringify(collected),
      });
      // Still cut off and nothing written: the run failed on a limit, not on the
      // task. Judging it would score a missing file 0% and put a harness failure
      // on the leaderboard as if it were the model's answer. A deliverable that
      // did get written is complete (a tool call runs whole or not at all), so
      // that case is judged normally.
      if (
        cutOff &&
        !collected.deliverables.some((deliverable) => deliverable.relativePath)
      ) {
        throw new Error(
          await this.outputLimitFailureMessage(client, workDir, item),
        );
      }
      // Extract deliverable text once per item so each judge call is a single
      // completion instead of a tool-reading loop (which times out slow models).
      deliverables = await Promise.all(
        collected.deliverables.map(async (deliverable) => ({
          ...deliverable,
          text: deliverable.relativePath
            ? await extractDeliverableText(
                join(workDir, deliverable.relativePath),
              )
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
      const verdicts = await this.judgeItem({
        workspace,
        run,
        item,
        task,
        workDir,
        deliverables,
        handle,
      });
      const { score, nCriteria, nPassed } = scoreVerdicts(verdicts);
      // A wall of judge errors is a broken pipeline (e.g. the judge provider
      // rejecting every call), not a graded failure — surface it as such.
      if (
        nCriteria > 0 &&
        verdicts.every((verdict) => verdict.verdict === "error")
      ) {
        const reason =
          this.store.listVerdicts(item.id)[0]?.reasoning ??
          "unknown judge error";
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
      this.store.updateItem(itemId, {
        status: "aborted",
        finishedAt: this.now(),
      });
    } else {
      this.store.updateItem(itemId, {
        status: "error",
        error: errorMessage(error),
        finishedAt: this.now(),
      });
    }
  }

  /** Input documents come from the task row: uploaded dir for custom tasks, pinned download for Harvey. */
  private async resolveDocumentsDir(
    workspace: WorkspaceInfo,
    item: BenchmarkItemRow,
  ): Promise<string | null> {
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

  /** Native admission is durable; an idle snapshot alone is not completion. */
  private async runAgentPrompt(input: {
    client: OpenCodeClient;
    sessionID: string;
    directory: string;
    handle: RunHandle;
    params: SessionPromptInput;
    afterMessageId?: string;
    deadline: number | null;
    traceLabel?: string;
  }): Promise<SessionMessageAssistant | null> {
    const { client, sessionID, handle } = input;
    const admitted = await client.session.prompt(input.params);
    await this.evidence(input.directory, `admission-${admitted.id}.json`, {
      request: input.params,
      receipt: admitted,
    });
    for (;;) {
      if (handle.abortRequested) {
        await client.session.interrupt({ sessionID }).catch(() => undefined);
        throw new BenchmarkAbortError();
      }
      if (input.deadline !== null && this.now() > input.deadline) {
        await client.session.interrupt({ sessionID }).catch(() => undefined);
        throw new BenchmarkTimeoutError("agent session timed out");
      }
      const [active, inbox, history] = await Promise.all([
        client.session.active(),
        client.session.inbox.list({ sessionID }),
        listEngineMessages(client, sessionID),
      ]);
      await this.evidence(
        input.directory,
        `${input.traceLabel ?? "agent"}-history.json`,
        {
          messages: history,
          active: active[sessionID] ?? null,
          inbox,
          usage: tokenTotals(history),
        },
      );
      const assistant = history
        .filter(
          (message): message is SessionMessageAssistant =>
            message.type === "assistant",
        )
        .at(-1);
      if (
        !active[sessionID] &&
        inbox.length === 0 &&
        assistant &&
        assistant.id !== input.afterMessageId &&
        (assistant.time.completed !== undefined || assistant.error)
      )
        return assistant;
      await this.sleep(this.timings.pollIntervalMs);
    }
  }
  private async outputLimitFailureMessage(
    client: OpenCodeClient,
    directory: string,
    item: BenchmarkItemRow,
  ): Promise<string> {
    const model = (
      await client.model.list({ location: { directory } })
    ).data.find(
      (model) =>
        model.providerID === item.providerId && model.id === item.modelId,
    );
    const size = model?.limit.output
      ? ` (${model.limit.output.toLocaleString("en-US")} tokens)`
      : "";
    return `The agent's response was cut off at the model's output limit${size} before it wrote the deliverable, even after being asked ${this.scenario.outputLimitRecoveryAttempts}× to continue in smaller steps. This is a limit on a single response, not a judgement of the answer, so the item was not scored.`;
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
    const client = this.createClient(input.workspace, workDir);
    const prompt = [
      buildJudgeSystemPrompt(),
      buildJudgePrompt({ task, deliverables: input.deliverables }),
      "Return exactly the JSON verdicts object, one unique entry per criterion.",
    ].join("\n\n");
    let decisions: Map<string, JudgeDecision> | null = null;
    let failureReason = "";
    let judgeSessionId: string | null = null;
    for (
      let attempt = 0;
      attempt < this.scenario.judgeAttempts && !decisions;
      attempt++
    ) {
      if (handle.abortRequested) throw new BenchmarkAbortError();
      const session = await client.session.create({
        location: { directory: workDir },
        title: `Benchmark judge: ${item.taskTitle}`,
        model: { providerID: run.judgeProviderId, id: run.judgeModelId },
        permissions: await this.toolPermissions(client, workDir, JUDGE_TOOLS),
        metadata: {
          legalworkBenchmarkJudge: {
            itemId: item.id,
            attempt,
            mode: "JSON-text-schema-validated",
            scenario: this.limitManifest(),
          },
        },
      });
      judgeSessionId = session.id;
      handle.sessions.set(`judge:${item.id}`, {
        client,
        sessionID: session.id,
        directory: workDir,
      });
      try {
        const assistant = await this.runAgentPrompt({
          client,
          sessionID: session.id,
          directory: workDir,
          handle,
          params: { sessionID: session.id, text: prompt, resume: true },
          traceLabel: `judge-${attempt}`,
          deadline:
            this.timings.judgeTimeoutMs === null
              ? null
              : this.now() + this.timings.judgeTimeoutMs,
        });
        if (assistant?.error) throw new Error(assistant.error.message);
        decisions = parseJudgeVerdictsFromText(
          textFromMessage(assistant),
          task.criteria.map((criterion) => criterion.id),
        );
        if (
          !decisions ||
          decisions.size !== task.criteria.length ||
          task.criteria.some((criterion) => !decisions?.has(criterion.id))
        )
          throw new Error(
            "Judge response must include exactly one verdict per known criterion",
          );
      } catch (error) {
        if (error instanceof BenchmarkAbortError) throw error;
        failureReason = errorMessage(error);
        decisions = null;
      } finally {
        const history = await listEngineMessages(client, session.id).catch(
          () => null,
        );
        await this.evidence(workDir, `judge-${attempt}.json`, {
          session,
          request: { text: prompt },
          messages: history,
          usage: history ? tokenTotals(history) : null,
          failure: failureReason || null,
        });
        handle.sessions.delete(`judge:${item.id}`);
        // Retain native judge sessions and complete evidence for diagnosis.
      }
    }

    const verdicts: Array<{ verdict: "pass" | "fail" | "error" }> = [];
    for (const criterion of task.criteria) {
      const decision = decisions?.get(criterion.id) ?? null;
      const verdict = decision?.verdict ?? "error";
      const reasoning =
        decision?.reasoning ??
        (decisions
          ? "judge omitted this criterion from its verdicts"
          : failureReason);
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

  // ---- queries & control -----------------------------------------------------

  private async requireRun(
    workspaceId: string,
    runId: string,
  ): Promise<BenchmarkRunRow> {
    await this.ensureReady();
    const run = runId ? this.store.getRun(runId) : null;
    if (!run || run.workspaceId !== workspaceId) {
      throw new ApiError(
        404,
        "benchmark_run_not_found",
        "Benchmark run not found",
      );
    }
    return run;
  }

  async listRuns(
    workspace: WorkspaceInfo,
    options?: { limit?: number; start?: number },
  ): Promise<Array<Record<string, unknown>>> {
    await this.ensureReady();
    return this.store
      .listRuns(workspace.id, {
        limit: options?.limit ?? 50,
        start: options?.start,
      })
      .map((run) => this.serializeRunSummary(run));
  }

  async getRunDetail(
    workspace: WorkspaceInfo,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const items = this.store
      .listItems(run.id)
      .map((item) => this.serializeItem(item));
    return { run: this.serializeRunSummary(run), items };
  }

  async getRunProgress(
    workspace: WorkspaceInfo,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const counts = this.store.countItemsByStatus(run.id);
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const completed = TERMINAL_ITEM_STATUSES.reduce(
      (sum, status) => sum + counts[status],
      0,
    );
    return {
      status: run.status,
      counts,
      progress: { completed, total },
      updatedAt: this.now(),
    };
  }

  /** Dedicated benchmark access never broadens ordinary project session scope. */
  async getItemSessionIdentity(workspace:WorkspaceInfo,runId:string,itemId:string):Promise<{sessionID:string;workDir:string}>{
    const run=await this.requireRun(workspace.id,runId);const item=this.store.getItem(itemId);
    if(!item || item.runId!==run.id || !item.sessionId || !item.workDir)throw new ApiError(404,"benchmark_session_not_found","This benchmark item has no agent transcript.");
    const [root,stored,expected]=await Promise.all([canonicalFilePath(workspace.path),canonicalFilePath(item.workDir),canonicalFilePath(itemWorkDir(workspace.path,run.id,item.id))]);
    const local=relative(root,stored);
    if(!local || isAbsolute(local) || local===".." || local.startsWith(`..${sep}`) || stored!==expected)throw new ApiError(404,"benchmark_session_not_found","This benchmark transcript does not belong to the item.");
    return {sessionID:item.sessionId,workDir:item.workDir};
  }

  async getItemDetail(
    workspace: WorkspaceInfo,
    runId: string,
    itemId: string,
  ): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    const item = itemId ? this.store.getItem(itemId) : null;
    if (!item || item.runId !== run.id) {
      throw new ApiError(
        404,
        "benchmark_item_not_found",
        "Benchmark run item not found",
      );
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

  async abortRun(
    workspace: WorkspaceInfo,
    runId: string,
  ): Promise<Record<string, unknown>> {
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
          .interrupt({ sessionID: session.sessionID })
          .catch(() => undefined);
      }
    } else {
      // Not active in this process (should only happen around restarts): finalize directly.
      for (const item of this.store.listItemsByStatus(run.id, [
        "pending",
        "preparing",
        "running",
        "judging",
      ])) {
        this.store.updateItem(item.id, {
          status: "aborted",
          finishedAt: this.now(),
        });
      }
      this.store.updateRun(run.id, {
        status: "aborted",
        finishedAt: this.now(),
      });
    }
    return this.serializeRunSummary(this.store.getRun(run.id)!);
  }

  async resumeRun(
    workspace: WorkspaceInfo,
    runId: string,
  ): Promise<Record<string, unknown>> {
    const run = await this.requireRun(workspace.id, runId);
    if (!["interrupted", "aborted", "failed"].includes(run.status)) {
      throw new ApiError(
        409,
        "benchmark_run_active",
        "Only interrupted, aborted or failed runs can be resumed",
      );
    }
    if (
      run.scenarioJson &&
      run.scenarioJson !== JSON.stringify(this.limitManifest())
    )
      throw new ApiError(
        409,
        "benchmark_scenario_changed",
        "This run used different benchmark scenario settings. Restore those settings or create a separate comparison run.",
      );
    const requeue = this.store.listItemsByStatus(run.id, [
      "pending",
      "interrupted",
      "aborted",
      "error",
    ]);
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
    this.store.updateRun(run.id, {
      status: "pending",
      error: null,
      finishedAt: null,
    });
    void this.executeRun(workspace, run.id).catch(() => undefined);
    return this.serializeRunSummary(this.store.getRun(run.id)!);
  }

  async deleteRun(workspace: WorkspaceInfo, runId: string): Promise<void> {
    const run = await this.requireRun(workspace.id, runId);
    if (
      this.active.has(run.id) ||
      ["pending", "running", "aborting"].includes(run.status)
    ) {
      throw new ApiError(
        409,
        "benchmark_run_active",
        "Abort the run before deleting it",
      );
    }
    this.store.deleteRun(run.id);
    await removeRunScratchDir(workspace.path, run.id);
  }

  // ---- serialization ---------------------------------------------------------

  serializeRunSummary(run: BenchmarkRunRow): Record<string, unknown> {
    /** Mean rubric pass rate: average of nPassed/nCriteria over judged items. */
    function meanRubricPassRate(list: BenchmarkItemRow[]): number | null {
      const judged = list.filter(
        (item) =>
          item.nCriteria !== null &&
          item.nCriteria > 0 &&
          item.nPassed !== null,
      );
      if (!judged.length) return null;
      return (
        judged.reduce((sum, item) => sum + item.nPassed! / item.nCriteria!, 0) /
        judged.length
      );
    }
    const items = this.store.listItems(run.id);
    const models = this.store.runModels(run.id);
    const counts = this.store.countItemsByStatus(run.id);
    const total = items.length;
    const completed = items.filter((item) =>
      TERMINAL_ITEM_STATUSES.includes(item.status),
    ).length;
    const taskCount = new Set(items.map((item) => item.taskKey)).size;

    const scoreByModel = models.map((model) => {
      const modelItems = items.filter(
        (item) =>
          item.providerId === model.providerID &&
          item.modelId === model.modelID,
      );
      const scored = modelItems.filter((item) => item.score !== null);
      return {
        providerID: model.providerID,
        modelID: model.modelID,
        passed: modelItems.filter((item) => item.status === "passed").length,
        failed: modelItems.filter((item) => item.status === "failed").length,
        error: modelItems.filter((item) => item.status === "error").length,
        avgScore: scored.length
          ? scored.reduce((sum, item) => sum + (item.score ?? 0), 0) /
            scored.length
          : null,
        rubricPassRate: meanRubricPassRate(modelItems),
        criteriaPassed: modelItems.reduce(
          (sum, item) => sum + (item.nPassed ?? 0),
          0,
        ),
        criteriaTotal: modelItems.reduce(
          (sum, item) => sum + (item.nCriteria ?? 0),
          0,
        ),
      };
    });
    const allScored = items.filter((item) => item.score !== null);

    return {
      scenario: run.scenarioJson
        ? JSON.parse(run.scenarioJson)
        : {
            recorded: false,
            limitations: [
              "Legacy run predates scenario evidence; resumed mixed-version items are not a comparable native baseline.",
            ],
          },
      id: run.id,
      title: run.title,
      status: run.status,
      judgeModel: {
        providerID: run.judgeProviderId,
        modelID: run.judgeModelId,
      },
      models,
      arms: this.store
        .listRunArms(run.id)
        .map((arm) => ({ id: arm.id, label: arm.label, config: arm.config })),
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
      armId: item.armId,
      armLabel: item.armLabel,
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
