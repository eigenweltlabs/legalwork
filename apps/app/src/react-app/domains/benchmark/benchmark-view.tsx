/** @jsxImportSource react */
import { useEffect, useState } from "react";

import { t } from "@/i18n";
import type { LegalworkServerClient } from "../../../app/lib/legalwork-server";
import type { ProviderListItem } from "../../../app/types";
import { HubTabs, type HubTab } from "../settings/segmented-tabs";
import { attachBenchmarkContext, useBenchmarkStore } from "./store";
import { AnalyticsView } from "./analytics-view";
import { BenchmarkOnboardingModal } from "./onboarding-modal";
import { ImportTasksModal } from "./import-tasks-modal";
import { ItemDetailScreen } from "./item-detail-screen";
import { RunDetail } from "./run-detail";
import { RunTable } from "./run-table";
import { SessionTranscriptScreen } from "./session-transcript-screen";
import { StartRunModal } from "./start-run-modal";
import { TaskDetailScreen } from "./task-detail-screen";
import { TaskFormModal } from "./task-form-modal";
import { TaskTable } from "./task-table";

type EvalTab = "tasks" | "runs" | "models";

export type BenchmarkViewProps = {
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  runId: string | null;
  taskId: string | null;
  itemId: string | null;
  itemChat: boolean;
  /** Page heading, for when the view is the whole page (the Evals tab) rather than a settings tab. */
  showHeader?: boolean;
  onOpenRun: (runId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenRunItem: (runId: string, itemId: string) => void;
  onOpenRunItemChat: (runId: string, itemId: string) => void;
  onBackToList: () => void;
};

export function BenchmarkView(props: BenchmarkViewProps) {
  const [tab, setTab] = useState<EvalTab>(props.runId ? "runs" : "tasks");
  const [importOpen, setImportOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [startRunOpen, setStartRunOpen] = useState(false);
  const refreshTasks = useBenchmarkStore((state) => state.refreshTasks);
  const tabs: ReadonlyArray<HubTab<EvalTab>> = [
    { id: "tasks", label: t("benchmark.tab_tasks") },
    { id: "runs", label: t("benchmark.tab_runs") },
    { id: "models", label: t("benchmark.tab_models") },
  ];

  useEffect(() => {
    attachBenchmarkContext(props.legalworkClient, props.workspaceId);
    void refreshTasks();
  }, [props.legalworkClient, props.workspaceId, refreshTasks]);

  useEffect(() => {
    if (props.runId) setTab("runs");
  }, [props.runId]);

  if (props.runId && props.itemId && props.itemChat) {
    const runId = props.runId;
    return (
      <SessionTranscriptScreen runId={runId} itemId={props.itemId} onBack={() => props.onOpenRun(runId)} />
    );
  }
  if (props.runId && props.itemId) {
    const runId = props.runId;
    const itemId = props.itemId;
    return (
      <ItemDetailScreen runId={runId} itemId={itemId} onOpenChat={() => props.onOpenRunItemChat(runId, itemId)} />
    );
  }
  if (props.runId) {
    const runId = props.runId;
    return (
      <RunDetail
        runId={runId}
        onBackToList={props.onBackToList}
        onOpenItemSession={(itemId) => props.onOpenRunItem(runId, itemId)}
      />
    );
  }
  if (props.taskId) {
    return <TaskDetailScreen taskId={props.taskId} onBack={props.onBackToList} />;
  }

  return (
    <>
      {props.showHeader ? (
        <div className="w-full max-w-5xl space-y-3 pb-6">
          <span className="lw-section-eyebrow uppercase text-dls-secondary">Model quality</span>
          <h2 className="text-[34px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("settings.tab_benchmark")}
          </h2>
          <p className="max-w-xl text-[14px] leading-[1.65] text-dls-secondary">
            {t("settings.tab_description_benchmark")}
          </p>
        </div>
      ) : null}
      <div className="flex w-full max-w-5xl flex-col">
        <HubTabs items={tabs} value={tab} onChange={setTab} />
        {/* Matches the space-y-7 gap Integrations and Workflows leave under their tab row. */}
        <div className="w-full pt-7">
          {tab === "tasks" ? (
            <TaskTable
              onOpenTask={(task) => props.onOpenTask(task.id)}
              onImport={() => setImportOpen(true)}
              onNewTask={() => setTaskFormOpen(true)}
              onStartRun={() => setStartRunOpen(true)}
            />
          ) : null}
          {tab === "runs" ? <RunTable onOpenRun={props.onOpenRun} /> : null}
          {tab === "models" ? <AnalyticsView /> : null}
        </div>
      </div>

      <BenchmarkOnboardingModal onImport={() => setImportOpen(true)} />
      <ImportTasksModal open={importOpen} onOpenChange={setImportOpen} />
      <TaskFormModal open={taskFormOpen} onOpenChange={setTaskFormOpen} />
      <StartRunModal
        open={startRunOpen}
        onOpenChange={setStartRunOpen}
        providers={props.providers}
        providerConnectedIds={props.providerConnectedIds}
        onRunCreated={(runId) => {
          setStartRunOpen(false);
          props.onOpenRun(runId);
        }}
      />
    </>
  );
}
