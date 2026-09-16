/** @jsxImportSource react */
/**
 * The queue itself: rows a legal assistant scans, selects and works through.
 *
 * Rows are buttons in a plain list, not a table. The column is narrow in the
 * split layout, and a row carries what a reader needs to choose (title, where
 * it came from, who has it, when it is due), not a grid of columns to compare.
 * The arrow keys move the selection so a queue can be walked without the mouse.
 */
import { useRef, type KeyboardEvent } from "react";
import { CalendarClock, Cloud, CloudOff, Inbox, Loader2, Paperclip, Play, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { LegalworkTask, LegalworkTaskStatus } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatTaskDate, formatTaskDueDate, taskDueTone, taskStatusLabel } from "./task-format";
import { PriorityMark, StatusGlyph, SyncMark } from "./task-glyphs";

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

function TaskRow(props: {
  task: LegalworkTask;
  selected: boolean;
  accountUserId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const { task } = props;
  const assignee = !task.assigneeUserId
    ? t("tasks.unassigned")
    : props.accountUserId && task.assigneeUserId === props.accountUserId
      ? t("tasks.assignee_you")
      : (task.assigneeName ?? t("tasks.unassigned"));
  const dueTone = task.status === "done" || task.status === "cancelled" ? "later" : taskDueTone(task.dueDate);

  return (
    <div role="listitem">
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
    </div>
  );
}
