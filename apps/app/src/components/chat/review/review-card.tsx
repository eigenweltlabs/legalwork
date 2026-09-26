import { reviewActionLabel } from "@/react-app/domains/reviews/review-labels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ArrowUpRight, Loader2, Play, Square, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { useMessageList } from "../message-list-provider";
import { workspaceReviewsRoute } from "@/react-app/shell/workspace-routes";
import { reviewKey, ReviewError, ReviewStatus } from "@/react-app/domains/reviews/review-ui";
import { parseReviewCard, reviewCardProgress } from "./review-tool";
import { reviewCardQueryOptions } from "./review-card-query";
import { reviewRunAction, type SavedReview } from "@legalwork/types/reviews";

export function ReviewToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state === "output-error") return <ReviewError error={new Error(t("review.failed"))} />;
  if (part.state !== "output-available") return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("review.loading")}</div>;
  const card = parseReviewCard(part.output);
  return card ? <ReviewCard card={card} /> : <ReviewError error={new Error(t("review.failed"))} />;
}
function ReviewCard({ card }: { card: NonNullable<ReturnType<typeof parseReviewCard>> }) {
  const { legalworkClient, workspaceId } = useMessageList();
  const cache = useQueryClient();
  const available = !!legalworkClient && workspaceId === card.workspaceId;
  const query = useQuery(reviewCardQueryOptions(available ? legalworkClient : null, card.workspaceId, card.review.id, () => cache.getQueryData<SavedReview>(reviewKey(card.workspaceId, card.review.id))));
  const review = query.data;
  const progress = reviewCardProgress(card, review);
  const state = progress.status;
  const mutation = useMutation({ mutationFn: async () => {
    if (!legalworkClient || !review) return;
    return state === "running" ? legalworkClient.cancelReview(card.workspaceId, review.id) : legalworkClient.startReview(card.workspaceId, review.id, { revision: review.revision, rerun: false, reprocess: false, retryFailed: reviewRunAction(review) === "retry_failed" });
  }, onSuccess: async result => { if (result) cache.setQueryData(reviewKey(card.workspaceId, result.id), result); await cache.invalidateQueries({ queryKey: ["project-reviews", card.workspaceId] }); } });
  if (query.error instanceof LegalworkServerError && query.error.code === "review_not_found") return <section className="my-2 max-w-xl rounded-2xl border p-4"><h3 className="text-sm font-medium">{card.review.name}</h3><p className="mt-1 text-xs text-muted-foreground">{t("review.unavailable")}</p></section>;
  return <section className="my-2 max-w-xl overflow-hidden rounded-2xl border bg-background">
    <ReviewProgressCard progress={progress} href={workspaceReviewsRoute(card.workspaceId, card.review.id)} available={available} disconnected={query.isError} />
    {mutation.error && <div className="px-4 pb-3"><ReviewError error={mutation.error} /></div>}
    {review && reviewRunAction(review) !== "rerun_all" && <footer className="flex justify-end border-t px-3 py-2"><Button variant="ghost" size="sm" disabled={!available || mutation.isPending || !review.columns.length || !review.documents.length} onClick={() => mutation.mutate()}>{state === "running" ? <Square className="size-3.5" /> : <Play className="size-3.5" />}{reviewActionLabel(reviewRunAction(review))}</Button></footer>}
  </section>;
}

export function ReviewProgressCard({ progress, href, available, disconnected = false }: {
  progress: ReturnType<typeof reviewCardProgress>; href: string; available: boolean; disconnected?: boolean;
}) {
  const counts = t("review.card_processed", { done: progress.done, total: progress.total });
  const content = <>
    <div className="flex items-start gap-3">
      <div className="rounded-xl border bg-muted/20 p-2.5"><Table2 className="size-5" strokeWidth={1.5} /></div>
      <div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">{t("review.title")}</div><h3 className="mt-0.5 truncate font-medium">{progress.name}</h3><p className="mt-1 text-xs text-muted-foreground">{t(progress.documents === 1 ? "review.card_document" : "review.card_documents", { count: progress.documents })} · {t(progress.columns === 1 ? "review.card_column" : "review.card_columns", { count: progress.columns })}</p></div>
      <ReviewStatus status={progress.status} />
    </div>
    <div className="mt-4 space-y-2">
      <div className="flex justify-between gap-3 text-xs"><span className="text-muted-foreground">{counts}</span><span className="tabular-nums">{progress.percent}%</span></div>
      <Progress value={progress.percent} aria-label={t("review.card_progress")} aria-valuetext={counts} className="[&_[data-slot=progress-track]]:h-1.5" />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" role="status">
        {disconnected ? <span>{t("review.card_reconnecting")}</span> : <>
          {progress.preparing > 0 && progress.status === "running" && <span>{t("review.card_preparing", { count: progress.preparing })}</span>}
          {progress.status === "running" && <span>{t("review.queue_progress", { running: progress.running, queued: progress.queued })}</span>}
          {progress.attention > 0 && <span className="text-warning">{t("review.card_attention", { count: progress.attention })}</span>}
        </>}
      </div>
    </div>
    <div className="mt-4 flex items-center justify-end gap-1.5 text-xs font-medium">{t("review.open")}<ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></div>
  </>;
  return available ? <Link to={href} aria-label={t("review.open_named", { name: progress.name })} className="group block rounded-2xl p-4 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">{content}</Link>
    : <div className="p-4" aria-disabled="true">{content}</div>;
}
