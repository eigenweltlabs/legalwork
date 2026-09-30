import { useQuery } from "@tanstack/react-query";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { Search } from "lucide-react";
import { JevSearchCardSchema, type JevSearchProgress } from "@legalwork/types/corpus";
import { useMessageList } from "../message-list-provider";
import { t } from "@/i18n";

export const isJevSearchTool = (part: ToolUIPart | DynamicToolUIPart) => getToolName(part) === "legalwork_jev_corpus_question";
function parseCard(output: unknown) {
  try { const parsed = JevSearchCardSchema.safeParse(typeof output === "string" ? JSON.parse(output) : output); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
export function shouldRenderJevSearchCard(part: ToolUIPart | DynamicToolUIPart) {
  // Polling calls must not create a second placeholder while their output streams.
  return isJevSearchTool(part) && part.state === "output-available" && parseCard(part.output) !== null;
}
export function jevSearchIdentity(part: ToolUIPart | DynamicToolUIPart) {
  if (!isJevSearchTool(part)) return null;
  const card = part.state === "output-available" ? parseCard(part.output) : null;
  if (card) return `${card.workspaceId}:${card.data.jobId}`;
  return null;
}
function latestProgress(first: JevSearchProgress | undefined, next: JevSearchProgress | undefined) {
  if (!first) return next;
  if (!next) return first;
  if (first.status !== "running" && next.status === "running") return first;
  return next.processed > first.processed || (first.status === "running" && next.status !== "running") ? next : first;
}

/** Preserve the first card's position/key, but restore its newest state from saved polling responses. */
export function withLatestJevSearchProgress(first: ToolUIPart | DynamicToolUIPart, next: ToolUIPart | DynamicToolUIPart) {
  if (first.state !== "output-available" || next.state !== "output-available") return first;
  const original = parseCard(first.output), update = parseCard(next.output);
  if (!original || !update || original.workspaceId !== update.workspaceId || original.data.jobId !== update.data.jobId) return first;
  return latestProgress(original.data, update.data) === update.data ? { ...first, output: next.output } : first;
}

export function JevSearchCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const { legalworkClient, workspaceId } = useMessageList();
  const card = part.state === "output-available" ? parseCard(part.output) : null;
  const query = useQuery({ queryKey: ["jev-search", card?.workspaceId, card?.data.jobId],
    queryFn: () => legalworkClient!.getJevSearchProgress(card!.workspaceId, card!.data.jobId),
    enabled: !!card && card.data.status === "running" && !!legalworkClient && card.workspaceId === workspaceId,
    initialData: card?.data, refetchOnMount: "always", retry: false,
    refetchInterval: query => query.state.error || query.state.data?.status !== "running" ? false : 1000,
  });
  const progress = latestProgress(card?.data, query.data);
  const failed = part.state === "output-error" || (part.state === "output-available" && !card);
  const percent = progress?.total ? Math.min(100, progress.processed / progress.total * 100) : 0;
  const pending = !failed && (!progress || progress.status === "running");
  const errors = progress?.counts.error ?? 0;
  const unsupported = progress?.counts.unsupported ?? 0;
  return <div className="my-2 flex max-w-md items-center gap-3 rounded-xl border px-3 py-2.5" role="status">
    <Search className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1">
      <div className="flex items-center justify-between gap-4 text-xs"><span className="font-medium">Jev Search</span><span className="text-muted-foreground">{failed ? t("review.failed") : progress ? `${progress.processed} / ${progress.total}` : t("review.loading")}</span></div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Jev Search" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ? Math.round(percent) : undefined}>
        <div className={`h-full rounded-full bg-foreground/70 transition-all ${pending && !progress ? "animate-pulse" : ""}`} style={{ width: `${progress ? percent : pending ? 15 : 0}%` }} />
      </div>
      {progress?.status === "cancelled" && <div className="mt-1 text-[10px] text-muted-foreground">{t("review.cancelled")}</div>}
      {progress?.status === "interrupted" && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.interrupted")}</div>}
      {pending && query.isError && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.saved_progress")}</div>}
      {!pending && errors > 0 && <div className="mt-1 text-[10px] text-destructive">{t("jev_search.errors", { count: errors })}</div>}
      {!pending && unsupported > 0 && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.unsupported", { count: unsupported })}</div>}
    </div>
  </div>;
}
