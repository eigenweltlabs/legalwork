import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import type { ReviewCell, ReviewResult } from "@legalwork/types/reviews";
import { reviewDecisionProbabilities, selectedReviewDecisionProbability } from "@legalwork/types/reviews";

export function reviewProbabilityRows(result: ReviewResult) {
  if (!result.decision) return [];
  return reviewDecisionProbabilities(result.decision).map(row => ({ ...row, label: result.decision?.type === "noul" ? t(row.label === "Yes" ? "review.yes" : "review.no") : row.label }));
}
export function reviewAnswerProbability(result: ReviewResult) {
  if (!result.decision || result.value === "Needs review") return null;
  if (result.decision.type === "noul" && ["Yes", "No"].includes(result.value)) return result.value === "Yes" ? result.decision.noul : 1 - result.decision.noul;
  return selectedReviewDecisionProbability(result.decision);
}
export function reviewResultReason(result: ReviewResult) {
  if (result.value === "Needs review" && result.decision && result.decisionThreshold !== undefined
    && selectedReviewDecisionProbability(result.decision) < result.decisionThreshold) return t("review.below_probability_threshold", {
      probability: (selectedReviewDecisionProbability(result.decision) * 100).toFixed(1), threshold: Math.round(result.decisionThreshold * 100),
    });
  return result.reason;
}
export function ReviewProbabilities({ result }: { result: ReviewResult }) {
  const rows = reviewProbabilityRows(result);
  if (!rows.length) return null;
  return <section className="space-y-3"><h4 className="text-xs font-medium text-muted-foreground">{t("review.probability")}</h4>
    {rows.map(({ label, probability }) => <div key={label} className="space-y-1">
      <div className="flex justify-between gap-4 text-xs"><span>{label}</span><span className="shrink-0 tabular-nums text-muted-foreground">{(probability * 100).toFixed(1)}%</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-foreground/40" style={{ width: `${probability * 100}%` }} /></div>
    </div>)}
  </section>;
}

export function ReviewStatus({ status }: { status: string }) {
  return <Badge variant="outline" className={cn("gap-1.5 border-transparent font-normal", status === "complete" ? "bg-success-soft text-success" : ["blocked", "needs_review", "stale", "error", "interrupted"].includes(status) ? "bg-warning-soft text-warning" : "bg-muted/60 text-muted-foreground")}>
    {status === "running" && <Loader2 className="size-3 animate-spin" />}{t(`review.${status}`)}
  </Badge>;
}
export function reviewCellError(cell: ReviewCell) {
  if (cell.status === "blocked" && cell.blockedBy === "jev_mode") return new Error(t("review.jev_excluded_reason"));
  if (cell.status === "blocked" && cell.blockedBy) return new Error(t(cell.blockedBy === "llm" ? "review.llm_required" : "review.jev_required"));
  return cell.error ? new Error(cell.error) : null;
}
export function ReviewSelect({ value, onChange, options, label, disabled }: {
  value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; label: string; disabled?: boolean;
}) {
  return <Select value={value || null} onValueChange={next => { if (typeof next === "string") onChange(next); }} disabled={disabled}>
    <SelectTrigger aria-label={label} className="w-full bg-background"><SelectValue placeholder={label}>{options.find(option => option.value === value)?.label}</SelectValue></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}
export function ReviewError({ error }: { error: unknown }) {
  if (!error) return null;
  const localized: Record<string, string> = { review_mode_conflict: "review.library_conflict", review_model_required: "review.models_missing", review_model_unavailable: "review.model_unavailable", review_conflict: "review.changed", review_source_changed: "review.source_changed", review_running: "review.stop_to_edit", review_delete_running: "review.stop_to_delete", review_not_found: "review.unavailable", review_no_columns: "review.no_columns" };
  const key = error instanceof LegalworkServerError ? localized[error.code] : undefined;
  return <p role="alert" className="whitespace-pre-wrap rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{key ? t(key) : error instanceof Error ? error.message : t("review.failed")}</p>;
}
export function reviewAnswer(result: ReviewResult) {
  if (result.value === "Not found") return t("review.not_found");
  if (result.value === "Not applicable") return t("review.not_applicable");
  if (result.value === "Needs review") return t("review.needs_review");
  try {
    if (result.prompt.kind === "date") return new Date(`${result.value}T00:00:00Z`).toLocaleDateString(currentLocale(), { timeZone: "UTC" });
    if (result.prompt.kind === "number") return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 20 }).format(Number(result.value));
    if (result.prompt.kind === "percentage") return `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 20 }).format(Number(result.value))}%`;
    if (result.prompt.kind === "currency") {
      const money: unknown = JSON.parse(result.value);
      if (typeof money === "object" && money !== null && "amount" in money && typeof money.amount === "number" && "currency" in money && typeof money.currency === "string")
        return new Intl.NumberFormat(currentLocale(), { style: "currency", currency: money.currency, maximumFractionDigits: 20 }).format(money.amount);
    }
    if (result.prompt.kind === "multi_select") {
      const choices: unknown = JSON.parse(result.value);
      if (Array.isArray(choices) && choices.every(choice => typeof choice === "string")) return choices.join(" · ");
    }
  } catch { /* Keep old results readable if their output predates type validation. */ }
  return result.prompt.kind === "yes_no" && ["Yes", "No"].includes(result.value) ? t(result.value === "Yes" ? "review.yes" : "review.no") : result.value;
}
export const reviewKey = (workspaceId: string, reviewId?: string) => ["project-reviews", workspaceId, reviewId ?? "list"];
