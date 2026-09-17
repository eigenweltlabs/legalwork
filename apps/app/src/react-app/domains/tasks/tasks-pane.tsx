/** @jsxImportSource react */
/**
 * Tasks — the firm's work list on this machine.
 *
 * An inbox, so it reads like one: the queue on the left, the open task on the
 * right, and the list stays put while a legal assistant works down it. Below
 * 880 px of pane width the two stack, list first, with a way back. Status,
 * including the trash, is one selector alongside the other filter chips.
 *
 * Tasks live in the LegalWork server's own store, so the pane works with no
 * Eigenwelt account: tasks are filed, edited, annotated and trashed here. A
 * connected firm additionally gets what arrived at its intake addresses, and
 * everything is synced with the firm's account in the background. The user is
 * not asked to care about that: a connection problem explains that local work
 * remains safe, and the refresh button quietly runs another round.
 *
 * Deliberately small otherwise: no sub-tasks, labels, cycles, saved views or
 * drag ordering; this is a queue to work through, not a project tracker.
 *
 * The surface is global (there is no workspace-scoped route) because tasks
 * are the machine's while workspaces are folders on it. A folder only enters
 * the picture when a task is actually run locally.
 */
import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownWideNarrow,
  AtSign,
  CloudOff,
  ListFilter,
  Loader2,
  Plus,
  RefreshCw,
  Tags,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  LegalworkTask,
  LegalworkTaskAttachment,
  LegalworkTaskStatus,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import type { ModelRef } from "@/app/types";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import {
  StartWorkflowDialog,
  type StartTaskMode,
  type StartWorkflowSelection,
} from "./start-workflow-dialog";
import { importViewerFile } from "@/react-app/domains/session/panel/import-viewer-file";
import { storageFileDragToFile } from "@/app/lib/storage-file-drag";
import { requestPanelTab } from "@/react-app/domains/session/panel/panel-tab-store";
import { NewTaskDialog } from "./new-task-dialog";
import { startTaskWorkflow } from "./start-workflow";
import { TaskDetail } from "./task-detail";
import { TASK_STATUSES, taskMemberOptions, taskStatusLabel } from "./task-format";
import { OptionText } from "./task-glyphs";
import { TaskList, type TaskListGroup } from "./task-list";
import { useTaskRunStore, type TaskLocalRun } from "./task-run-store";
import {
  flattenTaskPages,
  useCreateTask,
  useDeleteTask,
  useDeleteTaskAttachment,
  useRestoreTask,
  useRunTaskSync,
  useTask,
  useTaskAccess,
  useTaskMembers,
  useTaskSyncStatus,
  useTaskTags,
  useTasks,
  useUpdateTask,
  useUploadTaskAttachments,
  type TaskQuery,
} from "./tasks-queries";

/** Filter values that stand for "no filter" — Select needs a real value. */
const ANY = "__any__";
const ASSIGNEE_ME = "__me__";

type SortKey = "created" | "updated" | "due" | "priority";
type StatusTab = "all" | Extract<LegalworkTaskStatus, "open" | "in_progress" | "done">;
type StatusFilter = StatusTab | "trash";

export type TasksPaneProps = {
  /** The local LegalWork server, which holds the task store (and the firm connection). */
  client: LegalworkServerClient | null;
  /** Transport only: which server instance the call goes to. */
  workspaceId: string;
  /** Local server handle, used to reach the folder a run happens in. */
  baseUrl: string;
  token: string;
  /** Folders offered as a local run target. */
  workspaces: RouteWorkspace[];
  /** Model a seeded run uses, mirroring what a normal chat send would pick. */
  defaultModel: ModelRef | null;
  /** Reveal a local run's session in the chat view. */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /**
   * A task to show, asked for from outside (a task notification, see
   * tasks-pane-request.ts); a null id shows the list. `at` makes a repeat
   * ask distinct.
   */
  openTask?: { id: string | null; at: number } | null;
};

export function TasksPane(props: TasksPaneProps) {
  const context = { client: props.client, workspaceId: props.workspaceId };
  const access = useTaskAccess(context);

  const [view, setView] = useState<"tasks" | "trash">("tasks");
  const [assignee, setAssignee] = useState(ANY);
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [endpointId, setEndpointId] = useState(ANY);
  const [tag, setTag] = useState(ANY);
  const [sort, setSort] = useState<SortKey>("created");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<StartTaskMode | null>(null);
  const [starting, setStarting] = useState(false);
  const [creating, setCreating] = useState(false);
  const inTrash = view === "trash";

  const openTask = props.openTask;
  useEffect(() => {
    if (!openTask) return;
    setView("tasks");
    setSelectedTaskId(openTask.id);
  }, [openTask]);

  const query = useMemo<TaskQuery>(() => {
    const resolvedAssignee =
      assignee === ANY ? undefined : assignee === ASSIGNEE_ME ? access.accountUserId ?? undefined : assignee;
    return {
      ...(resolvedAssignee ? { assignee: resolvedAssignee } : {}),
      ...(statusTab === "all" || inTrash ? {} : { status: statusTab }),
      ...(endpointId === ANY ? {} : { endpointId }),
      ...(tag === ANY ? {} : { tag }),
      ...(inTrash ? { deleted: "only" as const } : {}),
      sort: inTrash ? "updated" : sort,
      // Created and updated read newest-first. Due dates read soonest-first,
      // and priority carries its own documented order in the store.
      ...((sort === "priority" || sort === "due") && !inTrash ? {} : { order: "desc" as const }),
    };
  }, [access.accountUserId, assignee, endpointId, inTrash, sort, statusTab, tag]);

  const tasksQuery = useTasks(context, query);
  const membersQuery = useTaskMembers(context);
  const tagsQuery = useTaskTags(context);
  const syncQuery = useTaskSyncStatus(context);
  const detailQuery = useTask(context, selectedTaskId);
  const runSync = useRunTaskSync(context);
  const createTask = useCreateTask(context);
  const updateTask = useUpdateTask(context);
  const deleteTask = useDeleteTask(context);
  const restoreTask = useRestoreTask(context);
  const uploadAttachments = useUploadTaskAttachments(context);
  const deleteAttachment = useDeleteTaskAttachment(context);

  const tasks = flattenTaskPages(tasksQuery.data?.pages);
  const members = membersQuery.data ?? [];
  const tags = tagsQuery.data ?? [];
  const recordRun = useTaskRunStore((state) => state.recordRun);

  /**
   * Endpoint administration is browser-session-only on the platform, so the
   * server exposes no endpoint list. The filter offers the endpoints actually
   * present in the loaded tasks, which is what a member can act on anyway —
   * and it only appears once an intake task is here at all.
   */
  const endpointOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const task of tasks) if (task.endpointId) byId.set(task.endpointId, task.endpointName ?? t("tasks.origin_intake"));
    return [...byId.entries()].map(([id, name]) => ({ value: id, label: name }));
  }, [tasks]);

  // "All" keeps the queue legible by sectioning it: what needs attention on
  // top, finished work at the bottom, in the chosen order within each.
  const groups = useMemo<TaskListGroup[] | null>(() => {
    if (statusTab !== "all" || inTrash) return null;
    return TASK_STATUSES.map((status) => ({
      status,
      tasks: tasks.filter((task) => task.status === status),
    })).filter((group) => group.tasks.length > 0);
  }, [inTrash, statusTab, tasks]);

  // Open the detail from the row already in hand so the click is instant; the
  // fetch only adds the submission, the history and any field changed meanwhile.
  const selectedTask =
    detailQuery.data?.task ?? tasks.find((task) => task.id === selectedTaskId) ?? null;
  const filtered = assignee !== ANY || endpointId !== ANY || tag !== ANY || statusTab !== "all";
  const syncing = runSync.isPending;
  const refreshing = syncing || (tasksQuery.isFetching && !tasksQuery.isFetchingNextPage);
  const busy = deleteTask.isPending || restoreTask.isPending || starting;
  // Sync trouble never blocks the local store. Keep service details out of the
  // interface and tell the user what matters: their tasks remain usable.
  const syncError = syncQuery.data?.connected ? syncQuery.data.error : null;
  // Signed out after being signed in: the firm's tasks are in its account,
  // not gone — the empty list says so rather than looking like a fresh start.
  const emptyHint =
    syncQuery.data && !syncQuery.data.connected && syncQuery.data.signedOut ? t("tasks.empty_signed_out_body") : null;

  const clearFilters = () => {
    setAssignee(ANY);
    setEndpointId(ANY);
    setTag(ANY);
    setStatusTab("all");
    setView("tasks");
  };

  const switchView = (next: "tasks" | "trash") => {
    setView(next);
    setSelectedTaskId(null);
  };

  const refresh = () => {
    // A connected firm gets a real round trip; otherwise the store is re-read.
    if (syncQuery.data?.connected) {
      runSync.mutate(undefined, {
        onError: () => toast.info(t("tasks.sync_unavailable"), { description: t("tasks.sync_unavailable_detail") }),
      });
      return;
    }
    void tasksQuery.refetch();
    // The open task reads its own query first, so a list-only refresh would
    // leave it showing what it had.
    if (selectedTaskId) void detailQuery.refetch();
  };

  const create = (input: Parameters<typeof createTask.mutate>[0]) => {
    createTask.mutate(input, {
      onSuccess: (task) => {
        setCreating(false);
        if (inTrash) switchView("tasks");
        setSelectedTaskId(task.id);
      },
      onError: (error) => toast.error(t("tasks.create_failed"), { description: error instanceof Error ? error.message : undefined }),
    });
  };

  const remove = (task: LegalworkTask) => {
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        setSelectedTaskId(null);
        toast.success(t("tasks.deleted_toast"));
      },
      onError: (error) => toast.error(t("tasks.delete_failed"), { description: error instanceof Error ? error.message : undefined }),
    });
  };

  const restore = (task: LegalworkTask) => {
    restoreTask.mutate(task.id, {
      onSuccess: () => switchView("tasks"),
      onError: (error) => toast.error(t("tasks.restore_failed"), { description: error instanceof Error ? error.message : undefined }),
    });
  };

  const downloadAttachment = async (task: LegalworkTask, attachment: LegalworkTaskAttachment) => {
    if (!props.client) return;
    const file = await props.client.downloadTaskAttachment(props.workspaceId, task.id, attachment.id);
    const url = URL.createObjectURL(new Blob([file.data], { type: attachment.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  /**
   * Show an attachment in the side panel. The viewers read workspace files, so
   * the bytes become a working copy under .legalwork/tmp/ in the folder the app
   * is on (the same copy a file dropped on the panel gets), then the page opens
   * it in the matching viewer.
   */
  const openAttachment = async (task: LegalworkTask, attachment: LegalworkTaskAttachment) => {
    if (!props.client || !props.workspaceId) throw new Error(t("side_panel.wait_for_workspace"));
    const file = await props.client.downloadTaskAttachment(props.workspaceId, task.id, attachment.id);
    const copy = new File([file.data], attachment.filename, { type: attachment.contentType });
    requestPanelTab(await importViewerFile(props.client, props.workspaceId, copy));
  };

  const startRun = async (task: LegalworkTask, selection: StartWorkflowSelection) => {
    if (!props.client) return;
    setStarting(true);
    try {
      const result = await startTaskWorkflow({
        relay: { client: props.client, workspaceId: props.workspaceId },
        task,
        workspace: selection.workspace,
        baseUrl: props.baseUrl,
        token: props.token,
        workflowName: selection.workflowName,
        model: props.defaultModel,
      });
      const run: TaskLocalRun = {
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        startedAt: Date.now(),
        workflowName: selection.workflowName,
        taskTitle: task.title,
      };
      recordRun(task.id, run);
      setStartMode(null);
      void tasksQuery.refetch();
      void detailQuery.refetch();
      props.onOpenSession(run.workspaceId, run.sessionId);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(selection.workflowName ? "tasks.run_failed" : "tasks.session_failed"),
      );
    } finally {
      setStarting(false);
    }
  };

  const statusFilter: StatusFilter = inTrash ? "trash" : statusTab;
  const countLabel = tasksQuery.data && tasks.length
    ? tasksQuery.hasNextPage
      ? t("tasks.count_more", { count: tasks.length })
      : t("tasks.count", { count: tasks.length })
    : null;
  const showingDetail = selectedTask !== null;

  return (
    // The list has the whole pane until a task is opened. Then the pane splits
    // at 880 px of its own width (a container query, not the window: side
    // panels can take the rest) — list beside detail — and below that the
    // detail takes over. task-detail.tsx uses the same breakpoint to swap its
    // back arrow for a close cross.
    <div className="@container/tasks flex h-full min-h-0 flex-1">
      <section
        aria-label={t(inTrash ? "tasks.trash" : "tasks.title")}
        className={cn(
          "min-h-0 w-full flex-col",
          showingDetail
            ? "hidden @min-[880px]/tasks:flex @min-[880px]/tasks:w-[340px] @min-[880px]/tasks:shrink-0 @min-[880px]/tasks:border-e @min-[880px]/tasks:border-border @min-[1200px]/tasks:w-[380px]"
            : "flex",
        )}
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-border px-4 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <h1 className="text-[15px] font-medium leading-6 tracking-[-0.02em] text-foreground">{t(inTrash ? "tasks.trash" : "tasks.title")}</h1>
            {countLabel ? <span className="text-xs tabular-nums text-muted-foreground">{countLabel}</span> : null}
            <div className="ms-auto flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("tasks.new_task")}
                      disabled={!props.client}
                      onClick={() => setCreating(true)}
                    />
                  }
                >
                  <Plus />
                </TooltipTrigger>
                <TooltipContent>{t("tasks.new_task")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("tasks.refresh")}
                      aria-busy={refreshing}
                      disabled={syncing}
                      onClick={refresh}
                    />
                  }
                >
                  {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw className={cn(refreshing && "animate-spin")} />}
                </TooltipTrigger>
                <TooltipContent>{t("tasks.refresh")}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              icon={ListFilter}
              label={t("tasks.column_status")}
              value={statusFilter}
              onChange={(value) => {
                if (value === "trash") {
                  switchView("trash");
                  return;
                }
                if (value === "all" || value === "open" || value === "in_progress" || value === "done") {
                  setView("tasks");
                  setStatusTab(value);
                  setSelectedTaskId(null);
                }
              }}
              options={[
                { value: "all", label: t("tasks.status_all") },
                { value: "open", label: taskStatusLabel("open") },
                { value: "in_progress", label: taskStatusLabel("in_progress") },
                { value: "done", label: taskStatusLabel("done") },
                { value: "trash", label: t("tasks.trash") },
              ]}
            />
            {inTrash ? null : (
              <>
                {members.length > 0 || access.accountUserId ? (
                  <FilterChip
                    icon={UserRound}
                    label={t("tasks.column_assignee")}
                    value={assignee}
                    onChange={setAssignee}
                    options={[
                      { value: ANY, label: t("tasks.assignee_anyone") },
                      ...(access.accountUserId ? [{ value: ASSIGNEE_ME, label: t("tasks.assignee_me") }] : []),
                      ...taskMemberOptions(members),
                    ]}
                  />
                ) : null}
                {endpointOptions.length > 0 || endpointId !== ANY ? (
                  <FilterChip
                    icon={AtSign}
                    label={t("tasks.column_endpoint")}
                    value={endpointId}
                    onChange={setEndpointId}
                    options={[{ value: ANY, label: t("tasks.endpoint_any") }, ...endpointOptions]}
                  />
                ) : null}
                {tags.length > 0 || tag !== ANY ? (
                  <FilterChip
                    icon={Tags}
                    label={t("tasks.tags")}
                    value={tag}
                    onChange={setTag}
                    options={[
                      { value: ANY, label: t("tasks.tags_any") },
                      ...tags.map((entry) => ({ value: entry, label: entry })),
                    ]}
                  />
                ) : null}
                <FilterChip
                  icon={ArrowDownWideNarrow}
                  compact
                  label={t("tasks.sort_label")}
                  value={sort}
                  onChange={(value) => {
                    if (value === "created" || value === "updated" || value === "due" || value === "priority") setSort(value);
                  }}
                  options={[
                    { value: "created", label: t("tasks.sort_created") },
                    { value: "updated", label: t("tasks.sort_updated") },
                    { value: "due", label: t("tasks.sort_due") },
                    { value: "priority", label: t("tasks.sort_priority") },
                  ]}
                />
              </>
            )}
          </div>
          {syncError ? (
            <p role="status" className="flex items-start gap-2 rounded-lg bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
              <CloudOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span><strong className="font-medium text-foreground">{t("tasks.sync_unavailable")}</strong> {t("tasks.sync_unavailable_detail")}</span>
            </p>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskList
            tasks={tasks}
            groups={groups}
            selectedTaskId={selectedTaskId}
            accountUserId={access.accountUserId}
            loading={tasksQuery.isLoading}
            error={
              tasksQuery.error
                ? tasksQuery.error instanceof Error
                  ? tasksQuery.error.message
                  : t("tasks.load_failed")
                : null
            }
            filtered={filtered}
            trash={inTrash}
            emptyHint={emptyHint}
            hasNextPage={Boolean(tasksQuery.hasNextPage)}
            fetchingNextPage={tasksQuery.isFetchingNextPage}
            onSelect={setSelectedTaskId}
            onStartSession={(task) => {
              setSelectedTaskId(task.id);
              setStartMode("session");
            }}
            onStartWorkflow={(task) => {
              setSelectedTaskId(task.id);
              setStartMode("workflow");
            }}
            members={members}
            tagSuggestions={tags}
            onPatch={(task, patch) => {
              updateTask.mutate(
                { taskId: task.id, patch },
                { onError: (error) => toast.error(t("tasks.update_failed"), { description: error instanceof Error ? error.message : undefined }) },
              );
            }}
            onDelete={remove}
            onRestore={restore}
            busy={busy}
            onLoadMore={() => void tasksQuery.fetchNextPage()}
            onRetry={() => void tasksQuery.refetch()}
            onClearFilters={clearFilters}
          />
        </div>
      </section>

      {selectedTask ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TaskDetail
            key={selectedTask.id}
            task={selectedTask}
            submission={detailQuery.data?.submission}
            notes={detailQuery.data?.notes ?? []}
            submissionPending={detailQuery.isLoading}
            members={members}
            tagSuggestions={tags}
            busy={busy}
            accountUserId={access.accountUserId}
            onBack={() => setSelectedTaskId(null)}
            onPatch={(patch) => updateTask.mutateAsync({ taskId: selectedTask.id, patch })}
            onDelete={() => remove(selectedTask)}
            onRestore={() => restore(selectedTask)}
            onStartWorkflow={() => setStartMode("workflow")}
            onStartSession={() => setStartMode("session")}
            onOpenSession={(link) => props.onOpenSession(link.workspaceId, link.sessionId)}
            onDownloadAttachment={(attachment) => downloadAttachment(selectedTask, attachment)}
            onOpenAttachment={(attachment) => openAttachment(selectedTask, attachment)}
            onUploadAttachments={(files) => uploadAttachments.mutateAsync({ taskId: selectedTask.id, files })}
            onUploadStorageAttachment={async (storageFile) => {
              if (!props.client) throw new Error(t("tasks.upload_failed"));
              const file = await storageFileDragToFile(props.client, props.workspaceId, storageFile);
              return uploadAttachments.mutateAsync({ taskId: selectedTask.id, files: [file] });
            }}
            onRemoveAttachment={(attachment) => deleteAttachment.mutateAsync({ taskId: selectedTask.id, attachmentId: attachment.id })}
          />
        </section>
      ) : null}

      {selectedTask ? (
        <StartWorkflowDialog
          mode={startMode}
          taskTitle={selectedTask.title}
          onClose={() => setStartMode(null)}
          workspaces={props.workspaces}
          defaultWorkspaceId={props.workspaceId}
          baseUrl={props.baseUrl}
          token={props.token}
          busy={starting}
          onStart={(selection) => void startRun(selectedTask, selection)}
        />
      ) : null}

      {creating ? (
        <NewTaskDialog
          open
          busy={createTask.isPending}
          connected={Boolean(syncQuery.data?.connected ?? access.connected)}
          members={members}
          tagSuggestions={tags}
          onClose={() => setCreating(false)}
          onCreate={create}
        />
      ) : null}
    </div>
  );
}

/** A filter as a chip: its icon says which, its value says what. */
function FilterChip(props: {
  icon: LucideIcon;
  compact?: boolean;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; primary?: string; detail?: string }>;
  onChange: (value: string) => void;
}) {
  const Icon = props.icon;
  return (
    <Select value={props.value} items={props.options} onValueChange={(value) => props.onChange(value ?? "")}>
      <SelectTrigger
        size="sm"
        aria-label={props.label}
        title={props.options.find((option) => option.value === props.value)?.label}
        className="h-7 min-w-0 max-w-full gap-1.5 rounded-lg border-transparent bg-transparent px-2 text-xs text-foreground hover:bg-muted/60 data-[size=sm]:h-7"
      >
        <Icon aria-hidden className="size-3.5 text-muted-foreground" />
        <SelectValue className={props.compact ? "sr-only" : "min-w-0 truncate"} />
      </SelectTrigger>
      {/* As wide as the entries need rather than as the chip, which may only
          say "All". */}
      <SelectContent align="start" className="w-auto min-w-(--anchor-width) max-w-80">
        <SelectGroup>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <OptionText primary={option.primary ?? option.label} detail={option.detail} />
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
