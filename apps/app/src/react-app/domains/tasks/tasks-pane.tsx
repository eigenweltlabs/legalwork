/** @jsxImportSource react */
/**
 * Tasks — the firm's shared intake inbox.
 *
 * Deliberately small: rows, three filters, one sort, one grouping toggle. No
 * sub-tasks, labels, cycles, saved views or drag ordering; intake is a queue a
 * legal assistant works through, not a project tracker.
 *
 * The surface is global (there is no workspace-scoped route) because intake is
 * org-level while workspaces are folders on this machine. A folder only enters
 * the picture when a task is actually run locally.
 */
import { useMemo, useState } from "react";
import { Inbox, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { openDesktopUrl } from "@/app/lib/desktop";
import {
  EIGENWELT_INTAKE_NOT_ENTITLED,
  LegalworkServerError,
  type EigenweltIntakeAttachment,
  type EigenweltIntakeTask,
  type EigenweltIntakeTaskStatus,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import type { ModelRef } from "@/app/types";
import { t } from "@/i18n";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { StartWorkflowDialog, type StartWorkflowSelection } from "./start-workflow-dialog";
import { startTaskWorkflow } from "./start-workflow";
import { TaskDetail } from "./task-detail";
import {
  INTAKE_TASK_STATUSES,
  formatIntakeDate,
  intakePriorityToneClass,
  intakeStatusLabel,
} from "./task-format";
import { useTaskRunStore, type IntakeTaskLocalRun } from "./task-run-store";
import {
  flattenIntakeTaskPages,
  useIntakeAccess,
  useIntakeMembers,
  useIntakeTask,
  useIntakeTasks,
  useUpdateIntakeTask,
  type IntakeTaskQuery,
} from "./tasks-queries";

/** Filter values that stand for "no filter" — Select needs a real value. */
const ANY = "__any__";
const ASSIGNEE_ME = "__me__";

type SortKey = "created" | "updated" | "priority";

function isNotEntitled(error: unknown): boolean {
  return error instanceof LegalworkServerError && error.code === EIGENWELT_INTAKE_NOT_ENTITLED;
}

export type TasksPaneProps = {
  /** Relay client — the local LegalWork server that holds the firm connection. */
  client: LegalworkServerClient | null;
  /** Transport only: which stored firm connection relays the call. */
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
};

export function TasksPane(props: TasksPaneProps) {
  const context = { client: props.client, workspaceId: props.workspaceId };
  const access = useIntakeAccess(context);

  const [assignee, setAssignee] = useState(ANY);
  const [status, setStatus] = useState(ANY);
  const [endpointId, setEndpointId] = useState(ANY);
  const [sort, setSort] = useState<SortKey>("created");
  const [groupByStatus, setGroupByStatus] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const query = useMemo<IntakeTaskQuery>(() => {
    const resolvedAssignee =
      assignee === ANY ? undefined : assignee === ASSIGNEE_ME ? access.accountUserId ?? undefined : assignee;
    const resolvedStatus = INTAKE_TASK_STATUSES.find((entry) => entry === status);
    return {
      ...(resolvedAssignee ? { assignee: resolvedAssignee } : {}),
      ...(resolvedStatus ? { status: resolvedStatus } : {}),
      ...(endpointId === ANY ? {} : { endpointId }),
      sort,
      // Dates read newest-first; priority carries its own documented order
      // (Urgent first, None last), so it is left to the platform.
      ...(sort === "priority" ? {} : { order: "desc" as const }),
    };
  }, [access.accountUserId, assignee, endpointId, sort, status]);

  const tasksQuery = useIntakeTasks(context, query, access.entitled);
  const membersQuery = useIntakeMembers(context, access.entitled);
  const detailQuery = useIntakeTask(context, selectedTaskId);
  const updateTask = useUpdateIntakeTask(context);

  const tasks = flattenIntakeTaskPages(tasksQuery.data?.pages);
  const members = membersQuery.data ?? [];
  const recordRun = useTaskRunStore((state) => state.recordRun);
  const runsByTaskId = useTaskRunStore((state) => state.runsByTaskId);

  /**
   * Endpoint administration is browser-session-only on the platform, so the
   * relay exposes no endpoint list. The filter offers the endpoints actually
   * present in the loaded tasks, which is what a member can act on anyway.
   */
  const endpointOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const task of tasks) byId.set(task.endpointId, task.endpointName);
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  }, [tasks]);

  const grouped = useMemo(() => {
    if (!groupByStatus) return null;
    return INTAKE_TASK_STATUSES.map((entry) => ({
      status: entry,
      tasks: tasks.filter((task) => task.status === entry),
    })).filter((group) => group.tasks.length > 0);
  }, [groupByStatus, tasks]);

  // Open the detail from the row already in hand so the click is instant; the
  // fetch only adds the submission and any field a colleague changed meanwhile.
  const selectedTask =
    detailQuery.data?.task ?? tasks.find((task) => task.id === selectedTaskId) ?? null;
  const notEntitled = !access.entitled || isNotEntitled(tasksQuery.error);

  const downloadAttachment = async (task: EigenweltIntakeTask, attachment: EigenweltIntakeAttachment) => {
    if (!props.client) return;
    const file = await props.client.intakeDownloadAttachment(props.workspaceId, task.id, attachment.id);
    const url = URL.createObjectURL(new Blob([file.data], { type: attachment.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const runWorkflow = async (task: EigenweltIntakeTask, selection: StartWorkflowSelection) => {
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
      const run: IntakeTaskLocalRun = {
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        startedAt: Date.now(),
        workflowName: selection.workflowName,
      };
      recordRun(task.id, run);
      setStartOpen(false);
      void tasksQuery.refetch();
      void detailQuery.refetch();
      props.onOpenSession(run.workspaceId, run.sessionId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("tasks.run_failed"));
    } finally {
      setStarting(false);
    }
  };

  if (access.loading && !access.connected) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notEntitled) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{t("tasks.upsell_title")}</EmptyTitle>
            <EmptyDescription>{t("tasks.upsell_body")}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => void openDesktopUrl(access.billingUrl)}>
            {t("tasks.upsell_action")}
          </Button>
        </Empty>
      </div>
    );
  }

  if (selectedTask) {
    return (
      <>
        <TaskDetail
          task={selectedTask}
          submission={detailQuery.data?.submission}
          submissionPending={detailQuery.isLoading}
          members={members}
          localRun={runsByTaskId[selectedTask.id] ?? null}
          busy={updateTask.isPending || starting}
          onBack={() => setSelectedTaskId(null)}
          onStatusChange={(next) =>
            updateTask.mutate({ taskId: selectedTask.id, patch: { status: next } })
          }
          onAssigneeChange={(userId) =>
            updateTask.mutate({ taskId: selectedTask.id, patch: { assigneeUserId: userId } })
          }
          onStartWorkflow={() => setStartOpen(true)}
          onOpenLocalRun={(run) => props.onOpenSession(run.workspaceId, run.sessionId)}
          onDownloadAttachment={(attachment) => downloadAttachment(selectedTask, attachment)}
        />
        <StartWorkflowDialog
          open={startOpen}
          onOpenChange={setStartOpen}
          workspaces={props.workspaces}
          defaultWorkspaceId={props.workspaceId}
          baseUrl={props.baseUrl}
          token={props.token}
          busy={starting}
          onStart={(selection) => void runWorkflow(selectedTask, selection)}
        />
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-6 py-3">
        <div className="mr-auto flex flex-col gap-0.5">
          <h1 className="text-[17px] font-medium tracking-[-0.02em]">{t("tasks.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("tasks.subtitle")}</p>
        </div>

        <FilterSelect
          label={t("tasks.column_assignee")}
          value={assignee}
          onChange={setAssignee}
          width="w-48"
          options={[
            { value: ANY, label: t("tasks.assignee_anyone") },
            ...(access.accountUserId ? [{ value: ASSIGNEE_ME, label: t("tasks.assignee_me") }] : []),
            ...members.map((member) => ({
              value: member.userId,
              label: member.name ?? member.email ?? member.userId,
            })),
          ]}
        />
        <FilterSelect
          label={t("tasks.column_status")}
          value={status}
          onChange={setStatus}
          width="w-40"
          options={[
            { value: ANY, label: t("tasks.status_any") },
            ...INTAKE_TASK_STATUSES.map((entry) => ({ value: entry, label: intakeStatusLabel(entry) })),
          ]}
        />
        <FilterSelect
          label={t("tasks.column_endpoint")}
          value={endpointId}
          onChange={setEndpointId}
          width="w-48"
          options={[
            { value: ANY, label: t("tasks.endpoint_any") },
            ...endpointOptions.map((option) => ({ value: option.id, label: option.name })),
          ]}
        />
        <FilterSelect
          label={t("tasks.sort_label")}
          value={sort}
          onChange={(value) => {
            if (value === "created" || value === "updated" || value === "priority") setSort(value);
          }}
          width="w-40"
          options={[
            { value: "created", label: t("tasks.sort_created") },
            { value: "updated", label: t("tasks.sort_updated") },
            { value: "priority", label: t("tasks.sort_priority") },
          ]}
        />
        <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <Switch size="sm" checked={groupByStatus} onCheckedChange={setGroupByStatus} />
          {t("tasks.group_by_status")}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tasksQuery.isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : tasksQuery.error ? (
          <p className="px-6 py-8 text-sm text-destructive">
            {tasksQuery.error instanceof Error ? tasksQuery.error.message : t("tasks.load_failed")}
          </p>
        ) : tasks.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>{t("tasks.empty_title")}</EmptyTitle>
              <EmptyDescription>{t("tasks.empty_body")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tasks.column_title")}</TableHead>
                <TableHead className="w-40">{t("tasks.column_endpoint")}</TableHead>
                <TableHead className="w-44">{t("tasks.column_assignee")}</TableHead>
                <TableHead className="w-36">{t("tasks.column_status")}</TableHead>
                <TableHead className="w-28">{t("tasks.column_created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grouped
                ? grouped.map((group) => (
                    <TaskGroup
                      key={group.status}
                      status={group.status}
                      tasks={group.tasks}
                      onSelect={setSelectedTaskId}
                    />
                  ))
                : tasks.map((task) => (
                    <TaskRow key={task.id} task={task} onSelect={setSelectedTaskId} />
                  ))}
            </TableBody>
          </Table>
        )}

        {tasksQuery.hasNextPage ? (
          <div className="flex justify-center py-4">
            <Button
              variant="outline"
              size="sm"
              disabled={tasksQuery.isFetchingNextPage}
              onClick={() => void tasksQuery.fetchNextPage()}
            >
              {tasksQuery.isFetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("tasks.load_more")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  width: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-muted-foreground">{props.label}</Label>
      <Select value={props.value} items={props.options} onValueChange={(value) => props.onChange(value ?? "")}>
        <SelectTrigger size="sm" className={props.width} aria-label={props.label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function TaskGroup(props: {
  status: EigenweltIntakeTaskStatus;
  tasks: EigenweltIntakeTask[];
  onSelect: (taskId: string) => void;
}) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={5} className="bg-muted/40 py-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          {intakeStatusLabel(props.status)} · {props.tasks.length}
        </TableCell>
      </TableRow>
      {props.tasks.map((task) => (
        <TaskRow key={task.id} task={task} onSelect={props.onSelect} />
      ))}
    </>
  );
}

function TaskRow(props: { task: EigenweltIntakeTask; onSelect: (taskId: string) => void }) {
  const { task } = props;
  return (
    <TableRow
      className="cursor-pointer"
      tabIndex={0}
      role="button"
      onClick={() => props.onSelect(task.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onSelect(task.id);
      }}
    >
      <TableCell className="max-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {/* The priority sort is otherwise invisible: this dot is what makes
              "sort by priority" legible without adding a whole column. */}
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${intakePriorityToneClass(task.priority)}`}
          />
          <span className="truncate font-medium">{task.title}</span>
        </div>
      </TableCell>
      <TableCell className="truncate text-muted-foreground">{task.endpointName}</TableCell>
      <TableCell className="truncate text-muted-foreground">
        {task.assigneeName ?? t("tasks.unassigned")}
      </TableCell>
      <TableCell className="text-muted-foreground">{intakeStatusLabel(task.status)}</TableCell>
      <TableCell className="tabular-nums text-muted-foreground">{formatIntakeDate(task.createdAt)}</TableCell>
    </TableRow>
  );
}
