import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useParams } from "react-router-dom";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ArrowUpRight, Loader2, Play, Square, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useMessageList } from "../message-list-provider";
import { workspaceReviewsRoute } from "@/react-app/shell/workspace-routes";
import { reviewKey, ReviewError, ReviewStatus } from "@/react-app/domains/reviews/review-ui";
import { parseReviewCard } from "./review-tool";

export function ReviewToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state === "output-error") return <ReviewError error={new Error(t("review.failed"))} />;
  if (part.state !== "output-available") return <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("review.loading")}</div>;
  const card = parseReviewCard(part.output);
  return card ? <ReviewCard card={card} /> : <ReviewError error={new Error(t("review.failed"))} />;
}
function ReviewCard({ card }: { card: NonNullable<ReturnType<typeof parseReviewCard>> }) {
  const { legalworkClient, workspaceId } = useMessageList();
  const route = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const available = !!legalworkClient && workspaceId === card.workspaceId;
  const query = useQuery({ queryKey: reviewKey(card.workspaceId, card.review.id), queryFn: () => legalworkClient!.getReview(card.workspaceId, card.review.id), enabled: available, refetchInterval: query => query.state.data?.status === "running" || !query.state.data ? 2000 : false });
  const review = query.data;
  const state = review?.status ?? card.review.status;
  const done = review ? review.cells.filter(cell => ["complete", "needs_review", "error"].includes(cell.status)).length : card.review.completed;
  const total = review?.cells.length ?? card.review.total;
  const mutation = useMutation({ mutationFn: async () => {
    if (!legalworkClient || !review) return;
    return state === "running" ? legalworkClient.cancelReview(card.workspaceId, review.id) : legalworkClient.startReview(card.workspaceId, review.id, { revision: review.revision, rerun: false, reprocess: false });
  }, onSuccess: async result => { if (result) cache.setQueryData(reviewKey(card.workspaceId, result.id), result); await cache.invalidateQueries({ queryKey: ["project-reviews", card.workspaceId] }); } });
  return <section className="my-2 overflow-hidden rounded-2xl border bg-background"><div className="flex items-start gap-3 p-4"><div className="rounded-xl border bg-muted/20 p-2.5"><Table2 className="size-5" strokeWidth={1.5} /></div><div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">{t("review.title")}</div><h3 className="mt-0.5 truncate font-medium">{review?.name ?? card.review.name}</h3><p className="mt-1 text-xs text-muted-foreground">{review?.documents.length ?? card.review.documents} {t("review.documents").toLocaleLowerCase()} · {review?.columns.length ?? card.review.columns} {t("review.columns").toLocaleLowerCase()}</p></div><ReviewStatus status={state} /></div>
    {state === "running" && <div className="mx-4 mb-3"><p className="mb-2 text-xs text-muted-foreground">{t("review.progress", { done, total })}</p><div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-foreground transition-all" style={{ width: `${total ? done / total * 100 : 0}%` }} /></div></div>}
    <ReviewError error={query.error || mutation.error} /><footer className="flex justify-end gap-2 border-t px-4 py-2.5">{review && state !== "complete" && <Button variant="ghost" size="sm" disabled={!available || mutation.isPending || !review.columns.length} onClick={() => mutation.mutate()}>{state === "running" ? <Square className="size-3.5" /> : <Play className="size-3.5" />}{t(state === "running" ? "review.stop" : review.runId ? "review.resume" : "review.run")}</Button>}<Button size="sm" variant="outline" disabled={!available} onClick={() => navigate(workspaceReviewsRoute(route.workspaceId ?? card.workspaceId, card.review.id))}>{t("review.title")}<ArrowUpRight className="size-3.5" /></Button></footer>
  </section>;
}
