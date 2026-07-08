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

type ScoreBand = "high" | "mid" | "low";

/** ≥80% high, ≥50% mid, below low — the shared traffic-light thresholds. */
function scoreBand(fraction: number): ScoreBand {
  if (fraction >= 0.8) return "high";
  if (fraction >= 0.5) return "mid";
  return "low";
}

/** Text tone for a 0–1 score fraction. */
export function scoreToneClass(fraction: number): string {
  const band = scoreBand(fraction);
  return band === "high" ? "text-green-11" : band === "mid" ? "text-amber-11" : "text-red-11";
}

/** Solid fill color for a leaderboard / heatmap bar. */
export function scoreBarClass(fraction: number): string {
  const band = scoreBand(fraction);
  return band === "high" ? "bg-green-9" : band === "mid" ? "bg-amber-9" : "bg-red-9";
}

/** Subtle cell/tile background tint for heatmaps. */
export function scoreTintClass(fraction: number): string {
  const band = scoreBand(fraction);
  return band === "high" ? "bg-green-3" : band === "mid" ? "bg-amber-3" : "bg-red-3";
}

/** Traffic-light tone by pass fraction: ≥80% green, ≥50% yellow, below red. */
export function criteriaScoreToneClass(nPassed: number, nCriteria: number): string {
  return scoreToneClass(nPassed / Math.max(nCriteria, 1));
}

/** Heatmap tint for a task×model cell by its pass fraction. */
export function criteriaScoreTintClass(nPassed: number, nCriteria: number): string {
  return scoreTintClass(nPassed / Math.max(nCriteria, 1));
}

export type VerticalRate = { rate: number | null; count: number };
export type VerticalBreakdownRow = { vertical: string; byModel: Record<string, VerticalRate> };

function modelRefKey(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

/**
 * Mean rubric pass rate per (vertical × model), for the per-practice-area
 * breakdown. Verticals keep first-seen order; only judged items count.
 */
export function aggregateByVertical(
  items: BenchmarkRunItem[],
  models: Array<{ providerID: string; modelID: string }>,
): VerticalBreakdownRow[] {
  const byVertical = new Map<string, Map<string, { sum: number; n: number }>>();
  const order: string[] = [];
  for (const item of items) {
    if (item.nPassed === null || item.nCriteria === null || item.nCriteria === 0) continue;
    const vertical = item.vertical || "—";
    if (!byVertical.has(vertical)) {
      byVertical.set(vertical, new Map());
      order.push(vertical);
    }
    const bucket = byVertical.get(vertical)!;
    const key = modelRefKey(item);
    const acc = bucket.get(key) ?? { sum: 0, n: 0 };
    acc.sum += item.nPassed / item.nCriteria;
    acc.n += 1;
    bucket.set(key, acc);
  }
  return order.map((vertical) => {
    const bucket = byVertical.get(vertical)!;
    const byModel: Record<string, VerticalRate> = {};
    for (const model of models) {
      const acc = bucket.get(modelRefKey(model));
      byModel[modelRefKey(model)] = acc && acc.n ? { rate: acc.sum / acc.n, count: acc.n } : { rate: null, count: 0 };
    }
    return { vertical, byModel };
  });
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
