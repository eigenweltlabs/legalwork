/** @jsxImportSource react */
import { Fragment, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { BenchmarkModelRef, BenchmarkModelScore, BenchmarkRunItem } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { Spinner } from "../settings/settings-section";
import {
  criteriaScoreLabel,
  criteriaScoreTintClass,
  criteriaScoreToneClass,
  formatCellScore,
  isItemActive,
  workTypeLabel,
} from "./format";
import { useBenchmarkStore } from "./store";

export type ResultMatrixProps = {
  runId: string;
  items: BenchmarkRunItem[];
  models: BenchmarkModelRef[];
  selectedItemId: string | null;
  onSelectItem: (item: BenchmarkRunItem) => void;
  /** Per-model aggregates rendered as a totals row at the bottom of the table. */
  scoreByModel?: BenchmarkModelScore[];
  taskCount?: number;
};

type TaskRow = {
  taskKey: string;
  taskTitle: string;
  workType: string;
  vertical: string;
  itemsByModel: Map<string, BenchmarkRunItem>;
};

function modelKey(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

function buildRows(items: BenchmarkRunItem[]): TaskRow[] {
  const rows = new Map<string, TaskRow>();
  for (const item of items) {
    const row = rows.get(item.taskKey) ?? {
      taskKey: item.taskKey,
      taskTitle: item.taskTitle,
      workType: item.workType,
      vertical: item.vertical,
      itemsByModel: new Map<string, BenchmarkRunItem>(),
    };
    row.itemsByModel.set(modelKey(item), item);
    rows.set(item.taskKey, row);
  }
  return Array.from(rows.values());
}

function CellContent({ item }: { item: BenchmarkRunItem | undefined }) {
  if (!item) return <span className="text-muted-foreground">—</span>;
  if (isItemActive(item.status)) return <Spinner />;
  if (item.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-amber-11" title={item.error ?? undefined}>
        <AlertTriangle size={13} />
      </span>
    );
  }
  if (item.status === "aborted" || item.status === "interrupted") {
    return <span className="text-muted-foreground">{item.status === "aborted" ? "⊘" : "⏸"}</span>;
  }
  if (item.nCriteria === null || item.nPassed === null) {
    return <span className="text-muted-foreground">{formatCellScore(item)}</span>;
  }
  return (
    <span className={cn("font-medium tabular-nums", criteriaScoreToneClass(item.nPassed, item.nCriteria))}>
      {criteriaScoreLabel(item.nPassed, item.nCriteria)}
    </span>
  );
}

function VerdictMark({ verdict }: { verdict: "pass" | "fail" | "error" | undefined }) {
  if (verdict === "pass") return <Check size={14} className="inline text-green-11" />;
  if (verdict === "fail") return <X size={14} className="inline text-red-11" />;
  if (verdict === "error") return <AlertTriangle size={13} className="inline text-amber-11" />;
  return <span className="text-muted-foreground">—</span>;
}

export function ResultMatrix(props: ResultMatrixProps) {
  const rows = buildRows(props.items);
  const [expandedTaskKey, setExpandedTaskKey] = useState<string | null>(null);
  const [expandedCriterionId, setExpandedCriterionId] = useState<string | null>(null);
  const itemDetails = useBenchmarkStore((state) => state.itemDetails);
  const loadItemDetail = useBenchmarkStore((state) => state.loadItemDetail);

  const toggleExpanded = (row: TaskRow) => {
    const next = expandedTaskKey === row.taskKey ? null : row.taskKey;
    setExpandedTaskKey(next);
    setExpandedCriterionId(null);
    if (next) {
      for (const item of row.itemsByModel.values()) {
        void loadItemDetail(props.runId, item.id);
      }
    }
  };
  return (
    <div className="overflow-x-auto rounded-xl border border-dls-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 min-w-64 bg-background">Task</TableHead>
            {props.models.map((model) => (
              <TableHead key={modelKey(model)} className="min-w-32 text-center">
                <span className="inline-flex items-center gap-1.5">
                  <ProviderIcon providerId={model.providerID} size={13} />
                  {model.modelID}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const expanded = expandedTaskKey === row.taskKey;
            const rowItems = Array.from(row.itemsByModel.values());
            const criteria =
              rowItems.map((item) => itemDetails[item.id]?.task?.criteria).find((list) => list?.length) ?? null;
            return (
            <Fragment key={row.taskKey}>
            <TableRow>
              <TableCell
                className="sticky left-0 z-10 max-w-80 cursor-pointer bg-background"
                onClick={() => toggleExpanded(row)}
              >
                <div className="flex items-center gap-1 text-[13px] font-medium" title={row.taskTitle}>
                  {expanded ? (
                    <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{row.taskTitle}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    {workTypeLabel(row.workType)}
                  </Badge>
                  <span className="truncate text-[11px] text-muted-foreground">{row.vertical}</span>
                </div>
              </TableCell>
              {props.models.map((model) => {
                const item = row.itemsByModel.get(modelKey(model));
                const scored =
                  item && !isItemActive(item.status) && item.nPassed !== null && item.nCriteria !== null;
                return (
                  <TableCell
                    key={modelKey(model)}
                    className={cn(
                      "cursor-pointer text-center transition-colors hover:bg-dls-hover",
                      scored && criteriaScoreTintClass(item!.nPassed!, item!.nCriteria!),
                      item && item.id === props.selectedItemId && "bg-dls-hover",
                    )}
                    onClick={() => item && props.onSelectItem(item)}
                  >
                    <CellContent item={item} />
                  </TableCell>
                );
              })}
            </TableRow>
            {expanded
              ? (criteria ?? []).flatMap((criterion) => {
                  const criterionOpen = expandedCriterionId === criterion.id;
                  const rows = [
                    <TableRow key={`${row.taskKey}:${criterion.id}`} className="bg-dls-hover/40">
                      <TableCell
                        className="sticky left-0 z-10 max-w-80 cursor-pointer bg-background py-1.5 pl-8"
                        onClick={() => setExpandedCriterionId(criterionOpen ? null : criterion.id)}
                      >
                        <div className="flex items-center gap-1 text-[12px]">
                          {criterionOpen ? (
                            <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight size={11} className="shrink-0 text-muted-foreground" />
                          )}
                          <span className="font-mono text-[10px] text-muted-foreground">{criterion.id}</span>{" "}
                          <span className="truncate">{criterion.title}</span>
                        </div>
                      </TableCell>
                      {props.models.map((model) => {
                        const item = row.itemsByModel.get(modelKey(model));
                        const detail = item ? itemDetails[item.id] : undefined;
                        const verdict = detail?.verdicts.find((entry) => entry.criterionId === criterion.id);
                        return (
                          <TableCell key={modelKey(model)} className="py-1.5 text-center">
                            {item && !detail ? <Spinner /> : <VerdictMark verdict={verdict?.verdict} />}
                          </TableCell>
                        );
                      })}
                    </TableRow>,
                  ];
                  if (criterionOpen) {
                    rows.push(
                      <TableRow key={`${row.taskKey}:${criterion.id}:text`} className="bg-dls-hover/40">
                        <TableCell colSpan={props.models.length + 1} className="py-2 pl-12 pr-4">
                          <p className="max-w-3xl whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
                            {criterion.matchCriteria}
                          </p>
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  return rows;
                })
              : null}
            {expanded && !criteria ? (
              <TableRow>
                <TableCell className="sticky left-0 z-10 bg-background py-2 pl-8" colSpan={1}>
                  <Spinner />
                </TableCell>
              </TableRow>
            ) : null}
            </Fragment>
            );
          })}
          {props.scoreByModel?.length ? (
            <TableRow className="border-t-2 border-dls-border bg-muted hover:bg-muted">
              <TableCell className="sticky left-0 z-10 bg-muted py-2 text-[12px] font-semibold">
                Total
              </TableCell>
              {props.models.map((model) => {
                const score = props.scoreByModel?.find(
                  (entry) => entry.providerID === model.providerID && entry.modelID === model.modelID,
                );
                if (!score) {
                  return (
                    <TableCell key={modelKey(model)} className="py-2 text-center text-muted-foreground">
                      —
                    </TableCell>
                  );
                }
                const taskCount = props.taskCount ?? score.passed + score.failed + score.error;
                return (
                  <TableCell key={modelKey(model)} className="py-2 text-center">
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        criteriaScoreToneClass(Math.round((score.rubricPassRate ?? 0) * 100), 100),
                      )}
                      title={`${score.passed}/${taskCount} tasks fully passed`}
                    >
                      {score.rubricPassRate !== null
                        ? `${Math.round(score.rubricPassRate * 100)}% (${score.criteriaPassed}/${score.criteriaTotal})`
                        : criteriaScoreLabel(score.passed, taskCount)}
                      {score.error > 0 ? " ⚠" : ""}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
