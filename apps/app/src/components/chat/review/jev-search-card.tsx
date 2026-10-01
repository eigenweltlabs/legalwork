import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
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
  return next.processed > first.processed || (first.status === "running" && next.status !== "running") || (!first.question && !!next.question) ? next : first;
}

/** Preserve the first card's position/key, but restore its newest state from saved polling responses. */
export function withLatestJevSearchProgress(first: ToolUIPart | DynamicToolUIPart, next: ToolUIPart | DynamicToolUIPart) {
  if (first.state !== "output-available" || next.state !== "output-available") return first;
  const original = parseCard(first.output), update = parseCard(next.output);
  if (!original || !update || original.workspaceId !== update.workspaceId || original.data.jobId !== update.data.jobId) return first;
  return latestProgress(original.data, update.data) === update.data ? { ...first, output: next.output } : first;
}

export function JevSearchCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const [expanded, setExpanded] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const { legalworkClient, workspaceId } = useMessageList();
  const card = part.state === "output-available" ? parseCard(part.output) : null;
  const query = useQuery({ queryKey: ["jev-search", card?.workspaceId, card?.data.jobId],
    queryFn: () => legalworkClient!.getJevSearchProgress(card!.workspaceId, card!.data.jobId),
    enabled: !!card && (card.data.status === "running" || !card.data.question) && !!legalworkClient && card.workspaceId === workspaceId,
    initialData: card?.data, refetchOnMount: "always", retry: false,
    refetchInterval: query => query.state.error || query.state.data?.status !== "running" ? false : 1000,
  });
  const progress = latestProgress(card?.data, query.data);
  const failed = part.state === "output-error" || (part.state === "output-available" && !card);
  const percent = progress?.total ? Math.min(100, progress.processed / progress.total * 100) : 0;
  const pending = !failed && (!progress || progress.status === "running");
  const errors = progress?.counts.error ?? 0;
  const unsupported = progress?.counts.unsupported ?? 0;
  const results = useQuery({
    queryKey: ["jev-search-results", card?.workspaceId, card?.data.jobId, answer, offset],
    queryFn: () => legalworkClient!.getJevSearchResults(card!.workspaceId, card!.data.jobId, answer!, offset),
    enabled: expanded && !!answer && !!card && !!legalworkClient && card.workspaceId === workspaceId && !pending,
    retry: false,
  });
  return <div className="my-2 flex max-w-lg items-start gap-3 rounded-xl border px-3 py-2.5" role="status">
    <Search className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1">
      <button type="button" className="flex w-full items-center justify-between gap-4 text-left text-xs" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="font-medium">Jev Search</span><span className="ml-auto text-muted-foreground">{failed ? t("review.failed") : progress ? `${progress.processed} / ${progress.total}` : t("review.loading")}</span>
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </button>
      {progress?.question && <p className={expanded ? "mt-2 whitespace-pre-wrap break-words text-xs" : "mt-1 line-clamp-1 text-xs text-muted-foreground"}>{progress.question}</p>}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Jev Search" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ? Math.round(percent) : undefined}>
        <div className={`h-full rounded-full bg-foreground/70 transition-all ${pending && !progress ? "animate-pulse" : ""}`} style={{ width: `${progress ? percent : pending ? 15 : 0}%` }} />
      </div>
      {progress?.status === "cancelled" && <div className="mt-1 text-[10px] text-muted-foreground">{t("review.cancelled")}</div>}
      {progress?.status === "interrupted" && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.interrupted")}</div>}
      {pending && query.isError && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.saved_progress")}</div>}
      {!pending && errors > 0 && <div className="mt-1 text-[10px] text-destructive">{t("jev_search.errors", { count: errors })}</div>}
      {!pending && unsupported > 0 && <div className="mt-1 text-[10px] text-muted-foreground">{t("jev_search.unsupported", { count: unsupported })}</div>}
      {expanded && progress && <div className="mt-3 space-y-2">
        <JevSearchAnswerCounts progress={progress} selectedAnswer={answer} disabled={pending || !legalworkClient || card?.workspaceId !== workspaceId}
          onSelect={value => { setAnswer(value === answer ? null : value); setOffset(0); }} />
        {answer && <div className="rounded-lg border p-2 text-xs">
          <p className="mb-2 font-medium">{answer}</p>
          {results.isError ? <p className="text-destructive">{t("jev_search.results_unavailable")}</p> : results.isPending ? <p>{t("review.loading")}</p> : <ul className="max-h-48 space-y-1 overflow-auto">
            {results.data?.results.map(row => <li key={row.path} className="break-all text-muted-foreground">{row.path}</li>)}
          </ul>}
          {results.data && (offset > 0 || results.data.nextOffset !== null) && <div className="mt-2 flex justify-between gap-2">
            <button type="button" disabled={offset === 0} className="disabled:opacity-40" onClick={() => setOffset(Math.max(0, offset - 20))}>{t("jev_search.previous")}</button>
            <button type="button" disabled={results.data.nextOffset === null} className="disabled:opacity-40" onClick={() => { if (results.data?.nextOffset != null) setOffset(results.data.nextOffset); }}>{t("jev_search.next")}</button>
          </div>}
        </div>}
      </div>}
    </div>
  </div>;
}

export function JevSearchAnswerCounts({ progress, selectedAnswer, disabled, onSelect }: {
  progress: JevSearchProgress; selectedAnswer: string | null; disabled: boolean; onSelect: (answer: string) => void;
}) {
  return <div className="flex flex-wrap gap-1.5" aria-label={t("jev_search.answers")}>
    {Object.entries(progress.counts).map(([answer, count]) => <button key={answer} type="button" disabled={disabled}
      aria-pressed={selectedAnswer === answer} onClick={() => onSelect(answer)}
      className="rounded-md border px-2 py-1 text-xs aria-pressed:bg-muted disabled:cursor-default">
      {answer}<span className="ml-2 font-medium tabular-nums">{count}</span>
    </button>)}
  </div>;
}
