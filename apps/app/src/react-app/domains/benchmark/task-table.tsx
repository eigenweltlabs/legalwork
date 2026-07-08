/** @jsxImportSource react */
import { useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Download, FileDown, Play, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { BenchmarkTaskItem, BenchmarkTaskResult, BenchmarkWorkType } from "../../../app/lib/benchmark-types";
import { BENCHMARK_WORK_TYPES } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { SettingsListSearchInput } from "../settings/settings-list";
import { SettingsListEmptyState } from "../settings/settings-list";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { collectTaskTags, filterTaskRows } from "./filter-tasks";
import { criteriaScoreLabel, criteriaScoreToneClass, isItemActive, workTypeLabel } from "./format";
import { useBenchmarkStore } from "./store";

export type TaskTableProps = {
  onOpenTask: (task: BenchmarkTaskItem) => void;
  onImport: () => void;
  onNewTask: () => void;
  onStartRun: () => void;
};

function modelKey(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

/** Union of models seen in the latest results, ordered provider → model. */
function collectModelColumns(tasks: BenchmarkTaskItem[]): Array<{ providerID: string; modelID: string }> {
  const byKey = new Map<string, { providerID: string; modelID: string }>();
  for (const task of tasks) {
    for (const result of task.latestResults) {
      byKey.set(modelKey(result), { providerID: result.providerID, modelID: result.modelID });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
  );
}

function ResultCell({ result }: { result: BenchmarkTaskResult | undefined }) {
  if (!result) return <span className="text-muted-foreground">—</span>;
  if (isItemActive(result.status)) return <Spinner />;
  if (result.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-amber-11">
        <AlertTriangle size={13} />
      </span>
    );
  }
  if (result.status === "aborted" || result.status === "interrupted") {
    return <span className="text-muted-foreground">{result.status === "aborted" ? "⊘" : "⏸"}</span>;
  }
  if (result.nCriteria === null || result.nPassed === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn("font-medium tabular-nums", criteriaScoreToneClass(result.nPassed, result.nCriteria))}
      title={new Date(result.runCreatedAt).toLocaleString()}
    >
      {criteriaScoreLabel(result.nPassed, result.nCriteria)}
    </span>
  );
}

export function TaskTable(props: TaskTableProps) {
  const tasks = useBenchmarkStore((state) => state.tasks);
  const tasksStatus = useBenchmarkStore((state) => state.tasksStatus);
  const tasksError = useBenchmarkStore((state) => state.tasksError);
  const filters = useBenchmarkStore((state) => state.filters);
  const setFilters = useBenchmarkStore((state) => state.setFilters);
  const selectedTaskIds = useBenchmarkStore((state) => state.selectedTaskIds);
  const toggleTaskSelection = useBenchmarkStore((state) => state.toggleTaskSelection);
  const setTaskSelection = useBenchmarkStore((state) => state.setTaskSelection);
  const clearTaskSelection = useBenchmarkStore((state) => state.clearTaskSelection);
  const deleteTask = useBenchmarkStore((state) => state.deleteTask);
  const deleteTasks = useBenchmarkStore((state) => state.deleteTasks);
  const exportTasks = useBenchmarkStore((state) => state.exportTasks);
  const exporting = useBenchmarkStore((state) => state.exporting);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allTags = useMemo(() => collectTaskTags(tasks), [tasks]);
  const filtered = useMemo(() => filterTaskRows(tasks, filters), [tasks, filters]);
  const modelColumns = useMemo(() => collectModelColumns(tasks), [tasks]);
  const selectedSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const allFilteredSelected = filtered.length > 0 && filtered.every((task) => selectedSet.has(task.id));

  const setSearch = (value: string) => {
    setSearchDraft(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setFilters({ search: value }), 200);
  };

  const toggleWorkType = (workType: BenchmarkWorkType) => {
    setFilters({
      workTypes: filters.workTypes.includes(workType)
        ? filters.workTypes.filter((entry) => entry !== workType)
        : [...filters.workTypes, workType],
    });
  };

  const toggleTag = (tag: string) => {
    setFilters({
      tags: filters.tags.includes(tag) ? filters.tags.filter((entry) => entry !== tag) : [...filters.tags, tag],
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                {t("benchmark.filter_work_type")}
                {filters.workTypes.length ? ` (${filters.workTypes.length})` : ""}
                <ChevronDown size={13} />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {BENCHMARK_WORK_TYPES.map((workType) => (
              <DropdownMenuCheckboxItem
                key={workType}
                checked={filters.workTypes.includes(workType)}
                onCheckedChange={() => toggleWorkType(workType)}
                onSelect={(event) => event.preventDefault()}
              >
                {workTypeLabel(workType)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm">
                {t("benchmark.filter_tags")}
                {filters.tags.length ? ` (${filters.tags.length})` : ""}
                <ChevronDown size={13} />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {allTags.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">—</div>
            ) : (
              allTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={filters.tags.includes(tag)}
                  onCheckedChange={() => toggleTag(tag)}
                  onSelect={(event) => event.preventDefault()}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="min-w-44 flex-1">
          <SettingsListSearchInput
            placeholder={t("benchmark.search_tasks")}
            value={searchDraft}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <Button variant="outline" size="sm" onClick={props.onImport}>
          <Download size={13} />
          {t("benchmark.import_tasks")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void exportTasks(selectedTaskIds)}
          disabled={exporting || selectedTaskIds.length === 0}
          title={t("benchmark.export_tasks_hint")}
        >
          <FileDown size={13} />
          {exporting ? t("benchmark.exporting") : t("benchmark.export_tasks")}
          {selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}
        </Button>
        <Button variant="outline" size="sm" onClick={props.onNewTask}>
          <Plus size={13} />
          {t("benchmark.new_task")}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8 text-red-11 hover:text-red-11"
          onClick={() => setConfirmDelete(true)}
          disabled={selectedTaskIds.length === 0}
          title={`${t("benchmark.delete_tasks")}${selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}`}
        >
          <Trash2 size={13} />
        </Button>
        <Button size="sm" onClick={props.onStartRun} disabled={selectedTaskIds.length === 0}>
          <Play size={13} />
          {t("benchmark.start_run")}
          {selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}
        </Button>
      </div>

      {tasksError ? <SettingsNotice tone="error">{tasksError}</SettingsNotice> : null}

      {tasksStatus === "loading" ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : filtered.length === 0 ? (
        <SettingsListEmptyState>{t("benchmark.empty_tasks")}</SettingsListEmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-dls-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 w-8 bg-background">
                  <Checkbox
                    checked={allFilteredSelected}
                    onCheckedChange={() => {
                      if (allFilteredSelected) {
                        clearTaskSelection();
                      } else {
                        setTaskSelection([...selectedTaskIds, ...filtered.map((task) => task.id)]);
                      }
                    }}
                  />
                </TableHead>
                <TableHead className="sticky left-8 z-10 min-w-72 bg-background">
                  {t("benchmark.column_task")}
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
              {filtered.map((task) => {
                const resultsByModel = new Map(task.latestResults.map((result) => [modelKey(result), result]));
                return (
                  <TableRow key={task.id}>
                    <TableCell className="sticky left-0 z-10 bg-background">
                      <Checkbox
                        checked={selectedSet.has(task.id)}
                        onCheckedChange={() => toggleTaskSelection(task.id)}
                      />
                    </TableCell>
                    <TableCell className="sticky left-8 z-10 max-w-96 cursor-pointer bg-background" onClick={() => props.onOpenTask(task)}>
                      <div className="truncate text-[13px] font-medium" title={task.title}>
                        {task.title}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                          {workTypeLabel(task.workType)}
                        </Badge>
                        {task.source === "custom" ? (
                          <Badge className="px-1.5 py-0 text-[10px]">{t("benchmark.custom_badge")}</Badge>
                        ) : null}
                        {task.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="truncate text-[11px] text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    {modelColumns.map((model) => (
                      <TableCell key={modelKey(model)} className="text-center">
                        <ResultCell result={resultsByModel.get(modelKey(model))} />
                      </TableCell>
                    ))}
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => void deleteTask(task.id)}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmModal
        open={confirmDelete}
        variant="danger"
        title={t("benchmark.delete_tasks_title")}
        message={t("benchmark.delete_tasks_message", { count: selectedTaskIds.length })}
        confirmLabel={t("benchmark.delete_tasks")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteTasks(selectedTaskIds);
        }}
      />
    </div>
  );
}
