/** @jsxImportSource react */
import { useEffect } from "react";
import { ArrowLeft, OctagonX, RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import { ProviderIcon } from "../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge, Spinner } from "../settings/settings-section";
import { LayoutSection, LayoutSectionHeader, LayoutStack } from "../settings/settings-layout";
import { criteriaScoreLabel, criteriaScoreToneClass, formatRunMeta, formatScorePercent, isRunActive, runStatusLabel, runStatusTone } from "./format";
import { ResultMatrix } from "./result-matrix";
import { RunLeaderboard } from "./run-leaderboard";
import { RunTagBreakdown } from "./run-tag-breakdown";
import { useBenchmarkStore } from "./store";

export type RunDetailProps = {
  runId: string;
  onBackToList: () => void;
  onOpenItemSession?: (itemId: string) => void;
};

export function RunDetail(props: RunDetailProps) {
  const activeRun = useBenchmarkStore((state) => state.activeRun);
  const activeRunStatus = useBenchmarkStore((state) => state.activeRunStatus);
  const activeRunError = useBenchmarkStore((state) => state.activeRunError);
  const loadRun = useBenchmarkStore((state) => state.loadRun);
  const startDetailPolling = useBenchmarkStore((state) => state.startDetailPolling);
  const stopDetailPolling = useBenchmarkStore((state) => state.stopDetailPolling);
  const abortRun = useBenchmarkStore((state) => state.abortRun);
  const resumeRun = useBenchmarkStore((state) => state.resumeRun);
  const deleteRun = useBenchmarkStore((state) => state.deleteRun);

  useEffect(() => {
    void loadRun(props.runId);
    startDetailPolling(props.runId);
    return () => stopDetailPolling();
  }, [props.runId, loadRun, startDetailPolling, stopDetailPolling]);

  const run = activeRun?.run;
  const items = activeRun?.items ?? [];

  return (
    <LayoutStack className="max-w-6xl">
      <LayoutSection>
        <LayoutSectionHeader>
          {run ? (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
              <span className="mr-1 inline-flex items-center gap-2">
                {isRunActive(run.status) ? <Spinner /> : null}
                <SettingsStatusBadge tone={runStatusTone(run.status)} label={runStatusLabel(run.status)} />
              </span>
              <span>
                {formatRunMeta(run)} · {t("benchmark.judge_title")}:
              </span>
              <span className="inline-flex items-center gap-1">
                <ProviderIcon providerId={run.judgeModel.providerID} size={12} />
                {run.judgeModel.modelID}
              </span>
              {run.aggregateScore !== null ? (
                <span>
                  · {t("benchmark.aggregate_score")}: {formatScorePercent(run.aggregateScore)}
                </span>
              ) : null}
            </div>
          ) : null}
        </LayoutSectionHeader>

        {activeRunError ? <SettingsNotice tone="error">{activeRunError}</SettingsNotice> : null}
        {run?.error ? <SettingsNotice tone="error">{run.error}</SettingsNotice> : null}

        {run ? (
          <div className="flex items-center gap-2 px-1">
            {isRunActive(run.status) ? (
              <>
                <Progress
                  className="h-1.5 w-56"
                  value={run.progress.total > 0 ? (run.progress.completed / run.progress.total) * 100 : 0}
                />
                <span className="text-xs text-muted-foreground">
                  {t("benchmark.progress", { done: run.progress.completed, total: run.progress.total })}
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void abortRun(run.id)}
                  disabled={run.status === "aborting"}
                >
                  <OctagonX size={14} />
                  {run.status === "aborting" ? t("benchmark.aborting") : t("benchmark.abort")}
                </Button>
              </>
            ) : (
              <>
                {["interrupted", "aborted", "failed"].includes(run.status) ? (
                  <Button variant="outline" size="sm" onClick={() => void resumeRun(run.id)}>
                    <RotateCcw size={14} />
                    {t("benchmark.resume")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void deleteRun(run.id).then(() => props.onBackToList());
                  }}
                >
                  <Trash2 size={14} />
                  {t("benchmark.delete_run")}
                </Button>
              </>
            )}
          </div>
        ) : null}

        {activeRunStatus === "loading" && !run ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Spinner />
          </div>
        ) : null}


        {run ? <RunLeaderboard models={run.models} scoreByModel={run.scoreByModel} /> : null}

        {items.length > 0 && run ? (
          <ResultMatrix
            runId={run.id}
            items={items}
            scoreByModel={run.scoreByModel}
            taskCount={run.taskCount}
            models={run.models}
            selectedItemId={null}
            onSelectItem={(item) => props.onOpenItemSession?.(item.id)}
          />
        ) : null}

        {items.length > 0 && run ? <RunTagBreakdown items={items} models={run.models} /> : null}
      </LayoutSection>
    </LayoutStack>
  );
}
