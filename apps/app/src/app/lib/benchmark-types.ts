/**
 * Wire types for the benchmark API (apps/server routes/benchmarks.ts).
 * These mirror the server's serialization shapes 1:1.
 */

export type BenchmarkWorkType = "analyze" | "draft" | "review" | "research";

export const BENCHMARK_WORK_TYPES: BenchmarkWorkType[] = ["analyze", "draft", "review", "research"];

export type BenchmarkTaskSource = "harvey" | "custom";

export type BenchmarkModelRef = { providerID: string; modelID: string };

export type BenchmarkTaskRef = { source: BenchmarkTaskSource; key: string };

export type BenchmarkCriterion = {
  id: string;
  title: string;
  deliverables: string[];
  matchCriteria: string;
};

export type BenchmarkTaskDefinition = {
  title: string;
  workType: BenchmarkWorkType;
  tags: string[];
  instructions: string;
  deliverables: string[];
  criteria: BenchmarkCriterion[];
};

/** One row in the task picker: a Harvey catalog entry or a custom task. */
export type BenchmarkCatalogItem = {
  key: string;
  source: BenchmarkTaskSource;
  vertical: string;
  verticalLabel: string;
  name: string;
  docCount: number;
  hydrated: boolean;
  title?: string;
  workType?: BenchmarkWorkType;
  tags?: string[];
  criteriaCount?: number;
  deliverables?: string[];
  // custom tasks only
  id?: string;
  instructions?: string;
  criteria?: BenchmarkCriterion[];
  createdAt?: number;
  updatedAt?: number;
};

export type BenchmarkCatalogResponse = {
  ref: string;
  verticals: Array<{ id: string; label: string; count: number }>;
  items: BenchmarkCatalogItem[];
  hydration: { hydrated: number; total: number };
};

export type BenchmarkCustomTaskInput = {
  title: string;
  workType: BenchmarkWorkType;
  tags?: string[];
  instructions: string;
  deliverables?: string[];
  criteria: Array<{ id?: string; title?: string; deliverables?: string[]; matchCriteria: string }>;
  documents?: Array<{ name: string; contentBase64: string }>;
};

/** Latest result for one model on one task, from the most recent run that included both. */
export type BenchmarkTaskResult = {
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

/** A row in the workspace task table (imported Harvey task or custom task). */
export type BenchmarkTaskItem = {
  id: string;
  source: BenchmarkTaskSource;
  title: string;
  workType: BenchmarkWorkType;
  tags: string[];
  instructions: string;
  deliverables: string[];
  criteria: BenchmarkCriterion[];
  criteriaCount: number;
  docCount: number;
  catalogRef: string | null;
  createdAt: number;
  updatedAt: number;
  latestResults: BenchmarkTaskResult[];
};

export type BenchmarkImportResponse = {
  items: BenchmarkTaskItem[];
  failed: Array<{ key: string; error: string }>;
};

/** Result of importing tasks from a Zip archive (failures keyed by archive path). */
export type BenchmarkImportZipResponse = {
  items: BenchmarkTaskItem[];
  failed: Array<{ path: string; error: string }>;
};

/** A task input document staged inside the workspace for the file viewer. */
export type BenchmarkTaskDocument = {
  name: string;
  /** Workspace-relative path — readable through the regular workspace file APIs. */
  relativePath: string;
  size: number;
};

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

export type BenchmarkItemStatusCounts = Record<BenchmarkItemStatus, number>;

export type BenchmarkModelScore = {
  providerID: string;
  modelID: string;
  passed: number;
  failed: number;
  error: number;
  avgScore: number | null;
  rubricPassRate: number | null;
  criteriaPassed: number;
  criteriaTotal: number;
};

/** Cross-run model analytics (Models tab). */
export type BenchmarkAnalyticsStat = {
  rate: number | null;
  tasks: number;
  criteriaPassed: number;
  criteriaTotal: number;
};

export type BenchmarkModelAnalytics = {
  providerID: string;
  modelID: string;
  overall: BenchmarkAnalyticsStat;
  byTag: Array<{ tag: string } & BenchmarkAnalyticsStat>;
};

export type BenchmarkAnalytics = {
  models: BenchmarkModelAnalytics[];
  tags: string[];
};

export type BenchmarkRunSummary = {
  id: string;
  title: string;
  status: BenchmarkRunStatus;
  judgeModel: BenchmarkModelRef;
  models: BenchmarkModelRef[];
  concurrency: number;
  catalogRef: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  taskCount: number;
  counts: BenchmarkItemStatusCounts;
  progress: { completed: number; total: number };
  aggregateScore: number | null;
  scoreByModel: BenchmarkModelScore[];
};

export type BenchmarkRunItem = {
  id: string;
  taskSource: BenchmarkTaskSource;
  taskKey: string;
  taskTitle: string;
  workType: BenchmarkWorkType;
  vertical: string;
  tags: string[];
  providerID: string;
  modelID: string;
  status: BenchmarkItemStatus;
  score: number | null;
  nCriteria: number | null;
  nPassed: number | null;
  sessionId: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  cost: number | null;
  tokens: unknown;
};

export type BenchmarkRunDetail = {
  run: BenchmarkRunSummary;
  items: BenchmarkRunItem[];
};

export type BenchmarkRunProgress = {
  status: BenchmarkRunStatus;
  counts: BenchmarkItemStatusCounts;
  progress: { completed: number; total: number };
  updatedAt: number;
};

export type BenchmarkVerdict = {
  criterionId: string;
  criterionTitle: string;
  verdict: "pass" | "fail" | "error";
  reasoning: string;
  judgedAt: number;
};

export type BenchmarkItemDetail = {
  item: BenchmarkRunItem;
  task: BenchmarkTaskDefinition | null;
  verdicts: BenchmarkVerdict[];
  deliverables: {
    deliverables: Array<{ name: string; relativePath: string | null; size: number | null }>;
    outputFiles: string[];
  } | null;
};

export type BenchmarkRunCreateInput = {
  title?: string;
  /** Ids from the workspace task table. */
  tasks: string[];
  models: BenchmarkModelRef[];
  judgeModel?: BenchmarkModelRef;
  concurrency?: number;
};

export const DEFAULT_JUDGE_MODEL: BenchmarkModelRef = {
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
};
