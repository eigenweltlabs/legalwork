/** @jsxImportSource react */
/**
 * The queue itself: rows a legal assistant scans, selects and works through.
 *
 * Rows are buttons in a plain list, not a table. The column is narrow in the
 * split layout, and a row carries what a reader needs to choose (title, where
 * it came from, who has it, when it is due), not a grid of columns to compare.
 * The arrow keys move the selection so a queue can be walked without the mouse.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArchiveRestore, CalendarClock, Cloud, CloudOff, Inbox, Loader2, MessageSquarePlus, PanelRightOpen, Paperclip, Play, Tags, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { LegalworkTask, LegalworkTaskMember, LegalworkTaskPatch, LegalworkTaskStatus } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatTaskDate, formatTaskDueDate, priorityForKey, TASK_PRIORITIES, TASK_STATUSES, taskDueDateInputValue, taskDueTone, taskMemberOptions, taskPriorityLabel, taskStatusLabel } from "./task-format";
import { AssigneeMark, OptionText, PriorityMark, StatusGlyph, SyncMark } from "./task-glyphs";

export type TaskListGroup = { status: LegalworkTaskStatus; tasks: LegalworkTask[] };

export type TaskListProps = {
  tasks: LegalworkTask[];
  /** Sections by status (the "All" view); null renders the flat list. */
  groups: TaskListGroup[] | null;
  selectedTaskId: string | null;
  /** Clerk user id of the signed-in member, so their own rows read "You". */
  accountUserId: string | null;
  loading: boolean;
  error: string | null;
  /** A filter narrows the list, so an empty result is "no match", not "nothing here". */
  filtered: boolean;
  /** The trash: rows carry their deletion date and the empty state says so. */
  trash: boolean;
  /** Replaces the empty state's text when there is a reason the list is empty
   *  (the firm's tasks left with a sign-out). */
  emptyHint?: string | null;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  onSelect: (taskId: string) => void;
  onStartSession: (task: LegalworkTask) => void;
  onStartWorkflow: (task: LegalworkTask) => void;
  members: LegalworkTaskMember[];
  tagSuggestions: string[];
  onPatch: (task: LegalworkTask, patch: LegalworkTaskPatch) => void;
  onDelete: (task: LegalworkTask) => void;
  onRestore: (task: LegalworkTask) => void;
  busy: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  onClearFilters: () => void;
};

export function TaskList(props: TaskListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Arrow keys walk the rows in visual order and select as they go.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-task-row]") ?? []);
    if (!rows.length) return;
    const focused = rows.findIndex((row) => row === document.activeElement);
    const current = focused >= 0 ? focused : rows.findIndex((row) => row.dataset.taskRow === props.selectedTaskId);
    const next = event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
    const row = rows[next];
    if (!row?.dataset.taskRow) return;
    event.preventDefault();
    row.focus();
    props.onSelect(row.dataset.taskRow);
  };

  if (props.loading) {
    return (
      <div aria-busy className="flex flex-col gap-1 px-3 py-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 px-3 py-3">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (props.error) {
    return (
      <Empty variant="ghost" className="mx-auto max-w-sm py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert />
          </EmptyMedia>
          <EmptyTitle>{t("tasks.load_failed")}</EmptyTitle>
          <EmptyDescription>{props.error}</EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          {t("tasks.retry")}
        </Button>
      </Empty>
    );
  }

  if (props.tasks.length === 0) {
    const title = props.trash
      ? t("tasks.trash_empty_title")
      : t(props.filtered ? "tasks.empty_filtered_title" : "tasks.empty_title");
    const signedOut = !props.trash && !props.filtered && Boolean(props.emptyHint);
    const body = props.trash
      ? t("tasks.trash_empty_body")
      : signedOut
        ? props.emptyHint
        : t(props.filtered ? "tasks.empty_filtered_body" : "tasks.empty_body");
    return (
      <Empty variant="ghost" className="mx-auto max-w-sm py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">{props.trash ? <Trash2 /> : signedOut ? <CloudOff /> : <Inbox />}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{body}</EmptyDescription>
        </EmptyHeader>
        {props.filtered && !props.trash ? (
          <Button variant="outline" size="sm" onClick={props.onClearFilters}>
            {t("tasks.clear_filters")}
          </Button>
        ) : null}
      </Empty>
    );
  }

  const row = (task: LegalworkTask) => (
    <TaskRow
      key={task.id}
      task={task}
      selected={task.id === props.selectedTaskId}
      accountUserId={props.accountUserId}
      onSelect={props.onSelect}
      onStartSession={props.onStartSession}
      onStartWorkflow={props.onStartWorkflow}
      members={props.members}
      tagSuggestions={props.tagSuggestions}
      onPatch={props.onPatch}
      onDelete={props.onDelete}
      onRestore={props.onRestore}
      busy={props.busy}
    />
  );

  return (
    <div ref={listRef} role="list" aria-label={t(props.trash ? "tasks.trash" : "tasks.title")} className="flex flex-col gap-0.5 px-2 py-2" onKeyDown={onKeyDown}>
      {props.groups
        ? props.groups.map((group) => (
            <div key={group.status} role="presentation" className="flex flex-col">
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-background/95 px-3 pb-1.5 pt-3 text-[11px] font-medium text-muted-foreground backdrop-blur-sm">
                <span>{taskStatusLabel(group.status)}</span>
                <span className="tabular-nums text-muted-foreground/70">{group.tasks.length}</span>
              </div>
              {group.tasks.map(row)}
            </div>
          ))
        : props.tasks.map(row)}

      {props.hasNextPage ? (
        <div className="flex justify-center pt-3">
          <Button variant="outline" size="sm" disabled={props.fetchingNextPage} aria-busy={props.fetchingNextPage} onClick={props.onLoadMore}>
            {props.fetchingNextPage ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("tasks.load_more")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Where a row came from: the intake address it arrived at, or this app. */
export function taskOriginLabel(task: Pick<LegalworkTask, "origin" | "endpointName">): string {
  if (task.origin === "intake") return task.endpointName || t("tasks.origin_intake");
  return t("tasks.origin_desktop");
}

function TaskRowMenu(props: {
  task: LegalworkTask;
  children: ReactNode;
  busy: boolean;
  members: LegalworkTaskMember[];
  tagSuggestions: string[];
  onOpen: () => void;
  onStartSession: () => void;
  onStartWorkflow: () => void;
  onPatch: (patch: LegalworkTaskPatch) => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const inTrash = props.task.deletedAt !== null;
  const memberOptions = taskMemberOptions(props.members);
  if (props.task.assigneeUserId && !memberOptions.some((option) => option.value === props.task.assigneeUserId)) {
    const label = props.task.assigneeName ?? props.task.assigneeUserId;
    memberOptions.push({ value: props.task.assigneeUserId, label, primary: label });
  }
  const showAssignee = props.members.length > 0 || Boolean(props.task.assigneeUserId);
  const currentAssignee = props.task.assigneeName ?? memberOptions.find((option) => option.value === props.task.assigneeUserId)?.primary ?? null;
  const tagOptions = Array.from(new Set([...props.tagSuggestions, ...props.task.tags])).sort((left, right) => left.localeCompare(right));
  const dueDates = taskDueDatePresets();
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger render={<div role="listitem" />}>{props.children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onClick={props.onOpen}>
          <PanelRightOpen />
          {t("tasks.notify_open_task")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {inTrash ? (
          <ContextMenuItem disabled={props.busy} onClick={props.onRestore}>
            <ArchiveRestore />
            {t("tasks.restore")}
          </ContextMenuItem>
        ) : (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <StatusGlyph status={props.task.status} />
                {t("tasks.column_status")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent
                className="w-56"
                onKeyDown={(event) => {
                  const priority = priorityForKey(event);
                  if (priority === null) return;
                  event.preventDefault();
                  props.onPatch({ priority });
                  setOpen(false);
                }}
              >
                <ContextMenuRadioGroup value={props.task.status}>
                  {TASK_STATUSES.map((status) => (
                    <ContextMenuRadioItem key={status} value={status} onClick={() => props.onPatch({ status })}>
                      <StatusGlyph status={status} />
                      {taskStatusLabel(status)}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <PriorityMark priority={props.task.priority} />
                {t("tasks.field_priority")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-56">
                <ContextMenuRadioGroup value={String(props.task.priority)}>
                  {TASK_PRIORITIES.map((priority) => (
                    <ContextMenuRadioItem key={priority} value={String(priority)} onClick={() => props.onPatch({ priority })}>
                      <PriorityMark priority={priority} />
                      {taskPriorityLabel(priority)}
                      <ContextMenuShortcut>{priority}</ContextMenuShortcut>
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {showAssignee ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <AssigneeMark name={currentAssignee} />
                  {t("tasks.column_assignee")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-72">
                  <ContextMenuRadioGroup value={props.task.assigneeUserId ?? ""}>
                    <ContextMenuRadioItem value="" onClick={() => props.onPatch({ assigneeUserId: null })}>
                      <AssigneeMark name={null} />
                      {t("tasks.unassigned")}
                    </ContextMenuRadioItem>
                    {memberOptions.map((option) => (
                      <ContextMenuRadioItem key={option.value} value={option.value} onClick={() => props.onPatch({ assigneeUserId: option.value })}>
                        <AssigneeMark name={option.primary} />
                        <OptionText primary={option.primary} detail={option.detail} />
                      </ContextMenuRadioItem>
                    ))}
                  </ContextMenuRadioGroup>
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <CalendarClock />
                {t("tasks.field_due")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-56">
                <ContextMenuRadioGroup value={taskDueDateInputValue(props.task.dueDate)}>
                  {dueDates.map((option) => (
                    <ContextMenuRadioItem key={option.value} value={option.value} onClick={() => props.onPatch({ dueDate: option.value })}>
                      <CalendarClock />
                      {option.label}
                    </ContextMenuRadioItem>
                  ))}
                  <ContextMenuSeparator />
                  <ContextMenuRadioItem value="" onClick={() => props.onPatch({ dueDate: null })}>
                    <CalendarClock />
                    {t("tasks.due_none")}
                  </ContextMenuRadioItem>
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {tagOptions.length > 0 ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Tags />
                  {t("tasks.tags")}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-64">
                  {tagOptions.map((tag) => {
                    const checked = props.task.tags.includes(tag);
                    return (
                      <ContextMenuCheckboxItem
                        key={tag}
                        checked={checked}
                        onClick={() => props.onPatch({ tags: checked ? props.task.tags.filter((entry) => entry !== tag) : [...props.task.tags, tag] })}
                      >
                        <Tags />
                        <span className="truncate">{tag}</span>
                      </ContextMenuCheckboxItem>
                    );
                  })}
                </ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem disabled={props.busy} onClick={props.onStartSession}>
              <MessageSquarePlus />
              {t("tasks.start_session")}
            </ContextMenuItem>
            {props.task.cloudRunId ? null : (
              <ContextMenuItem disabled={props.busy} onClick={props.onStartWorkflow}>
                <Play />
                {t("tasks.start_workflow")}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem disabled={props.busy} variant="destructive" onClick={props.onDelete}>
              <Trash2 />
              {t("tasks.delete")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TaskRow(props: {
  task: LegalworkTask;
  selected: boolean;
  accountUserId: string | null;
  members: LegalworkTaskMember[];
  tagSuggestions: string[];
  onSelect: (taskId: string) => void;
  onStartSession: (task: LegalworkTask) => void;
  onStartWorkflow: (task: LegalworkTask) => void;
  onPatch: (task: LegalworkTask, patch: LegalworkTaskPatch) => void;
  onDelete: (task: LegalworkTask) => void;
  onRestore: (task: LegalworkTask) => void;
  busy: boolean;
}) {
  const { task } = props;
  const assignee = !task.assigneeUserId
    ? t("tasks.unassigned")
    : props.accountUserId && task.assigneeUserId === props.accountUserId
      ? t("tasks.assignee_you")
      : (task.assigneeName ?? t("tasks.unassigned"));
  const dueTone = task.status === "done" || task.status === "cancelled" ? "later" : taskDueTone(task.dueDate);

  return (
    <TaskRowMenu
      task={task}
      busy={props.busy}
      members={props.members}
      tagSuggestions={props.tagSuggestions}
      onOpen={() => props.onSelect(task.id)}
      onStartSession={() => props.onStartSession(task)}
      onStartWorkflow={() => props.onStartWorkflow(task)}
      onPatch={(patch) => props.onPatch(task, patch)}
      onDelete={() => props.onDelete(task)}
      onRestore={() => props.onRestore(task)}
    >
      <button
        type="button"
        data-task-row={task.id}
        aria-current={props.selected ? "true" : undefined}
        className={cn(
          "lw-sidebar-item flex w-full flex-col gap-1 rounded-lg px-3 py-3 text-start outline-none",
          "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/30",
          props.selected && "bg-muted hover:bg-muted",
        )}
        onClick={() => props.onSelect(task.id)}
      >
        <span className="flex items-start gap-2">
          <span className="shrink-0 pt-0.5" title={taskStatusLabel(task.status)}><StatusGlyph status={task.status} className="size-4" /><span className="sr-only">{taskStatusLabel(task.status)}</span></span>
          <span className="min-w-0 flex-1 line-clamp-2 text-[13px] font-medium leading-5 text-foreground">{task.title}</span>
          {task.priority !== 0 ? <PriorityMark priority={task.priority} className="mt-0.5 shrink-0" /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 ps-6 text-xs text-muted-foreground">
          {task.deletedAt ? (
            <span className="truncate">{t("tasks.deleted_on", { date: formatTaskDate(task.deletedAt) })}</span>
          ) : (
            <>
              {task.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="max-w-24 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-foreground/80">
                  {tag}
                </span>
              ))}
              {task.tags.length ? <span aria-hidden className="text-muted-foreground/50">·</span> : null}
              <span className="truncate">{taskOriginLabel(task)}</span>
              <span aria-hidden className="text-muted-foreground/50">·</span>
              <span className={cn("truncate", !task.assigneeUserId && "text-muted-foreground/70")}>{assignee}</span>
            </>
          )}
          <span className="ms-auto flex shrink-0 items-center gap-2 ps-2">
            {task.dueDate ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 tabular-nums",
                  dueTone === "overdue" && "font-medium text-red-9",
                  dueTone === "today" && "font-medium text-amber-9",
                )}
                title={t("tasks.due_label", { date: formatTaskDueDate(task.dueDate) })}
              >
                <CalendarClock aria-hidden className="size-3" />
                {formatTaskDueDate(task.dueDate)}
              </span>
            ) : null}
            {task.attachments.length ? (
              <span
                className="inline-flex items-center gap-0.5 tabular-nums"
                aria-label={t("tasks.attachments_count", { count: task.attachments.length })}
              >
                <Paperclip aria-hidden className="size-3" />
                {task.attachments.length}
              </span>
            ) : null}
            {task.cloudRunId ? (
              <Cloud aria-label={t("tasks.cloud_run_running")} className="size-3" />
            ) : task.lastLocalRunAt ? (
              <Play aria-label={t("tasks.last_local_run")} className="size-3" />
            ) : null}
            <SyncMark sync={task.sync} />
          </span>
        </span>
      </button>
    </TaskRowMenu>
  );
}

function taskDueDatePresets(now: Date = new Date()): Array<{ value: string; label: string }> {
  const dateOn = (daysFromToday: number) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  };
  const weekday = now.getDay();
  const endOfWeek = weekday <= 5 ? 5 - weekday : 12 - weekday;
  const nextWeek = weekday === 0 ? 1 : 8 - weekday;
  const presets = [
    { value: dateOn(0), label: t("tasks.due_preset_today") },
    { value: dateOn(1), label: t("tasks.due_preset_tomorrow") },
    { value: dateOn(endOfWeek), label: t("tasks.due_preset_end_of_week") },
    { value: dateOn(nextWeek), label: t("tasks.due_preset_next_week") },
  ];
  return presets.filter((preset, index) => presets.findIndex((other) => other.value === preset.value) === index);
}
