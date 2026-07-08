/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type {
  BenchmarkAnalyticsStat,
  BenchmarkModelAnalytics,
  BenchmarkModelScore,
} from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { SettingsListEmptyState } from "../settings/settings-list";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { scoreTintClass, scoreToneClass } from "./format";
import { RunLeaderboard } from "./run-leaderboard";
import { useBenchmarkStore } from "./store";

/** Present the overall aggregate as a run-style score so we can reuse the leaderboard chart. */
function toModelScore(model: BenchmarkModelAnalytics): BenchmarkModelScore {
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    passed: 0,
    failed: 0,
    error: 0,
    avgScore: null,
    rubricPassRate: model.overall.rate,
    criteriaPassed: model.overall.criteriaPassed,
    criteriaTotal: model.overall.criteriaTotal,
  };
}

function StatCell({ stat, className }: { stat: BenchmarkAnalyticsStat | undefined; className?: string }) {
  if (!stat || stat.rate === null) {
    return <td className={cn("px-3 py-2 text-center text-muted-foreground", className)}>—</td>;
  }
  const pct = Math.round(stat.rate * 100);
  return (
    <td className={cn("px-3 py-2 text-center", scoreTintClass(stat.rate), className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className={cn("cursor-default font-medium tabular-nums", scoreToneClass(stat.rate))}>{pct}%</span>
          }
        />
        <TooltipContent>
          {stat.criteriaPassed}/{stat.criteriaTotal} · {t("benchmark.tasks_count", { count: stat.tasks })}
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

export function AnalyticsView() {
  const analytics = useBenchmarkStore((state) => state.analytics);
  const status = useBenchmarkStore((state) => state.analyticsStatus);
  const error = useBenchmarkStore((state) => state.analyticsError);
  const loadAnalytics = useBenchmarkStore((state) => state.loadAnalytics);
  const selectedTags = useBenchmarkStore((state) => state.analyticsTags);
  const setAnalyticsTags = useBenchmarkStore((state) => state.setAnalyticsTags);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const refresh = async () => {
    setRefreshing(true);
    await loadAnalytics();
    setRefreshing(false);
  };

  if (status === "loading" && !analytics) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  if (error && !analytics) {
    return <SettingsNotice tone="error">{error}</SettingsNotice>;
  }
  if (!analytics) return null;

  // "Nothing yet" only when there is genuinely no data (not a too-narrow filter).
  if (analytics.models.length === 0 && analytics.tags.length === 0 && selectedTags.length === 0) {
    return (
      <SettingsListEmptyState>
        <div className="font-medium text-foreground">{t("benchmark.analytics_empty")}</div>
        <div className="mt-1">{t("benchmark.analytics_empty_hint")}</div>
      </SettingsListEmptyState>
    );
  }

  const models = analytics.models.map((model) => ({ providerID: model.providerID, modelID: model.modelID }));
  const scoreByModel = analytics.models.map(toModelScore);
  const availableTags = analytics.tags;
  const toggleTag = (tag: string) =>
    setAnalyticsTags(selectedTags.includes(tag) ? selectedTags.filter((entry) => entry !== tag) : [...selectedTags, tag]);

  // Breakdown columns = tags present in the (filtered) results, most-tested first.
  const columnCounts = new Map<string, number>();
  for (const model of analytics.models) {
    for (const entry of model.byTag) columnCounts.set(entry.tag, (columnCounts.get(entry.tag) ?? 0) + entry.tasks);
  }
  const columns = Array.from(columnCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <div className="flex items-center gap-2">
        {availableTags.length ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="outline" size="sm">
                    {t("benchmark.filter_tags")}
                    {selectedTags.length ? ` (${selectedTags.length})` : ""}
                    <ChevronDown size={13} />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
                {availableTags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag}
                    checked={selectedTags.includes(tag)}
                    onCheckedChange={() => toggleTag(tag)}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {tag}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedTags.length ? (
              <Button variant="ghost" size="sm" onClick={() => setAnalyticsTags([])}>
                {t("benchmark.clear_filter")}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw size={13} className={cn(refreshing && "animate-spin")} />
          {t("common.refresh")}
        </Button>
      </div>

      {analytics.models.length === 0 ? (
        <SettingsListEmptyState>{t("benchmark.analytics_no_match")}</SettingsListEmptyState>
      ) : (
        <>
          <RunLeaderboard models={models} scoreByModel={scoreByModel} />

          {columns.length ? (
            <section className="overflow-hidden rounded-2xl border border-dls-border bg-background">
              <header className="border-b border-dls-border px-5 py-3">
                <h2 className="text-[13px] font-semibold text-foreground">{t("benchmark.by_tag_title")}</h2>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 bg-background px-5 py-2 text-left font-medium text-muted-foreground">
                        {t("benchmark.column_model")}
                      </th>
                      <th className="min-w-24 border-l border-dls-border px-3 py-2 text-center font-medium">
                        {t("benchmark.analytics_overall")}
                      </th>
                      {columns.map((tag) => (
                        <th key={tag} className="min-w-28 px-3 py-2 text-center font-medium" title={tag}>
                          <span className="block max-w-36 truncate">{tag}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.models.map((model) => {
                      const byTag = new Map(model.byTag.map((entry) => [entry.tag, entry]));
                      return (
                        <tr key={`${model.providerID}/${model.modelID}`} className="border-t border-dls-border">
                          <td className="sticky left-0 z-10 max-w-52 bg-background px-5 py-2">
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                              <ProviderIcon providerId={model.providerID} size={13} />
                              <span className="truncate" title={model.modelID}>
                                {model.modelID}
                              </span>
                            </span>
                          </td>
                          <StatCell stat={model.overall} className="border-l border-dls-border font-semibold" />
                          {columns.map((tag) => (
                            <StatCell key={tag} stat={byTag.get(tag)} />
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
