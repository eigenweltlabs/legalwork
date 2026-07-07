import { t } from "../../../i18n";
import type {
  BenchmarkItemStatus,
  BenchmarkRunItem,
  BenchmarkRunStatus,
  BenchmarkRunSummary,
} from "../../../app/lib/benchmark-types";

export const ACTIVE_RUN_STATUSES: BenchmarkRunStatus[] = ["pending", "running", "aborting"];

export function isRunActive(status: BenchmarkRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

export const ACTIVE_ITEM_STATUSES: BenchmarkItemStatus[] = ["pending", "preparing", "running", "judging"];

export function isItemActive(status: BenchmarkItemStatus): boolean {
  return ACTIVE_ITEM_STATUSES.includes(status);
}

export function formatScorePercent(score: number | null): string {
  if (score === null || Number.isNaN(score)) return "—";
  return `${Math.round(score * 100)}%`;
}

/** "72% (36/50)" — percentage first, pass counts in parentheses. */
export function criteriaScoreLabel(nPassed: number, nCriteria: number): string {
  const pct = Math.round((nPassed / Math.max(nCriteria, 1)) * 100);
  return `${pct}% (${nPassed}/${nCriteria})`;
}

/** Traffic-light tone by pass fraction: ≥80% green, ≥50% yellow, below red. */
export function criteriaScoreToneClass(nPassed: number, nCriteria: number): string {
  const fraction = nPassed / Math.max(nCriteria, 1);
  if (fraction >= 0.8) return "text-green-11";
  if (fraction >= 0.5) return "text-amber-11";
  return "text-red-11";
}

/** "3/4" style pass-count for a single task×model cell. */
export function formatCellScore(item: BenchmarkRunItem): string {
  if (item.nCriteria === null || item.nPassed === null) return "—";
  return `${item.nPassed}/${item.nCriteria}`;
}

export function runStatusLabel(status: BenchmarkRunStatus): string {
  switch (status) {
    case "pending":
      return t("benchmark.status_pending");
    case "running":
      return t("benchmark.status_running");
    case "aborting":
      return t("benchmark.status_aborting");
    case "completed":
      return t("benchmark.status_completed");
    case "failed":
      return t("benchmark.status_failed");
    case "aborted":
      return t("benchmark.status_aborted");
    case "interrupted":
      return t("benchmark.status_interrupted");
  }
}

export type RunStatusTone = "ready" | "warning" | "error" | "neutral";

/**
 * Item status → display badge. "failed" only means not every criterion passed
 * (binary all-pass scoring) — the agent still completed the task, so it reads
 * as "Completed" and the colored rubric score conveys quality. Only real
 * pipeline problems (error / aborted / interrupted) get alarming labels.
 */
export function itemStatusBadge(status: BenchmarkItemStatus): { label: string; tone: RunStatusTone } {
  if (status === "passed") return { label: t("benchmark.verdict_pass"), tone: "ready" };
  if (status === "failed") return { label: t("benchmark.status_completed"), tone: "neutral" };
  if (status === "error") return { label: t("benchmark.verdict_error"), tone: "error" };
  if (status === "aborted") return { label: t("benchmark.status_aborted"), tone: "warning" };
  if (status === "interrupted") return { label: t("benchmark.status_interrupted"), tone: "warning" };
  return { label: t("benchmark.status_running"), tone: "neutral" };
}

export function runStatusTone(status: BenchmarkRunStatus): RunStatusTone {
  switch (status) {
    case "completed":
      return "ready";
    case "failed":
      return "error";
    case "aborted":
    case "interrupted":
      return "warning";
    default:
      return "neutral";
  }
}

export function formatRunMeta(run: BenchmarkRunSummary): string {
  return t("benchmark.run_meta", { models: run.models.length, tasks: run.taskCount });
}

export function formatRunProgress(run: Pick<BenchmarkRunSummary, "progress">): string {
  return t("benchmark.progress", { done: run.progress.completed, total: run.progress.total });
}

export function modelLabel(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

export function workTypeLabel(workType: string): string {
  switch (workType) {
    case "analyze":
      return t("benchmark.work_type_analyze");
    case "draft":
      return t("benchmark.work_type_draft");
    case "review":
      return t("benchmark.work_type_review");
    case "research":
      return t("benchmark.work_type_research");
    default:
      return workType;
  }
}
