/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatFileSize } from "@/lib/utils";
import type { BenchmarkTaskDocument } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemContent,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings/settings-layout";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { resolvePathOpenTarget } from "../session/artifacts/open-target";
import { LEARNINGS_PANEL_SESSION_ID, usePanelTabStore } from "../session/panel/panel-tab-store";
import { criteriaScoreLabel, criteriaScoreToneClass, isItemActive, itemStatusBadge, workTypeLabel } from "./format";
import { useBenchmarkStore } from "./store";

export type TaskDetailScreenProps = {
  taskId: string;
  onBack: () => void;
};

export function TaskDetailScreen(props: TaskDetailScreenProps) {
  const tasks = useBenchmarkStore((state) => state.tasks);
  const tasksStatus = useBenchmarkStore((state) => state.tasksStatus);
  const refreshTasks = useBenchmarkStore((state) => state.refreshTasks);
  const deleteTask = useBenchmarkStore((state) => state.deleteTask);
  const documents = useBenchmarkStore((state) => state.taskDocuments[props.taskId]);
  const documentsLoading = useBenchmarkStore((state) => state.taskDocumentsLoading === props.taskId);
  const loadTaskDocuments = useBenchmarkStore((state) => state.loadTaskDocuments);

  useEffect(() => {
    if (!tasks.length) void refreshTasks();
  }, [tasks.length, refreshTasks]);

  useEffect(() => {
    void loadTaskDocuments(props.taskId);
  }, [props.taskId, loadTaskDocuments]);

  const task = tasks.find((entry) => entry.id === props.taskId) ?? null;

  // Documents open in the app's right side panel (the normal file viewer).
  const openDocument = (doc: BenchmarkTaskDocument) => {
    const targets = (documents ?? [])
      .map((entry) => resolvePathOpenTarget(entry.relativePath, [], "benchmark task document"))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    usePanelTabStore.getState().syncTranscriptArtifacts(LEARNINGS_PANEL_SESSION_ID, targets);
    const target = targets.find((entry) => entry.value === doc.relativePath) ?? targets[0];
    if (target) {
      window.dispatchEvent(new CustomEvent("legalwork-open-accessible-target", { detail: target }));
    }
  };

  return (
    <LayoutStack className="max-w-6xl">
      <LayoutSection>
        {tasksStatus === "loading" && !task ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Spinner />
          </div>
        ) : null}
        {tasksStatus === "ready" && !task ? (
          <SettingsNotice tone="error">{t("benchmark.task_not_found")}</SettingsNotice>
        ) : null}

        {task ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5 px-1">
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                {workTypeLabel(task.workType)}
              </Badge>
              {task.source === "custom" ? (
                <Badge className="px-1.5 py-0 text-[10px]">{t("benchmark.custom_badge")}</Badge>
              ) : (
                <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                  Legal Agent Benchmark
                </Badge>
              )}
              {task.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="px-1.5 py-0 text-[10px]">
                  {tag}
                </Badge>
              ))}
              <span className="ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void deleteTask(task.id).then(() => props.onBack());
                  }}
                >
                  <Trash2 size={13} />
                  {t("common.remove")}
                </Button>
              </span>
            </div>

            <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>{t("benchmark.form_instructions")}</LayoutSectionItemTitle>
              </LayoutSectionItemHeader>
              <LayoutSectionItemContent>
                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{task.instructions}</p>
                {task.deliverables.length ? (
                  <div className="mt-3">
                    <div className="text-[12px] font-medium text-muted-foreground">
                      {t("benchmark.deliverables_title")}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {task.deliverables.map((name) => (
                        <li key={name} className="font-mono text-[12px]">
                          {name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </LayoutSectionItemContent>
            </LayoutSectionItem>

            {documentsLoading || (documents && documents.length > 0) ? (
              <LayoutSectionItem>
                <LayoutSectionItemHeader>
                  <LayoutSectionItemTitle>{t("benchmark.form_documents")}</LayoutSectionItemTitle>
                </LayoutSectionItemHeader>
                <LayoutSectionItemContent>
                  {documentsLoading && !documents ? (
                    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                      <Spinner />
                      <span className="text-[12px]">{t("benchmark.documents_staging")}</span>
                    </div>
                  ) : (
                    <ul className="space-y-0.5">
                      {(documents ?? []).map((doc) => (
                        <li key={doc.relativePath}>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-dls-hover"
                            onClick={() => openDocument(doc)}
                          >
                            <FileText size={13} className="shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{doc.name}</span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {formatFileSize(doc.size)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </LayoutSectionItemContent>
              </LayoutSectionItem>
            ) : null}

            {task.latestResults.length ? (
              <LayoutSectionItem>
                <LayoutSectionItemHeader>
                  <LayoutSectionItemTitle>{t("benchmark.latest_results")}</LayoutSectionItemTitle>
                </LayoutSectionItemHeader>
                <LayoutSectionItemContent>
                  <ul className="space-y-1.5">
                    {task.latestResults.map((result) => (
                      <li
                        key={`${result.providerID}/${result.modelID}`}
                        className="flex items-center gap-2 text-[13px]"
                      >
                        <ProviderIcon providerId={result.providerID} size={14} />
                        <span className="font-medium">{result.modelID}</span>
                        {isItemActive(result.status) ? (
                          <Spinner />
                        ) : (
                          <span
                            className={
                              result.nPassed !== null && result.nCriteria !== null
                                ? `font-medium ${criteriaScoreToneClass(result.nPassed, result.nCriteria)}`
                                : "text-muted-foreground"
                            }
                          >
                            {result.nPassed !== null && result.nCriteria !== null
                              ? criteriaScoreLabel(result.nPassed, result.nCriteria)
                              : "—"}
                          </span>
                        )}
                        <span className="text-[12px] text-muted-foreground">
                          {itemStatusBadge(result.status).label} · {new Date(result.runCreatedAt).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </LayoutSectionItemContent>
              </LayoutSectionItem>
            ) : null}

            <LayoutSectionItem>
              <LayoutSectionItemHeader>
                <LayoutSectionItemTitle>
                  {t("benchmark.form_criteria")} ({task.criteria.length})
                </LayoutSectionItemTitle>
              </LayoutSectionItemHeader>
              <LayoutSectionItemContent>
                <ul className="space-y-2">
                  {task.criteria.map((criterion) => (
                    <li key={criterion.id} className="rounded-xl border border-dls-border p-2.5">
                      <div className="text-[12px] font-medium">
                        {criterion.id}: {criterion.title}
                      </div>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                        {criterion.matchCriteria}
                      </p>
                    </li>
                  ))}
                </ul>
              </LayoutSectionItemContent>
            </LayoutSectionItem>
          </>
        ) : null}
      </LayoutSection>
    </LayoutStack>
  );
}
