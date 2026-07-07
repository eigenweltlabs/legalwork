/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, OctagonX, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkModelScore, BenchmarkRunStatus, BenchmarkRunSummary } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { SettingsListEmptyState, SettingsListSearchInput } from "../settings/settings-list";
import { SettingsNotice, SettingsStatusBadge, Spinner } from "../settings/settings-section";
import { criteriaScoreLabel, criteriaScoreToneClass, formatRunMeta, isRunActive, runStatusLabel, runStatusTone } from "./format";
import { useBenchmarkStore } from "./store";

export type RunTableProps = {
  onOpenRun: (runId: string) => void;
};

type StatusFilter = "active" | "completed" | "failed" | "aborted" | "interrupted";

const STATUS_FILTERS: Array<{ id: StatusFilter; statuses: BenchmarkRunStatus[] }> = [
  { id: "active", statuses: ["pending", "running", "aborting"] },
  { id: "completed", statuses: ["completed"] },
  { id: "failed", statuses: ["failed"] },
  { id: "aborted", statuses: ["aborted"] },
  { id: "interrupted", statuses: ["interrupted"] },
];

function statusFilterLabel(id: StatusFilter): string {
  if (id === "active") return t("benchmark.status_active");
  return runStatusLabel(id);
}

function modelKey(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

function collectModelColumns(runs: BenchmarkRunSummary[]): Array<{ providerID: string; modelID: string }> {
  const byKey = new Map<string, { providerID: string; modelID: string }>();
  for (const run of runs) {
    for (const model of run.models) {
      byKey.set(modelKey(model), model);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
  );
}

function ModelScoreCell({ run, score }: { run: BenchmarkRunSummary; score: BenchmarkModelScore | undefined }) {
  if (!score) return <span className="text-muted-foreground">—</span>;
  const scored = score.passed + score.failed;
  if (scored === 0 && score.error === 0) {
    return isRunActive(run.status) ? <Spinner /> : <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "font-medium tabular-nums",
          criteriaScoreToneClass(Math.round((score.rubricPassRate ?? 0) * 100), 100),
        )}
        title={`${score.passed}/${run.taskCount} tasks fully passed`}
      >
        {score.rubricPassRate !== null
          ? `${Math.round(score.rubricPassRate * 100)}% (${score.criteriaPassed}/${score.criteriaTotal})`
          : criteriaScoreLabel(score.passed, run.taskCount)}
      </span>
      {score.error > 0 ? <AlertTriangle size={12} className="text-amber-11" /> : null}
      {isRunActive(run.status) ? <Spinner /> : null}
    </span>
  );
}

export function RunTable(props: RunTableProps) {
  const runs = useBenchmarkStore((state) => state.runs);
  const runsStatus = useBenchmarkStore((state) => state.runsStatus);
  const runsError = useBenchmarkStore((state) => state.runsError);
  const refreshRuns = useBenchmarkStore((state) => state.refreshRuns);
  const startRunsPolling = useBenchmarkStore((state) => state.startRunsPolling);
  const stopRunsPolling = useBenchmarkStore((state) => state.stopRunsPolling);
  const abortRun = useBenchmarkStore((state) => state.abortRun);
  const deleteRun = useBenchmarkStore((state) => state.deleteRun);

  const [statusFilters, setStatusFilters] = useState<StatusFilter[]>([]);
  const [modelFilters, setModelFilters] = useState<string[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void refreshRuns();
    startRunsPolling();
    return () => stopRunsPolling();
  }, [refreshRuns, startRunsPolling, stopRunsPolling]);

  const modelColumns = useMemo(() => collectModelColumns(runs), [runs]);

  const filtered = useMemo(() => {
    const allowedStatuses = new Set(
      statusFilters.flatMap((id) => STATUS_FILTERS.find((entry) => entry.id === id)?.statuses ?? []),
    );
    const query = search.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilters.length && !allowedStatuses.has(run.status)) return false;
      if (modelFilters.length && !run.models.some((model) => modelFilters.includes(modelKey(model)))) {
        return false;
      }
      if (query) {
        const haystack = `${run.title} ${run.models.map((model) => model.modelID).join(" ")}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [runs, statusFilters, modelFilters, search]);

  const updateSearch = (value: string) => {
    setSearchDraft(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearch(value), 200);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                {t("benchmark.filter_status")}
                {statusFilters.length ? ` (${statusFilters.length})` : ""}
                <ChevronDown size={13} />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {STATUS_FILTERS.map((entry) => (
              <DropdownMenuCheckboxItem
                key={entry.id}
                checked={statusFilters.includes(entry.id)}
                onCheckedChange={() =>
                  setStatusFilters((previous) =>
                    previous.includes(entry.id)
                      ? previous.filter((id) => id !== entry.id)
                      : [...previous, entry.id],
                  )
                }
                onSelect={(event) => event.preventDefault()}
              >
                {statusFilterLabel(entry.id)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                {t("benchmark.filter_models")}
                {modelFilters.length ? ` (${modelFilters.length})` : ""}
                <ChevronDown size={13} />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {modelColumns.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">—</div>
            ) : (
              modelColumns.map((model) => (
                <DropdownMenuCheckboxItem
                  key={modelKey(model)}
                  checked={modelFilters.includes(modelKey(model))}
                  onCheckedChange={() =>
                    setModelFilters((previous) =>
                      previous.includes(modelKey(model))
                        ? previous.filter((key) => key !== modelKey(model))
                        : [...previous, modelKey(model)],
                    )
                  }
                  onSelect={(event) => event.preventDefault()}
                >
                  {model.modelID}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="min-w-44 flex-1">
          <SettingsListSearchInput
            placeholder={t("benchmark.search_runs")}
            value={searchDraft}
            onChange={(event) => updateSearch(event.target.value)}
          />
        </div>
      </div>

      {runsError ? <SettingsNotice tone="error">{t("benchmark.error_load_runs", { message: runsError })}</SettingsNotice> : null}

      {runsStatus === "loading" ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <SettingsListEmptyState>{t("benchmark.empty_runs")}</SettingsListEmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-dls-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 min-w-72 bg-background">
                  {t("benchmark.column_run")}
                </TableHead>
                {modelColumns.map((model) => (
                  <TableHead key={modelKey(model)} className="min-w-32 text-center">
                    <span className="inline-flex items-center gap-1.5">
                      <ProviderIcon providerId={model.providerID} size={13} />
                      {model.modelID}
                    </span>
                  </TableHead>
                ))}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((run) => {
                const scoreByModel = new Map(run.scoreByModel.map((score) => [modelKey(score), score]));
                return (
                  <TableRow key={run.id}>
                    <TableCell
                      className="sticky left-0 z-10 max-w-96 cursor-pointer bg-background"
                      onClick={() => props.onOpenRun(run.id)}
                    >
                      <div className="truncate text-[13px] font-medium" title={run.title}>
                        {run.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <SettingsStatusBadge
                          tone={runStatusTone(run.status)}
                          label={runStatusLabel(run.status)}
                          className="min-h-0 px-0 py-0"
                        />
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(run.createdAt).toLocaleString()} · {formatRunMeta(run)}
                        </span>
                      </div>
                      {isRunActive(run.status) && run.progress.total > 0 ? (
                        <div className="mt-1.5 flex items-center gap-2">
                          <Progress
                            className="h-1.5 w-40"
                            value={(run.progress.completed / run.progress.total) * 100}
                          />
                          <span className="text-[11px] text-muted-foreground">
                            {t("benchmark.progress", { done: run.progress.completed, total: run.progress.total })}
                          </span>
                        </div>
                      ) : null}
                    </TableCell>
                    {modelColumns.map((model) => (
                      <TableCell
                        key={modelKey(model)}
                        className="cursor-pointer text-center"
                        onClick={() => props.onOpenRun(run.id)}
                      >
                        {run.models.some((entry) => modelKey(entry) === modelKey(model)) ? (
                          <ModelScoreCell run={run} score={scoreByModel.get(modelKey(model))} />
                        ) : (
                          <span className="text-muted-foreground/40">·</span>
                        )}
                      </TableCell>
                    ))}
                    <TableCell>
                      {isRunActive(run.status) ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-red-11"
                          title={t("benchmark.abort")}
                          onClick={() => void abortRun(run.id)}
                        >
                          <OctagonX size={13} />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          title={t("benchmark.delete_run")}
                          onClick={() => void deleteRun(run.id)}
                        >
                          <Trash2 size={13} />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
