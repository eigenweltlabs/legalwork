/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { FileText, Pencil, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { formatFileSize } from "@/lib/utils";
import type { BenchmarkTaskDocument } from "../../../app/lib/benchmark-types";
import { ProviderIcon } from "../../design-system/provider-icon";
import { LayoutStack } from "../settings/settings-layout";
import { SettingsNotice, Spinner } from "../settings/settings-section";
import { resolvePathOpenTarget } from "../session/artifacts/open-target";
import { LEARNINGS_PANEL_SESSION_ID, usePanelTabStore } from "../session/panel/panel-tab-store";
import { criteriaScoreLabel, criteriaScoreToneClass, isItemActive, itemStatusBadge, workTypeLabel } from "./format";
import { useBenchmarkStore } from "./store";
import { TaskFormModal } from "./task-form-modal";

export type TaskDetailScreenProps = {
  taskId: string;
  onBack: () => void;
};

/** A titled content card used to group the task's sections. */
function DetailCard({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-dls-border bg-background">
      <header className="flex items-baseline gap-2 border-b border-dls-border px-5 py-3">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {meta ? <span className="text-[12px] text-muted-foreground">{meta}</span> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function TaskDetailScreen(props: TaskDetailScreenProps) {
  const tasks = useBenchmarkStore((state) => state.tasks);
  const tasksStatus = useBenchmarkStore((state) => state.tasksStatus);
  const refreshTasks = useBenchmarkStore((state) => state.refreshTasks);
  const deleteTask = useBenchmarkStore((state) => state.deleteTask);
  const documents = useBenchmarkStore((state) => state.taskDocuments[props.taskId]);
  const documentsLoading = useBenchmarkStore((state) => state.taskDocumentsLoading === props.taskId);
  const loadTaskDocuments = useBenchmarkStore((state) => state.loadTaskDocuments);
  const [editOpen, setEditOpen] = useState(false);

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
    <LayoutStack className="max-w-4xl">
      {tasksStatus === "loading" && !task ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
          <Spinner />
        </div>
      ) : null}
      {tasksStatus === "ready" && !task ? (
        <SettingsNotice tone="error">{t("benchmark.task_not_found")}</SettingsNotice>
      ) : null}

      {task ? (
        <div className="flex flex-col gap-4">
          {/* Header */}
          <div className="rounded-2xl border border-dls-border bg-background p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-[19px] font-semibold leading-snug text-foreground">{task.title}</h1>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
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
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {task.source === "custom" ? (
                  <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil size={13} />
                    {t("common.edit")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-11 hover:text-red-11"
                  onClick={() => {
                    void deleteTask(task.id).then(() => props.onBack());
                  }}
                >
                  <Trash2 size={13} />
                  {t("common.remove")}
                </Button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span>{t("benchmark.criteria_meta", { count: task.criteria.length })}</span>
              {task.deliverables.length ? (
                <span>{t("benchmark.deliverables_meta", { count: task.deliverables.length })}</span>
              ) : null}
              {documents && documents.length ? (
                <span>{t("benchmark.doc_count", { count: documents.length })}</span>
              ) : null}
            </div>
          </div>

          {/* Instructions + deliverables */}
          <DetailCard title={t("benchmark.form_instructions")}>
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{task.instructions}</p>
            {task.deliverables.length ? (
              <div className="mt-4 border-t border-dls-border pt-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("benchmark.deliverables_title")}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {task.deliverables.map((name) => (
                    <span
                      key={name}
                      className="rounded-md border border-dls-border bg-dls-hover px-2 py-0.5 font-mono text-[12px]"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </DetailCard>

          {/* Input documents */}
          {documentsLoading || (documents && documents.length > 0) ? (
            <DetailCard
              title={t("benchmark.form_documents")}
              meta={documents && documents.length ? String(documents.length) : undefined}
            >
              {documentsLoading && !documents ? (
                <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                  <Spinner />
                  <span className="text-[12px]">{t("benchmark.documents_staging")}</span>
                </div>
              ) : (
                <ul className="-mx-2 flex flex-col">
                  {(documents ?? []).map((doc) => (
                    <li key={doc.relativePath}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-dls-hover"
                        onClick={() => openDocument(doc)}
                      >
                        <FileText size={14} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{doc.name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{formatFileSize(doc.size)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </DetailCard>
          ) : null}

          {/* Latest results */}
          {task.latestResults.length ? (
            <DetailCard title={t("benchmark.latest_results")}>
              <ul className="flex flex-col gap-2">
                {task.latestResults.map((result) => (
                  <li key={`${result.providerID}/${result.modelID}`} className="flex items-center gap-2 text-[13px]">
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
            </DetailCard>
          ) : null}

          {/* Pass/fail criteria */}
          <DetailCard title={t("benchmark.form_criteria")} meta={String(task.criteria.length)}>
            <ul className="divide-y divide-dls-border">
              {task.criteria.map((criterion) => (
                <li key={criterion.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="text-[13px] font-medium text-foreground">
                    <span className="font-mono text-[11px] text-muted-foreground">{criterion.id}</span> {criterion.title}
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{criterion.matchCriteria}</p>
                </li>
              ))}
            </ul>
          </DetailCard>

          <TaskFormModal open={editOpen} onOpenChange={setEditOpen} task={task} />
        </div>
      ) : null}
    </LayoutStack>
  );
}
