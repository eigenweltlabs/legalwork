import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerConfig } from "../types.js";
import { ensureDir } from "../utils.js";
import type { AnalyticsRow } from "./analytics.js";
import { parseStoredTaskJson, type BenchmarkTaskSource, type BenchmarkWorkType } from "./task-schema.js";

export type BenchmarkRunStatus =
  | "pending"
  | "running"
  | "aborting"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export type BenchmarkItemStatus =
  | "pending"
  | "preparing"
  | "running"
  | "judging"
  | "passed"
  | "failed"
  | "error"
  | "aborted"
  | "interrupted";

export type BenchmarkVerdict = "pass" | "fail" | "error";

export type BenchmarkModelRef = { providerID: string; modelID: string };

export type BenchmarkRunRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: BenchmarkRunStatus;
  judgeProviderId: string;
  judgeModelId: string;
  concurrency: number;
  catalogRef: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

export type BenchmarkItemRow = {
  id: string;
  runId: string;
  taskSource: BenchmarkTaskSource;
  taskKey: string;
  taskTitle: string;
  workType: BenchmarkWorkType;
  vertical: string;
  taskJson: string;
  providerId: string;
  modelId: string;
  status: BenchmarkItemStatus;
  sessionId: string | null;
  workDir: string | null;
  score: number | null;
  nCriteria: number | null;
  nPassed: number | null;
  deliverablesFound: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  cost: number | null;
  tokensJson: string | null;
};

export type NewBenchmarkItem = Pick<
  BenchmarkItemRow,
  "id" | "taskSource" | "taskKey" | "taskTitle" | "workType" | "vertical" | "taskJson" | "providerId" | "modelId"
>;

export type BenchmarkVerdictRow = {
  itemId: string;
  criterionId: string;
  criterionTitle: string;
  verdict: BenchmarkVerdict;
  reasoning: string;
  judgeSessionId: string | null;
  judgedAt: number;
};

export type BenchmarkTaskRow = {
  workspaceId: string;
  id: string;
  source: BenchmarkTaskSource;
  title: string;
  workType: BenchmarkWorkType;
  tagsJson: string;
  instructions: string;
  deliverablesJson: string;
  criteriaJson: string;
  harveyDocumentsJson: string | null;
  catalogRef: string | null;
  documentsDir: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Latest run item per (task, provider, model) — powers the task-table result columns. */
export type BenchmarkLatestResultRow = {
  taskKey: string;
  providerID: string;
  modelID: string;
  status: BenchmarkItemStatus;
  score: number | null;
  nCriteria: number | null;
  nPassed: number | null;
  itemId: string;
  runId: string;
  runCreatedAt: number;
  finishedAt: number | null;
};

export type BenchmarkItemPatch = Partial<
  Pick<
    BenchmarkItemRow,
    | "status"
    | "sessionId"
    | "workDir"
    | "score"
    | "nCriteria"
    | "nPassed"
    | "deliverablesFound"
    | "error"
    | "startedAt"
    | "finishedAt"
    | "cost"
    | "tokensJson"
  >
>;

export type BenchmarkRunPatch = Partial<
  Pick<BenchmarkRunRow, "status" | "startedAt" | "finishedAt" | "error" | "title">
>;

type Statement = {
  run: (...params: unknown[]) => void;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteHandle = {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => void;
  close: () => void;
};

const DDL = `
CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  judge_provider_id TEXT NOT NULL,
  judge_model_id TEXT NOT NULL,
  concurrency INTEGER NOT NULL DEFAULT 3,
  catalog_ref TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_workspace ON benchmark_runs(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS benchmark_run_models (
  run_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  PRIMARY KEY (run_id, provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS benchmark_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_source TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_title TEXT NOT NULL,
  work_type TEXT NOT NULL,
  vertical TEXT NOT NULL,
  task_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  work_dir TEXT,
  score REAL,
  n_criteria INTEGER,
  n_passed INTEGER,
  deliverables_found TEXT,
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  cost REAL,
  tokens_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_benchmark_run_items_run ON benchmark_run_items(run_id);
CREATE TABLE IF NOT EXISTS benchmark_criterion_verdicts (
  item_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  criterion_title TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  judge_session_id TEXT,
  judged_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS benchmark_tasks (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,               -- harvey catalog key or ct_<id> for custom tasks
  source TEXT NOT NULL,           -- 'harvey' | 'custom'
  title TEXT NOT NULL,
  work_type TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  instructions TEXT NOT NULL,
  deliverables_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  harvey_documents_json TEXT,     -- relative document paths from the catalog index (harvey)
  catalog_ref TEXT,               -- pinned commit sha the task/documents came from (harvey)
  documents_dir TEXT,             -- uploaded documents directory (custom)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_tasks_workspace ON benchmark_tasks(workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS benchmark_catalog_head (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  ref TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_catalog_cache (
  ref TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  index_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS benchmark_task_cache (
  ref TEXT NOT NULL,
  task_key TEXT NOT NULL,
  task_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (ref, task_key)
);
`;

const RUN_COLUMNS = `id, workspace_id AS workspaceId, title, status,
  judge_provider_id AS judgeProviderId, judge_model_id AS judgeModelId,
  concurrency, catalog_ref AS catalogRef, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, error`;

const ITEM_COLUMNS = `id, run_id AS runId, task_source AS taskSource, task_key AS taskKey,
  task_title AS taskTitle, work_type AS workType, vertical, task_json AS taskJson,
  provider_id AS providerId, model_id AS modelId, status, session_id AS sessionId,
  work_dir AS workDir, score, n_criteria AS nCriteria, n_passed AS nPassed,
  deliverables_found AS deliverablesFound, error, started_at AS startedAt,
  finished_at AS finishedAt, cost, tokens_json AS tokensJson`;

const TASK_COLUMNS = `workspace_id AS workspaceId, id, source, title, work_type AS workType,
  tags_json AS tagsJson, instructions, deliverables_json AS deliverablesJson,
  criteria_json AS criteriaJson, harvey_documents_json AS harveyDocumentsJson,
  catalog_ref AS catalogRef, documents_dir AS documentsDir,
  created_at AS createdAt, updated_at AS updatedAt`;

const ITEM_PATCH_COLUMNS: Record<keyof Required<BenchmarkItemPatch>, string> = {
  status: "status",
  sessionId: "session_id",
  workDir: "work_dir",
  score: "score",
  nCriteria: "n_criteria",
  nPassed: "n_passed",
  deliverablesFound: "deliverables_found",
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
  cost: "cost",
  tokensJson: "tokens_json",
};

const RUN_PATCH_COLUMNS: Record<keyof Required<BenchmarkRunPatch>, string> = {
  status: "status",
  startedAt: "started_at",
  finishedAt: "finished_at",
  error: "error",
  title: "title",
};

export function benchmarksDbPath(config: Pick<ServerConfig, "configPath">): string {
  const override = process.env.LEGALWORK_BENCHMARKS_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "benchmarks.sqlite");
}

async function openSqlite(path: string): Promise<SqliteHandle> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    return {
      prepare: (sql) => db.prepare(sql) as unknown as Statement,
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  return {
    prepare: (sql) => db.prepare(sql) as unknown as Statement,
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

export class BenchmarkStore {
  private constructor(private readonly db: SqliteHandle) {}

  static async open(path: string): Promise<BenchmarkStore> {
    const db = await openSqlite(path);
    db.exec(DDL);
    return new BenchmarkStore(db);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(
    run: Omit<BenchmarkRunRow, "startedAt" | "finishedAt" | "error">,
    models: BenchmarkModelRef[],
    items: NewBenchmarkItem[],
  ): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO benchmark_runs (id, workspace_id, title, status, judge_provider_id, judge_model_id, concurrency, catalog_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.workspaceId,
          run.title,
          run.status,
          run.judgeProviderId,
          run.judgeModelId,
          run.concurrency,
          run.catalogRef,
          run.createdAt,
        );
      const insertModel = this.db.prepare(
        "INSERT INTO benchmark_run_models (run_id, provider_id, model_id) VALUES (?, ?, ?)",
      );
      for (const model of models) {
        insertModel.run(run.id, model.providerID, model.modelID);
      }
      const insertItem = this.db.prepare(
        `INSERT INTO benchmark_run_items (id, run_id, task_source, task_key, task_title, work_type, vertical, task_json, provider_id, model_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      );
      for (const item of items) {
        insertItem.run(
          item.id,
          run.id,
          item.taskSource,
          item.taskKey,
          item.taskTitle,
          item.workType,
          item.vertical,
          item.taskJson,
          item.providerId,
          item.modelId,
        );
      }
    });
  }

  getRun(runId: string): BenchmarkRunRow | null {
    const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE id = ?`).get(runId);
    return (row as BenchmarkRunRow | undefined) ?? null;
  }

  listRuns(workspaceId: string, options?: { limit?: number; start?: number }): BenchmarkRunRow[] {
    const limit = options?.limit ?? 100;
    const start = options?.start ?? 0;
    return this.db
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(workspaceId, limit, start) as BenchmarkRunRow[];
  }

  listRunsByStatus(statuses: BenchmarkRunStatus[]): BenchmarkRunRow[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM benchmark_runs WHERE status IN (${placeholders})`)
      .all(...statuses) as BenchmarkRunRow[];
  }

  updateRun(runId: string, patch: BenchmarkRunPatch): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const setters = entries
      .map(([key]) => `${RUN_PATCH_COLUMNS[key as keyof BenchmarkRunPatch]} = ?`)
      .join(", ");
    this.db
      .prepare(`UPDATE benchmark_runs SET ${setters} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), runId);
  }

  deleteRun(runId: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM benchmark_criterion_verdicts WHERE item_id IN (SELECT id FROM benchmark_run_items WHERE run_id = ?)",
        )
        .run(runId);
      this.db.prepare("DELETE FROM benchmark_run_items WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM benchmark_run_models WHERE run_id = ?").run(runId);
      this.db.prepare("DELETE FROM benchmark_runs WHERE id = ?").run(runId);
    });
  }

  runModels(runId: string): BenchmarkModelRef[] {
    return this.db
      .prepare(
        "SELECT provider_id AS providerID, model_id AS modelID FROM benchmark_run_models WHERE run_id = ? ORDER BY provider_id, model_id",
      )
      .all(runId) as BenchmarkModelRef[];
  }

  listItems(runId: string): BenchmarkItemRow[] {
    return this.db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM benchmark_run_items WHERE run_id = ? ORDER BY task_key, provider_id, model_id`)
      .all(runId) as BenchmarkItemRow[];
  }

  listItemsByStatus(runId: string, statuses: BenchmarkItemStatus[]): BenchmarkItemRow[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT ${ITEM_COLUMNS} FROM benchmark_run_items WHERE run_id = ? AND status IN (${placeholders}) ORDER BY task_key, provider_id, model_id`,
      )
      .all(runId, ...statuses) as BenchmarkItemRow[];
  }

  getItem(itemId: string): BenchmarkItemRow | null {
    const row = this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM benchmark_run_items WHERE id = ?`).get(itemId);
    return (row as BenchmarkItemRow | undefined) ?? null;
  }

  updateItem(itemId: string, patch: BenchmarkItemPatch): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const setters = entries
      .map(([key]) => `${ITEM_PATCH_COLUMNS[key as keyof BenchmarkItemPatch]} = ?`)
      .join(", ");
    this.db
      .prepare(`UPDATE benchmark_run_items SET ${setters} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), itemId);
  }

  countItemsByStatus(runId: string): Record<BenchmarkItemStatus, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM benchmark_run_items WHERE run_id = ? GROUP BY status")
      .all(runId) as Array<{ status: BenchmarkItemStatus; count: number }>;
    const counts: Record<BenchmarkItemStatus, number> = {
      pending: 0,
      preparing: 0,
      running: 0,
      judging: 0,
      passed: 0,
      failed: 0,
      error: 0,
      aborted: 0,
      interrupted: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  upsertVerdict(verdict: BenchmarkVerdictRow): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_criterion_verdicts (item_id, criterion_id, criterion_title, verdict, reasoning, judge_session_id, judged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, criterion_id) DO UPDATE SET
           criterion_title = excluded.criterion_title,
           verdict = excluded.verdict,
           reasoning = excluded.reasoning,
           judge_session_id = excluded.judge_session_id,
           judged_at = excluded.judged_at`,
      )
      .run(
        verdict.itemId,
        verdict.criterionId,
        verdict.criterionTitle,
        verdict.verdict,
        verdict.reasoning,
        verdict.judgeSessionId,
        verdict.judgedAt,
      );
  }

  listVerdicts(itemId: string): BenchmarkVerdictRow[] {
    return this.db
      .prepare(
        `SELECT item_id AS itemId, criterion_id AS criterionId, criterion_title AS criterionTitle,
                verdict, reasoning, judge_session_id AS judgeSessionId, judged_at AS judgedAt
         FROM benchmark_criterion_verdicts WHERE item_id = ? ORDER BY criterion_id`,
      )
      .all(itemId) as BenchmarkVerdictRow[];
  }

  deleteVerdictsForItem(itemId: string): void {
    this.db.prepare("DELETE FROM benchmark_criterion_verdicts WHERE item_id = ?").run(itemId);
  }

  upsertTask(row: BenchmarkTaskRow): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_tasks (workspace_id, id, source, title, work_type, tags_json, instructions, deliverables_json, criteria_json, harvey_documents_json, catalog_ref, documents_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           source = excluded.source,
           title = excluded.title,
           work_type = excluded.work_type,
           tags_json = excluded.tags_json,
           instructions = excluded.instructions,
           deliverables_json = excluded.deliverables_json,
           criteria_json = excluded.criteria_json,
           harvey_documents_json = excluded.harvey_documents_json,
           catalog_ref = excluded.catalog_ref,
           documents_dir = excluded.documents_dir,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.workspaceId,
        row.id,
        row.source,
        row.title,
        row.workType,
        row.tagsJson,
        row.instructions,
        row.deliverablesJson,
        row.criteriaJson,
        row.harveyDocumentsJson,
        row.catalogRef,
        row.documentsDir,
        row.createdAt,
        row.updatedAt,
      );
  }

  getTask(workspaceId: string, taskId: string): BenchmarkTaskRow | null {
    const row = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM benchmark_tasks WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, taskId);
    return (row as BenchmarkTaskRow | undefined) ?? null;
  }

  listTasks(workspaceId: string): BenchmarkTaskRow[] {
    return this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM benchmark_tasks WHERE workspace_id = ? ORDER BY created_at DESC, id`)
      .all(workspaceId) as BenchmarkTaskRow[];
  }

  deleteTask(workspaceId: string, taskId: string): void {
    this.db.prepare("DELETE FROM benchmark_tasks WHERE workspace_id = ? AND id = ?").run(workspaceId, taskId);
  }

  /**
   * For every (task, provider, model) with any history in this workspace,
   * return the item from the most recently created run.
   */
  latestResults(workspaceId: string): BenchmarkLatestResultRow[] {
    return this.db
      .prepare(
        `SELECT i.task_key AS taskKey, i.provider_id AS providerID, i.model_id AS modelID,
                i.status, i.score, i.n_criteria AS nCriteria, i.n_passed AS nPassed,
                i.id AS itemId, i.run_id AS runId, r.created_at AS runCreatedAt, i.finished_at AS finishedAt
         FROM benchmark_run_items i
         JOIN benchmark_runs r ON r.id = i.run_id
         WHERE r.workspace_id = ?
           AND r.created_at = (
             SELECT MAX(r2.created_at)
             FROM benchmark_run_items i2
             JOIN benchmark_runs r2 ON r2.id = i2.run_id
             WHERE r2.workspace_id = r.workspace_id
               AND i2.task_key = i.task_key
               AND i2.provider_id = i.provider_id
               AND i2.model_id = i.model_id
           )
         ORDER BY i.task_key, i.provider_id, i.model_id`,
      )
      .all(workspaceId) as BenchmarkLatestResultRow[];
  }

  /** Latest judged result per (task, provider, model) with its vertical + tags — powers cross-run analytics. */
  modelAnalyticsRows(workspaceId: string): AnalyticsRow[] {
    const rows = this.db
      .prepare(
        `SELECT i.task_key AS taskKey, i.provider_id AS providerID, i.model_id AS modelID,
                i.vertical AS vertical, i.n_criteria AS nCriteria, i.n_passed AS nPassed, i.task_json AS taskJson
         FROM benchmark_run_items i
         JOIN benchmark_runs r ON r.id = i.run_id
         WHERE r.workspace_id = ?
           AND r.created_at = (
             SELECT MAX(r2.created_at)
             FROM benchmark_run_items i2
             JOIN benchmark_runs r2 ON r2.id = i2.run_id
             WHERE r2.workspace_id = r.workspace_id
               AND i2.task_key = i.task_key
               AND i2.provider_id = i.provider_id
               AND i2.model_id = i.model_id
           )`,
      )
      .all(workspaceId) as Array<Omit<AnalyticsRow, "tags"> & { taskJson: string }>;
    return rows.map(({ taskJson, ...row }) => ({
      ...row,
      tags: parseStoredTaskJson(taskJson)?.tags ?? [],
    }));
  }

  getCatalogHead(): { ref: string; fetchedAt: number } | null {
    const row = this.db
      .prepare("SELECT ref, fetched_at AS fetchedAt FROM benchmark_catalog_head WHERE slot = 1")
      .get();
    return (row as { ref: string; fetchedAt: number } | undefined) ?? null;
  }

  setCatalogHead(ref: string, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_catalog_head (slot, ref, fetched_at) VALUES (1, ?, ?)
         ON CONFLICT(slot) DO UPDATE SET ref = excluded.ref, fetched_at = excluded.fetched_at`,
      )
      .run(ref, fetchedAt);
  }

  getCatalogIndex(ref: string): string | null {
    const row = this.db.prepare("SELECT index_json AS indexJson FROM benchmark_catalog_cache WHERE ref = ?").get(ref);
    return (row as { indexJson: string } | undefined)?.indexJson ?? null;
  }

  setCatalogIndex(ref: string, indexJson: string, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_catalog_cache (ref, fetched_at, index_json) VALUES (?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET fetched_at = excluded.fetched_at, index_json = excluded.index_json`,
      )
      .run(ref, fetchedAt, indexJson);
  }

  getCachedTask(ref: string, taskKey: string): string | null {
    const row = this.db
      .prepare("SELECT task_json AS taskJson FROM benchmark_task_cache WHERE ref = ? AND task_key = ?")
      .get(ref, taskKey);
    return (row as { taskJson: string } | undefined)?.taskJson ?? null;
  }

  setCachedTask(ref: string, taskKey: string, taskJson: string, fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO benchmark_task_cache (ref, task_key, task_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ref, task_key) DO UPDATE SET task_json = excluded.task_json, fetched_at = excluded.fetched_at`,
      )
      .run(ref, taskKey, taskJson, fetchedAt);
  }

  listCachedTasks(ref: string): Array<{ taskKey: string; taskJson: string }> {
    return this.db
      .prepare("SELECT task_key AS taskKey, task_json AS taskJson FROM benchmark_task_cache WHERE ref = ?")
      .all(ref) as Array<{ taskKey: string; taskJson: string }>;
  }

  countCachedTasks(ref: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM benchmark_task_cache WHERE ref = ?").get(ref);
    return (row as { count: number } | undefined)?.count ?? 0;
  }

  /** Mark orphaned in-flight work as interrupted. Called once on server boot. */
  recoverInterrupted(now: number): { runs: number; items: number } {
    return this.transaction(() => {
      const activeRuns = this.listRunsByStatus(["pending", "running", "aborting"]);
      let items = 0;
      for (const run of activeRuns) {
        const inFlight = this.listItemsByStatus(run.id, ["pending", "preparing", "running", "judging"]);
        for (const item of inFlight) {
          this.updateItem(item.id, { status: "interrupted", finishedAt: now });
          items += 1;
        }
        this.updateRun(run.id, { status: "interrupted", finishedAt: now });
      }
      return { runs: activeRuns.length, items };
    });
  }
}

const storeByPath = new Map<string, Promise<BenchmarkStore>>();

export async function openBenchmarkStore(config: Pick<ServerConfig, "configPath">): Promise<BenchmarkStore> {
  const path = benchmarksDbPath(config);
  const existing = storeByPath.get(path);
  if (existing) return existing;
  const store = BenchmarkStore.open(path);
  storeByPath.set(path, store);
  return store;
}

/** Test hook: drop the memoized handle so a fresh DB file can be opened. */
export function resetBenchmarkStoreCache(): void {
  storeByPath.clear();
}
