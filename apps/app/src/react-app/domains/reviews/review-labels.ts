import { t } from "@/i18n";
import type { ReviewColumn, ReviewMode, reviewRunAction } from "@legalwork/types/reviews";

// Translate on use so labels follow locale changes; keep keys static for the audit.
const columnLabels: Record<ReviewColumn["kind"], () => string> = {
  yes_no: () => t("review.yes_no"),
  classification: () => t("review.classification"),
  text: () => t("review.text"),
  date: () => t("review.date"),
  number: () => t("review.number"),
  currency: () => t("review.currency"),
  percentage: () => t("review.percentage"),
  multi_select: () => t("review.multi_select"),
};
export const reviewColumnLabel = (kind: ReviewColumn["kind"]) => columnLabels[kind]();

const modeLabels: Record<ReviewMode, () => string> = {
  jev: () => t("review.jev"),
  mixed: () => t("review.mixed"),
  llm: () => t("review.llm"),
};
export const reviewModeLabel = (mode: ReviewMode) => modeLabels[mode]();

const actionLabels: Record<ReturnType<typeof reviewRunAction>, () => string> = {
  run: () => t("review.run"),
  resume: () => t("review.resume"),
  stop: () => t("review.stop"),
  retry_failed: () => t("review.retry_failed"),
  rerun_all: () => t("review.rerun_all"),
};
export const reviewActionLabel = (action: ReturnType<typeof reviewRunAction>) => actionLabels[action]();

const statusLabels = new Map([
  ["draft", () => t("review.draft")],
  ["pending", () => t("review.pending")],
  ["queued", () => t("review.queued")],
  ["preparing", () => t("review.preparing")],
  ["ready", () => t("review.ready")],
  ["running", () => t("review.running")],
  ["blocked", () => t("review.blocked")],
  ["complete", () => t("review.complete")],
  ["needs_review", () => t("review.needs_review")],
  ["error", () => t("review.error")],
  ["stale", () => t("review.stale")],
  ["cancelled", () => t("review.cancelled")],
  ["interrupted", () => t("review.interrupted")],
  ["absent", () => t("review.absent")],
]);
// Review summary status is a string; retain unknown statuses from newer servers.
export const reviewStatusLabel = (status: string) => statusLabels.get(status)?.() ?? status;
