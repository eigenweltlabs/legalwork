/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTodo, Loader2 } from "lucide-react";

import type { LegalworkTaskAttachment, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { storageFileDragToFile } from "@/app/lib/storage-file-drag";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { resolveWorkspaceEndpoint, workspaceServerId } from "@/app/lib/workspace-endpoint";
import { useWorkspace } from "@/react-app/shell/workspace-provider";
import { startTaskWorkflow } from "./start-workflow";
import { StartWorkflowDialog, type StartWorkflowSelection } from "./start-workflow-dialog";
import { useTaskRunStore } from "./task-run-store";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { importViewerFile } from "@/react-app/domains/session/panel/import-viewer-file";
import { type ArtifactPanelTab, type TaskPanelTab, usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store";
import { TaskDetail } from "./task-detail";
import {
  useDeleteTask,
  useDeleteTaskAttachment,
  useRestoreTask,
  useTask,
  useTaskAccess,
  useTaskMembers,
  useTaskTags,
  useResolveTaskConflict,
  useUpdateTask,
  useUploadTaskAttachments,
} from "./tasks-queries";

type TaskPanelProps = {
  projects?: { id: string; name: string }[];
  sessionId: string;
  tab: TaskPanelTab;
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  onClose: () => void;
};

export function TaskPanel(props: TaskPanelProps) {
  const onTitleChange = useCallback((title: string) => {
    if (title !== props.tab.label) usePanelTabStore.getState().openTab(props.sessionId, { ...props.tab, label: title });
  }, [props.sessionId, props.tab]);
  return <TaskContent {...props} taskId={props.tab.taskId} onTitleChange={onTitleChange}
    onOpenAttachment={tab => usePanelTabStore.getState().openTab(props.sessionId, tab)} />;
}

type TaskContentProps = Omit<TaskPanelProps, "sessionId" | "tab"> & {
  taskId: string;
  inDialog?: boolean;
  onTitleChange?: (title: string) => void;
  onOpenAttachment: (tab: ArtifactPanelTab) => void;
};

/** Shared task editor for the side panel and calendar dialog. */
export function TaskContent(props: TaskContentProps) {
  const sessionContext = useWorkspace();
  const [choosingProject, setChoosingProject] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const workspaceId = props.workspaceId ?? "";
  const context = { client: props.client, workspaceId };
  const detailQuery = useTask(context, props.taskId);
  const membersQuery = useTaskMembers(context);
  const tagsQuery = useTaskTags(context);
  const access = useTaskAccess(context);
  const updateTask = useUpdateTask(context);
  const resolveConflict = useResolveTaskConflict(context);
  const deleteTask = useDeleteTask(context);
  const restoreTask = useRestoreTask(context);
  const uploadAttachments = useUploadTaskAttachments(context);
  const deleteAttachment = useDeleteTaskAttachment(context);
  const task = detailQuery.data?.task ?? null;
  const title = task?.title;

  useEffect(() => {
    if (title !== undefined) props.onTitleChange?.(title);
  }, [props.onTitleChange, title]);

  if (!props.client || !workspaceId) {
    return <PanelEmptyState icon={<ListTodo />} title={t("tasks.load_failed")} description={t("side_panel.wait_for_workspace")} />;
  }

  if (detailQuery.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!task || detailQuery.isError) {
    return (
      <PanelEmptyState
        icon={<ListTodo />}
        title={t("tasks.load_failed")}
        description={detailQuery.error instanceof Error ? detailQuery.error.message : undefined}
      >
        <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
          {t("tasks.retry")}
        </Button>
      </PanelEmptyState>
    );
  }

  const client = props.client;
  const sessionProjects = sessionContext.workspaces.filter(workspace =>
    resolveWorkspaceEndpoint(workspace, sessionContext)?.baseUrl === client.baseUrl);
  const startSession = async (selection: StartWorkflowSelection) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      // Read again after inline edits have saved, including newly added files.
      const current = await client.getTask(workspaceId, task.id);
      const result = await startTaskWorkflow({
        relay: { client, workspaceId }, task: current.task, workspace: selection.workspace,
        baseUrl: sessionContext.baseUrl, token: sessionContext.token, workflowName: null, model: null,
      });
      useTaskRunStore.getState().recordRun(task.id, { ...result, startedAt: Date.now(), workflowName: null, taskTitle: current.task.title });
      props.onClose();
      sessionContext.onOpenSession(result.workspaceId, result.sessionId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("tasks.session_failed"));
    } finally { startingRef.current = false; setStarting(false); }
  };
  const requestSession = () => {
    if (!task.projectId) { setChoosingProject(true); return; }
    const workspace = sessionProjects.find(project => workspaceServerId(project) === task.projectId);
    if (!workspace) { toast.error(t("tasks.linked_project_unavailable")); return; }
    void startSession({ workspace, workflowName: null });
  };

  const downloadAttachment = async (attachment: LegalworkTaskAttachment) => {
    const file = await client.downloadTaskAttachment(workspaceId, task.id, attachment.id);
    const url = URL.createObjectURL(new Blob([file.data], { type: attachment.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const openAttachment = async (attachment: LegalworkTaskAttachment) => {
    const file = await client.downloadTaskAttachment(workspaceId, task.id, attachment.id);
    const copy = new File([file.data], attachment.filename, { type: attachment.contentType });
    const tab = await importViewerFile(client, workspaceId, copy);
    props.onOpenAttachment(tab);
  };

  const busy = deleteTask.isPending || restoreTask.isPending || starting;

  return (
    <><TaskDetail
      inPanel
      inDialog={props.inDialog}
      saving={updateTask.isPending || resolveConflict.isPending}
      projects={props.projects}
      task={task}
      submission={detailQuery.data?.submission}
      notes={detailQuery.data?.notes ?? []}
      submissionPending={detailQuery.isLoading}
      members={membersQuery.data ?? []}
      tagSuggestions={tagsQuery.data ?? []}
      busy={busy}
      accountUserId={access.accountUserId}
      onBack={props.onClose}
      onStartSession={requestSession}
      onOpenSession={link => { props.onClose(); sessionContext.onOpenSession(link.workspaceId, link.sessionId); }}
      onPatch={(patch) => updateTask.mutateAsync({ taskId: task.id, patch })}
      conflicts={detailQuery.data?.conflicts}
      onResolveConflict={(choice) => resolveConflict.mutateAsync({ taskId: task.id, choice })}
      onDelete={() => {
        deleteTask.mutate(task.id, {
          onSuccess: () => {
            toast.success(t("tasks.deleted_toast"));
            props.onClose();
          },
          onError: () => toast.error(t("tasks.delete_failed")),
        });
      }}
      onRestore={() =>
        restoreTask.mutate(task.id, {
          onError: () => toast.error(t("tasks.restore_failed")),
        })
      }
      onDownloadAttachment={downloadAttachment}
      onOpenAttachment={openAttachment}
      onUploadAttachments={(files) => uploadAttachments.mutateAsync({ taskId: task.id, files })}
      onUploadStorageAttachment={async (storageFile) => {
        const file = await storageFileDragToFile(client, workspaceId, storageFile);
        return uploadAttachments.mutateAsync({ taskId: task.id, files: [file] });
      }}
      onRemoveAttachment={(attachment) => deleteAttachment.mutateAsync({ taskId: task.id, attachmentId: attachment.id })}
    />
    <StartWorkflowDialog mode={choosingProject ? "session" : null} taskTitle={task.title}
      onClose={() => { if (!starting) setChoosingProject(false); }} workspaces={sessionProjects}
      defaultWorkspaceId={workspaceId} baseUrl={sessionContext.baseUrl} token={sessionContext.token}
      busy={starting} onStart={selection => void startSession(selection)} />
    </>
  );
}
