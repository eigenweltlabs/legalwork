/** @jsxImportSource react */
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkModelRef, BenchmarkModelScore } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";

export type RunLeaderboardProps = {
  models: BenchmarkModelRef[];
  scoreByModel: BenchmarkModelScore[];
};

/** Bar area height in px; headroom above it for the value labels. */
const CHART_H = 180;
const TOP_PAD = 26;
const PLOT_H = CHART_H + TOP_PAD;
const TICKS = [0, 50, 100];

/** Pixel offset from the top of the plot for a given percentage tick/line. */
function offsetForPercent(value: number): number {
  return TOP_PAD + (1 - value / 100) * CHART_H;
}

export function RunLeaderboard(props: RunLeaderboardProps) {
  // Rank by mean rubric pass rate; models without judged criteria sink last.
  const ranked = props.models
    .map((model) => ({
      model,
      score: props.scoreByModel.find(
        (entry) => entry.providerID === model.providerID && entry.modelID === model.modelID,
      ),
    }))
    .map((entry) => ({ ...entry, rate: entry.score?.rubricPassRate ?? null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));

  const hasData = ranked.some((entry) => (entry.score?.criteriaTotal ?? 0) > 0);
  if (!hasData) return null;

  return (
    <section className="rounded-2xl border border-dls-border bg-background p-5">
      <h2 className="mb-4 text-[13px] font-semibold text-foreground">{t("benchmark.leaderboard_title")}</h2>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {/* Y axis */}
        <div className="relative w-7 shrink-0" style={{ height: PLOT_H }}>
          {TICKS.map((value) => (
            <span
              key={value}
              className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground"
              style={{ top: offsetForPercent(value) }}
            >
              {value}
            </span>
          ))}
        </div>

        {/* Plot */}
        <div className="relative min-w-fit flex-1">
          {/* Gridlines */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: PLOT_H }}>
            {TICKS.map((value) => (
              <div
                key={value}
                className="absolute inset-x-0 border-t border-dls-border/60"
                style={{ top: offsetForPercent(value) }}
              />
            ))}
          </div>

          {/* Bars */}
          <div className="relative flex items-end justify-center gap-8" style={{ height: PLOT_H }}>
            {ranked.map((entry, index) => {
              const rate = entry.rate;
              const pct = rate !== null ? Math.round(rate * 100) : null;
              // "Slightly visualize the best": the top model is a solid bar,
              // the rest share the same hue faded back.
              const leader = index === 0 && rate !== null;
              return (
                <Tooltip key={`${entry.model.providerID}/${entry.model.modelID}`}>
                  <TooltipTrigger
                    render={
                      <div className="flex w-16 cursor-default flex-col items-center">
                        <span
                          className={cn(
                            "mb-1 text-[13px] font-semibold tabular-nums leading-none",
                            leader ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {pct !== null ? `${pct}%` : "—"}
                        </span>
                        <div
                          className={cn("w-11 rounded-t", leader ? "bg-foreground" : "bg-foreground/25")}
                          style={{ height: Math.max((rate ?? 0) * CHART_H, 3) }}
                        />
                      </div>
                    }
                  />
                  <TooltipContent>
                    <div className="flex flex-col gap-0.5 text-left">
                      <span className="font-medium">
                        {entry.model.providerID} / {entry.model.modelID}
                      </span>
                      {pct !== null && entry.score ? (
                        <span className="tabular-nums">
                          {pct}% ({entry.score.criteriaPassed}/{entry.score.criteriaTotal})
                        </span>
                      ) : null}
                    </div>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* X axis labels (the 0 gridline above is the baseline) */}
          <div className="mt-3 flex justify-center gap-8">
            {ranked.map((entry, index) => (
              <div
                key={`${entry.model.providerID}/${entry.model.modelID}`}
                className="flex w-16 flex-col items-center gap-0.5 text-center"
              >
                <ProviderIcon providerId={entry.model.providerID} size={14} />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className={cn(
                          "block w-full cursor-default truncate text-[11px]",
                          index === 0 && entry.rate !== null
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {entry.model.modelID}
                      </span>
                    }
                  />
                  <TooltipContent>
                    {entry.model.providerID} / {entry.model.modelID}
                  </TooltipContent>
                </Tooltip>
                {entry.score ? (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {entry.score.criteriaPassed}/{entry.score.criteriaTotal}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground">{t("benchmark.metric_explainer")}</p>
    </section>
  );
}
