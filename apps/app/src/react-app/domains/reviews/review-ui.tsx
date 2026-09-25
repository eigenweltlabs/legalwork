import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import type { ReviewResult } from "@legalwork/types/reviews";

export function ReviewStatus({ status }: { status: string }) {
  return <Badge variant="outline" className={cn("gap-1.5 border-transparent font-normal", status === "complete" ? "bg-success-soft text-success" : ["needs_review", "stale", "error", "interrupted"].includes(status) ? "bg-warning-soft text-warning" : "bg-muted/60 text-muted-foreground")}>
    {status === "running" && <Loader2 className="size-3 animate-spin" />}{t(`review.${status}`)}
  </Badge>;
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
  const localized: Record<string, string> = { review_mode_conflict: "review.library_conflict", review_model_required: "review.models_missing", review_model_unavailable: "review.model_unavailable", review_conflict: "review.changed", review_source_changed: "review.source_changed", review_running: "review.stop_to_edit", review_no_columns: "review.no_columns" };
  const key = error instanceof LegalworkServerError ? localized[error.code] : undefined;
  return <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">{key ? t(key) : error instanceof Error ? error.message : t("review.failed")}</p>;
}
export function reviewAnswer(result: ReviewResult) {
  if (result.value === "Not found") return t("review.not_found");
  if (result.value === "Needs review") return t("review.needs_review");
  return result.prompt.kind === "yes_no" && ["Yes", "No"].includes(result.value) ? t(result.value === "Yes" ? "review.yes" : "review.no") : result.value;
}
export const reviewKey = (workspaceId: string, reviewId?: string) => ["project-reviews", workspaceId, reviewId ?? "list"];
