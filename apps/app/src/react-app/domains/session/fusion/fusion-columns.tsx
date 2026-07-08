/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { CircleAlert, Loader2, Sparkles, X } from "lucide-react";

import { t } from "@/i18n";
import { resolveModelDisplayName } from "@/app/utils";
import { useFusionStore, type FusionCandidateRun, type FusionTurn } from "./fusion-store";

function phaseLabel(turn: FusionTurn): string {
  if (turn.phase === "candidates") return t("fusion.phase_candidates");
  if (turn.phase === "fusing") return t("fusion.phase_fusing");
  if (turn.phase === "error") return t("fusion.phase_error");
  return t("fusion.phase_done");
}

function CandidateColumn({ run }: { run: FusionCandidateRun }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the live stream pinned to the bottom of the column.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [run.reasoning, run.text]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1.5 flex items-center gap-1.5">
        {run.status === "running" || run.status === "pending" ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-gray-10" />
        ) : run.status === "error" ? (
          <CircleAlert size={12} className="shrink-0 text-red-10" />
        ) : (
          <Sparkles size={12} className="shrink-0 text-green-10" />
        )}
        <span className="truncate text-xs font-medium text-gray-12" title={`${run.model.providerID}/${run.model.modelID}`}>
          {resolveModelDisplayName(run.model.modelID)}
        </span>
      </div>
      {/* data-scrollable: keep the transcript's autoscroll controller from
          treating wheel gestures inside this nested scroller as browsing. */}
      <div ref={scrollRef} data-scrollable className="max-h-56 overflow-y-auto">
        {run.error ? (
          <div className="text-xs whitespace-pre-wrap text-red-11">{run.error}</div>
        ) : (
          <>
            {run.reasoning ? (
              <div className="chat-reasoning mb-2 text-xs whitespace-pre-wrap text-muted-foreground">{run.reasoning}</div>
            ) : null}
            {run.text ? (
              <div className="text-xs whitespace-pre-wrap text-gray-12">{run.text}</div>
            ) : !run.reasoning ? (
              <div className="text-xs text-gray-10">{t("fusion.waiting_for_model")}</div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Live view of a fusion turn: one column per candidate model streaming its
 * reasoning and output, shown in the chat while the candidates run and kept
 * (dismissable) after the fused answer streams into the main transcript.
 */
export function FusionColumnsPanel({ sessionId }: { sessionId: string }) {
  const turn = useFusionStore((state) => state.turns[sessionId]);
  const clearTurn = useFusionStore((state) => state.clearTurn);
  if (!turn) return null;

  const columnsClass = turn.runs.length >= 3 ? "md:grid-cols-3" : turn.runs.length === 2 ? "md:grid-cols-2" : "";

  return (
    <div className="mx-auto my-3 w-full">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles size={13} className="shrink-0 text-dls-accent" />
        <span className="text-xs font-semibold text-gray-12">{t("fusion.panel_title")}</span>
        <span className="truncate text-xs text-gray-10">{phaseLabel(turn)}</span>
        {turn.phase === "done" || turn.phase === "error" ? (
          <button
            type="button"
            className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
            onClick={() => clearTurn(sessionId)}
            title={t("action.remove")}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      <div className={`grid grid-cols-1 gap-x-6 gap-y-4 ${columnsClass}`}>
        {turn.runs.map((run, index) => (
          <CandidateColumn key={`${run.model.providerID}/${run.model.modelID}/${index}`} run={run} />
        ))}
      </div>
    </div>
  );
}
