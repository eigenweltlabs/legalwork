/** @jsxImportSource react */
/**
 * One task: what is asked, where it came from, its attachments, its history,
 * and the next action. The compact toolbar stays in view, so the action is
 * always in reach: open the run that already exists, or start one here.
 * Status, assignee, priority and due date are edited in place as property
 * chips; title and description are edited directly in place. What the platform's triage
 * wrote (the note, the original message) is read-only, and shown only for a
 * task that actually arrived by mail. Everything below the description —
 * attachments, sessions, history, the original message, details — is folded
 * when a task opens, so what is asked is the first and only thing in view.
 */
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import DOMPurify from "dompurify";
import {
  ArrowLeft,
  ArchiveRestore,
  Bot,
  CalendarClock,
  ChevronDown,
  Cloud,
  CloudDownload,
  Download,
  History,
  ListFilter,
  Loader2,
  Mail,
  MessageSquarePlus,
  Paperclip,
  Play,
  Plus,
  Sparkles,
  SquareArrowOutUpRight,
  Trash2,
  Tags,
  Webhook,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  LegalworkTask,
  LegalworkTaskAttachment,
  LegalworkTaskMember,
  LegalworkTaskNote,
  LegalworkTaskPatch,
  LegalworkTaskSessionLink,
} from "@/app/lib/legalwork-server";
import { hasStorageFileDrag, readStorageFileDrag, type StorageFileDragItem } from "@/app/lib/storage-file-drag";
import { writeTaskAttachmentDrag } from "@/app/lib/task-attachment-drag";
import { formatBytes } from "@/app/utils";
import { t } from "@/i18n";
import { getArtifactType } from "@/lib/artifacts";
import { cn } from "@/lib/utils";
import { DocumentIcon, type DocumentIconKind } from "@/react-app/design-system/document-icon";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  formatTaskDate,
  formatTaskDateTime,
  formatTaskDueDate,
  taskDueDateInputValue,
  taskDueTone,
  taskMemberOptions,
  taskPriorityLabel,
  taskStatusLabel,
} from "./task-format";
import { AssigneeMark, OptionText, PriorityMark, StatusGlyph, SyncMark } from "./task-glyphs";
import { taskOriginLabel } from "./task-list";
import { readTaskSubmission } from "./task-submission";
import { TaskTagInput } from "./task-tag-input";

/** The "unassigned" choice needs a non-empty Select value of its own. */
const UNASSIGNED = "__unassigned__";

/** How a linked session reads in the list: what kind of session, and when. */
function sessionLinkLabel(link: LegalworkTaskSessionLink): string {
  const date = formatTaskDateTime(link.startedAt);
  if (link.kind === "created") return t("tasks.session_filed_by_agent", { date });
  if (link.kind === "workflow" && link.workflowName) return t("tasks.local_run_workflow", { workflow: link.workflowName, date });
  return t("tasks.local_run_session", { date });
}

function SessionLinkIcon(props: { kind: LegalworkTaskSessionLink["kind"] }) {
  const className = "size-4 shrink-0 text-muted-foreground";
  if (props.kind === "created") return <Bot aria-hidden className={className} />;
  if (props.kind === "workflow") return <Play aria-hidden className={className} />;
  return <MessageSquarePlus aria-hidden className={className} />;
}

/**
 * Inbound mail is attacker-controlled: anyone who can reach the intake address
 * decides what this HTML says. It is sanitized before it is ever rendered, and
 * remote media is dropped as well so that merely opening a task cannot confirm
 * delivery back to the sender.
 */
function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "img", "picture", "source", "video", "audio", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style", "srcset", "background"],
  });
}

/** Attachments reuse the app's file assets, so a PDF looks like a PDF here too. */
function documentIconKind(filename: string): DocumentIconKind {
  const type = getArtifactType(filename);
  if (type === "document") return "word";
  if (type === "website") return "browser";
  return type;
}

/** A folded block of the task; every one starts closed, so a task opens on its ask alone. */
function Section(props: {
  title: string;
  children: ReactNode;
  icon: ReactNode;
  actions?: ReactNode;
  dropZone?: {
    active: boolean;
    label: string;
    onDragOver: (event: DragEvent<HTMLDetailsElement>) => void;
    onDragLeave: (event: DragEvent<HTMLDetailsElement>) => void;
    onDrop: (event: DragEvent<HTMLDetailsElement>) => void;
  };
}) {
  return (
    <details
      className={cn(
        "group/section border-t border-border",
        props.dropZone?.active && "rounded-[var(--lw-radius-lg)] ring-2 ring-primary/35",
      )}
      onDragOver={props.dropZone?.onDragOver}
      onDragLeave={props.dropZone?.onDragLeave}
      onDrop={props.dropZone?.onDrop}
    >
      <summary className="relative flex cursor-pointer list-none items-center gap-3 rounded-md py-4 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-details-marker]:hidden">
        {props.dropZone?.active ? (
          <span className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[var(--lw-radius-lg)] bg-background/90">
            {props.dropZone.label}
          </span>
        ) : null}
        {props.icon}
        <h2 className="flex-1">{props.title}</h2>
        {props.actions}
        <ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open/section:rotate-180" />
      </summary>
      <div className="pb-5">{props.children}</div>
    </details>
  );
}

/** Status, assignee and priority as chips: the current value with its mark, a menu behind it. */
type PropertyChipItem = {
  value: string;
  /** What the chip shows once chosen. */
  label: string;
  leading: ReactNode;
  /** The menu's line when it differs from the chip's (defaults to `label`). */
  primary?: string;
  /** A second, muted line in the menu, e.g. a member's email. */
  detail?: string;
  /** A key that picks the entry while the menu is open, shown at its end. */
  key?: string;
};

const CHIP_CLASS =
  "h-9 w-full min-w-0 max-w-full gap-2 rounded-lg sm:w-fit border-transparent bg-muted/60 px-3 text-sm font-medium text-foreground hover:bg-muted/60 data-[size=sm]:h-9";

function PropertyChip(props: {
  label: string;
  value: string;
  items: PropertyChipItem[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const current = props.items.find((item) => item.value === props.value);
  // Open state is held here so a key shortcut can close the menu after picking.
  const [open, setOpen] = useState(false);
  const pickByKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const item = props.items.find((entry) => entry.key === event.key);
    if (!item) return;
    event.preventDefault();
    props.onChange(item.value);
    setOpen(false);
  };
  return (
    <Select
      value={props.value}
      items={props.items}
      disabled={props.disabled}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(value) => props.onChange(value ?? "")}
    >
      <SelectTrigger size="sm" aria-label={props.label} className={CHIP_CLASS}>
        {current?.leading}
        <SelectValue className="min-w-0" title={current?.label}>
          <span className="truncate">{current?.label}</span>
        </SelectValue>
      </SelectTrigger>
      {/* As wide as the entries need rather than as the chip: the chip shows
          one short value, the menu has to show every name in full. */}
      <SelectContent align="start" className="w-auto min-w-(--anchor-width) max-w-80" onKeyDown={pickByKey}>
        <SelectGroup>
          {props.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.leading}
              <OptionText primary={item.primary ?? item.label} detail={item.detail} />
              {item.key ? (
                <span aria-hidden className="ms-auto ps-5 text-[11px] font-normal tabular-nums text-muted-foreground">
                  {item.key}
                </span>
              ) : null}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/**
 * The due date as a chip around a native date input: the platform's own
 * picker, no library, and a clear button once a date is set. A date-only
 * deadline is the firm's local day; the server stores it as local midnight.
 */
function DueDateChip(props: { value: string | null; disabled: boolean; onChange: (day: string | null) => void }) {
  const id = useId();
  const tone = taskDueTone(props.value);
  return (
    <span
      className={cn(
        "inline-flex h-9 min-w-0 items-center gap-2 rounded-lg bg-muted/60 ps-3 pe-1 text-sm font-medium",
        tone === "overdue" && "text-red-9",
        tone === "today" && "text-amber-9",
      )}
    >
      <label htmlFor={id} className="sr-only">
        {t("tasks.field_due")}
      </label>
      <CalendarClock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        id={id}
        type="date"
        disabled={props.disabled}
        value={taskDueDateInputValue(props.value)}
        title={props.value ? t("tasks.due_label", { date: formatTaskDueDate(props.value) }) : t("tasks.due_none")}
        className="h-9 min-w-0 bg-transparent text-sm font-medium text-inherit outline-none disabled:cursor-not-allowed"
        onChange={(event) => props.onChange(event.target.value || null)}
      />
      {props.value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("tasks.due_clear")}
          disabled={props.disabled}
          onClick={() => props.onChange(null)}
        >
          <X />
        </Button>
      ) : null}
    </span>
  );
}

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 truncate text-foreground">{props.children}</dd>
    </>
  );
}

export type TaskDetailProps = {
  task: LegalworkTask;
  /** Raw `submission` half of the detail; shape is not pinned by the contract. */
  submission: unknown;
  /** The detail fetch is still in flight, so "no original message" is not yet true. */
  submissionPending: boolean;
  members: LegalworkTaskMember[];
  tagSuggestions: string[];
  /** The task's history, oldest first. */
  notes: LegalworkTaskNote[];
  busy: boolean;
  /** Clerk user id of the signed-in member, so their own notes read "You". */
  accountUserId: string | null;
  /** Closes the task, back to the list alone: the back arrow in one column, the cross in two. */
  onBack: () => void;
  /** Every in-place change goes through here; it resolves when the store has it. */
  onPatch: (patch: LegalworkTaskPatch) => Promise<unknown>;
  onDelete: () => void;
  onRestore: () => void;
  onStartWorkflow?: () => void;
  /** A plain session in a chosen folder, seeded with the task's context only. */
  onStartSession?: () => void;
  /** Reveal a session tied to the task: the one that filed it, or a run started from it. */
  onOpenSession?: (link: LegalworkTaskSessionLink) => void;
  onDownloadAttachment: (attachment: LegalworkTaskAttachment) => Promise<void>;
  /** Shows the attachment in the side panel's viewer. */
  onOpenAttachment: (attachment: LegalworkTaskAttachment) => Promise<void>;
  onUploadAttachments: (files: File[]) => Promise<unknown>;
  onUploadStorageAttachment: (file: StorageFileDragItem) => Promise<unknown>;
  onRemoveAttachment: (attachment: LegalworkTaskAttachment) => Promise<unknown>;
};

export function TaskDetail(props: TaskDetailProps) {
  const { task } = props;
  // The newest run started from the task on this machine, for the toolbar's
  // "Open run"; the session that filed the task is not a run of it.
  const latestRun = task.sessions.find((link) => link.kind !== "created") ?? null;
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [draggingAttachment, setDraggingAttachment] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDescription, setDraftDescription] = useState(task.description);
  const [draftTags, setDraftTags] = useState(task.tags);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const email = useMemo(() => readTaskSubmission(props.submission), [props.submission]);
  const emailHtml = useMemo(() => (email?.html ? sanitizeEmailHtml(email.html) : null), [email]);
  const inTrash = task.deletedAt !== null;
  const locked = props.busy || inTrash;
  const canRun = Boolean(props.onStartWorkflow && props.onStartSession && props.onOpenSession);

  useEffect(() => setDraftTitle(task.title), [task.id, task.title]);
  useEffect(() => setDraftDescription(task.description), [task.description, task.id]);
  useEffect(() => setDraftTags(task.tags), [task.id, task.tags]);

  // Base UI's Select.Value renders the raw value unless the root is handed the
  // labels (`items`): without them the triggers show "open" and a Clerk user id.
  const statusItems = TASK_STATUSES.map((status) => ({
    value: status,
    label: taskStatusLabel(status),
    leading: <StatusGlyph status={status} />,
  }));
  // Digits pick a priority while its menu is open, as in Linear (0 = none … 4 = low).
  const priorityItems = TASK_PRIORITIES.map((priority) => ({
    value: String(priority),
    label: taskPriorityLabel(priority),
    leading: <PriorityMark priority={priority} />,
    key: String(priority),
  }));
  const assigneeItems: PropertyChipItem[] = [
    { value: UNASSIGNED, label: t("tasks.unassigned"), leading: <AssigneeMark name={null} /> },
    ...taskMemberOptions(props.members).map((option) => ({
      ...option,
      leading: <AssigneeMark name={option.primary} />,
    })),
  ];
  // Until the member list has loaded, or once the assignee has left the firm,
  // the current assignee is not among the members: label them from the task.
  if (task.assigneeUserId && !assigneeItems.some((item) => item.value === task.assigneeUserId)) {
    const label = task.assigneeName ?? task.assigneeUserId;
    assigneeItems.push({ value: task.assigneeUserId, label, leading: <AssigneeMark name={label} /> });
  }
  // With no firm connected there is nobody to hand a task to; the chip only
  // appears once the firm's members are known (or someone is already assigned).
  const showAssignee = props.members.length > 0 || Boolean(task.assigneeUserId);

  const patch = async (change: LegalworkTaskPatch, failure: string) => {
    try {
      await props.onPatch(change);
      return true;
    } catch (error) {
      toast.error(failure, { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };

  const saveTitle = async () => {
    const title = draftTitle.trim();
    if (!title) {
      setDraftTitle(task.title);
      return;
    }
    if (title !== task.title) await patch({ title }, t("tasks.update_failed"));
  };

  const saveDescription = async () => {
    if (draftDescription !== task.description) {
      await patch({ description: draftDescription }, t("tasks.update_failed"));
    }
  };

  const saveInlineOnCommandEnter = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  const addNote = async (event: FormEvent) => {
    event.preventDefault();
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    try {
      if (await patch({ note: body }, t("tasks.note_failed"))) setNoteDraft("");
    } finally {
      setSavingNote(false);
    }
  };

  const download = async (attachment: LegalworkTaskAttachment) => {
    setDownloadingId(attachment.id);
    try {
      await props.onDownloadAttachment(attachment);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("tasks.download_failed"));
    } finally {
      setDownloadingId(null);
    }
  };

  const open = async (attachment: LegalworkTaskAttachment) => {
    setOpeningId(attachment.id);
    try {
      await props.onOpenAttachment(attachment);
    } catch (error) {
      toast.error(t("tasks.open_attachment_failed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setOpeningId(null);
    }
  };

  const remove = async (attachment: LegalworkTaskAttachment) => {
    setRemovingId(attachment.id);
    try {
      await props.onRemoveAttachment(attachment);
    } catch (error) {
      toast.error(t("tasks.remove_attachment_failed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRemovingId(null);
    }
  };

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      await props.onUploadAttachments(files);
    } catch (error) {
      toast.error(t("tasks.upload_failed"), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const uploadStorageAttachment = async (file: StorageFileDragItem) => {
    setUploading(true);
    try {
      await props.onUploadStorageAttachment(file);
    } catch (error) {
      toast.error(t("tasks.upload_failed"), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  const dragHasAttachment = (dataTransfer: DataTransfer) =>
    Array.from(dataTransfer.types).includes("Files") || hasStorageFileDrag(dataTransfer);

  const noteAuthor = (note: LegalworkTaskNote): string => {
    if (note.authorUserId && props.accountUserId && note.authorUserId === props.accountUserId) return t("tasks.assignee_you");
    if (note.authorName || note.authorEmail) return note.authorName ?? note.authorEmail ?? "";
    // No author at all: written on a machine that was not signed in — this one.
    return note.authorUserId ? t("tasks.history_unknown_author") : t("tasks.assignee_you");
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <header className="shrink-0 border-b border-border py-3">
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center justify-between gap-2 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="ghost" size="icon-sm" className="@min-[880px]/tasks:hidden" aria-label={t("tasks.back_to_list")} onClick={props.onBack}>
              <ArrowLeft />
            </Button>
            <span className="max-w-48 truncate text-xs text-muted-foreground" title={taskOriginLabel(task)}>{taskOriginLabel(task)}</span>
            {task.createdSession && props.onOpenSession ? (
              // Filed by the agent: the session it happened in is one click
              // away, right where the task says where it came from. Icon only,
              // so the toolbar stays on one line beside the list; the Sessions
              // section and the Details spell it out.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 text-muted-foreground"
                      aria-label={t("tasks.open_session")}
                      onClick={() => props.onOpenSession?.(task.createdSession!)}
                    />
                  }
                >
                  <Bot className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>{sessionLinkLabel(task.createdSession)}</TooltipContent>
              </Tooltip>
            ) : null}
            {inTrash ? (
              <span className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground">
                <Trash2 aria-hidden className="size-3" />
                {t("tasks.in_trash")}
              </span>
            ) : null}
          </div>
          <div className="grid w-full gap-2 @min-[360px]/tasks:flex @min-[360px]/tasks:w-auto @min-[360px]/tasks:flex-wrap @min-[360px]/tasks:items-center">
            {inTrash ? (
              <Button size="sm" disabled={props.busy} aria-busy={props.busy} onClick={props.onRestore}>
                {props.busy ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
                {t("tasks.restore")}
              </Button>
            ) : canRun && task.cloudRunId ? (
              // Triage already started the workflow in the cloud; a local
              // workflow run would be a second one, so only a session is offered.
              <>
                <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onStartSession}>
                  <MessageSquarePlus />
                  {t("tasks.start_session")}
                </Button>
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 text-xs font-medium text-muted-foreground">
                  <Cloud aria-hidden className="size-3.5" />
                  {t("tasks.cloud_run_running")}
                </span>
              </>
            ) : canRun && latestRun ? (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" variant="outline" disabled={props.busy}>
                        {t("tasks.run_again")}
                        <ChevronDown className="text-muted-foreground" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={props.onStartWorkflow}>
                      <Play />
                      {t("tasks.start_workflow")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={props.onStartSession}>
                      <MessageSquarePlus />
                      {t("tasks.start_session")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button size="sm" onClick={() => props.onOpenSession?.(latestRun)}>
                  <SquareArrowOutUpRight />
                  {t("tasks.open_local_run")}
                </Button>
              </>
            ) : canRun ? (
              <>
                <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onStartSession}>
                  <MessageSquarePlus />
                  {t("tasks.start_session")}
                </Button>
                <Button size="sm" disabled={props.busy} aria-busy={props.busy} onClick={props.onStartWorkflow}>
                  {props.busy ? <Loader2 className="animate-spin" /> : <Play />}
                  {t("tasks.start_workflow")}
                </Button>
              </>
            ) : null}
            {inTrash ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t("tasks.delete")}
                      disabled={props.busy}
                      onClick={props.onDelete}
                    />
                  }
                >
                  <Trash2 />
                </TooltipTrigger>
                <TooltipContent>{t("tasks.delete")}</TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden @min-[880px]/tasks:inline-flex"
              aria-label={t("tasks.close_task")}
              onClick={props.onBack}
            >
              <X />
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-6 sm:px-6">
          <>
              <div className="space-y-4 pb-6">
                <Input
                  aria-label={t("tasks.field_title")}
                  maxLength={500}
                  value={draftTitle}
                  placeholder={t("tasks.field_title_placeholder")}
                  disabled={locked}
                  className="h-auto border-transparent bg-transparent px-0 py-0 text-xl font-medium leading-snug tracking-tight shadow-none hover:border-border focus-visible:border-border focus-visible:px-2 focus-visible:py-1 focus-visible:ring-0"
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={() => void saveTitle()}
                  onKeyDown={saveInlineOnCommandEnter}
                />
                <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:flex sm:flex-wrap sm:[&>[data-slot=select-trigger]]:max-w-72">
                  <PropertyChip
                    label={t("tasks.column_status")}
                    value={task.status}
                    items={statusItems}
                    disabled={locked}
                    onChange={(value) => {
                      const next = TASK_STATUSES.find((status) => status === value);
                      if (next && next !== task.status) void patch({ status: next }, t("tasks.update_failed"));
                    }}
                  />
                  {showAssignee ? (
                    <PropertyChip
                      label={t("tasks.column_assignee")}
                      value={task.assigneeUserId ?? UNASSIGNED}
                      items={assigneeItems}
                      disabled={locked}
                      onChange={(value) => {
                        const next = value === UNASSIGNED ? null : value;
                        if (next !== task.assigneeUserId) void patch({ assigneeUserId: next }, t("tasks.update_failed"));
                      }}
                    />
                  ) : null}
                  <PropertyChip
                    label={t("tasks.field_priority")}
                    value={String(task.priority)}
                    items={priorityItems}
                    disabled={locked}
                    onChange={(value) => {
                      const next = TASK_PRIORITIES.find((priority) => String(priority) === value);
                      if (next !== undefined && next !== task.priority) void patch({ priority: next }, t("tasks.update_failed"));
                    }}
                  />
                  <DueDateChip
                    value={task.dueDate}
                    disabled={locked}
                    onChange={(day) => void patch({ dueDate: day }, t("tasks.update_failed"))}
                  />
                </div>
                <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                  <Tags aria-hidden className="mt-2.5 size-4 text-muted-foreground" />
                  <TaskTagInput
                    tags={draftTags}
                    suggestions={props.tagSuggestions}
                    disabled={locked}
                    onChange={(tags) => {
                      setDraftTags(tags);
                      void patch({ tags }, t("tasks.update_failed")).then((saved) => {
                        if (!saved) setDraftTags(task.tags);
                      });
                    }}
                  />
                </div>
              </div>
              <section className="pb-6" aria-label={t("tasks.field_description")}>
                <Textarea
                  aria-label={t("tasks.field_description")}
                  rows={Math.max(3, draftDescription.split("\n").length)}
                  value={draftDescription}
                  placeholder={t("tasks.description_empty")}
                  disabled={locked}
                  className="min-h-20 resize-none border-transparent bg-transparent px-0 py-0 text-sm leading-relaxed shadow-none hover:border-border focus-visible:border-border focus-visible:px-2 focus-visible:py-2 focus-visible:ring-0"
                  onChange={(event) => setDraftDescription(event.target.value)}
                  onBlur={() => void saveDescription()}
                  onKeyDown={saveInlineOnCommandEnter}
                />
              </section>
            </>

          <Section
            title={task.attachments.length ? t("tasks.attachments_count", { count: task.attachments.length }) : t("tasks.attachments_empty")}
            icon={<Paperclip aria-hidden className="size-4 text-muted-foreground" />}
            dropZone={{
              active: draggingAttachment,
              label: t("tasks.drop_attachments"),
              onDragOver: (event) => {
                if (locked || uploading || !dragHasAttachment(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
                setDraggingAttachment(true);
              },
              onDragLeave: (event) => {
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) return;
                setDraggingAttachment(false);
              },
              onDrop: (event) => {
                if (locked || uploading || !dragHasAttachment(event.dataTransfer)) return;
                event.preventDefault();
                event.stopPropagation();
                setDraggingAttachment(false);
                const storageFile = readStorageFileDrag(event.dataTransfer);
                if (storageFile) {
                  void uploadStorageAttachment(storageFile);
                  return;
                }
                void upload(Array.from(event.dataTransfer.files));
              },
            }}
            actions={
              inTrash ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={uploading || props.busy}
                  aria-busy={uploading}
                  onClick={(event) => {
                    // The summary would toggle the section on the same click.
                    event.preventDefault();
                    event.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                >
                  {uploading ? <Loader2 className="animate-spin" /> : <Plus />}
                  {t("tasks.add_attachment")}
                </Button>
              )
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(event) => void upload(Array.from(event.target.files ?? []))}
            />
            {task.attachments.length ? (
              <ul className="flex flex-col gap-0.5">
                {task.attachments.map((attachment) => (
                  <li
                    key={attachment.id}
                    className="flex items-center gap-3 rounded-[var(--lw-radius-lg)] px-2 py-1.5 transition-colors duration-[var(--lw-duration-fast)] hover:bg-muted/50 motion-reduce:transition-none"
                  >
                    <button
                      type="button"
                      draggable
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-[var(--lw-radius-md)] text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-progress"
                      title={t("tasks.open_attachment")}
                      aria-label={`${t("tasks.open_attachment")}: ${attachment.filename}`}
                      aria-busy={openingId === attachment.id}
                      disabled={openingId === attachment.id}
                      onDragStart={(event) => writeTaskAttachmentDrag(event.dataTransfer, task.id, attachment)}
                      onClick={() => void open(attachment)}
                    >
                      {openingId === attachment.id ? (
                        <Loader2 aria-hidden className="size-6 animate-spin p-1 text-muted-foreground" />
                      ) : (
                        <DocumentIcon kind={documentIconKind(attachment.filename)} className="size-6" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">{attachment.filename}</span>
                        <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
                          {formatBytes(attachment.size)}
                          {attachment.cached ? null : (
                            <CloudDownload aria-label={t("tasks.attachment_not_cached")} className="size-3" />
                          )}
                        </span>
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t("tasks.download_attachment")}: ${attachment.filename}`}
                      aria-busy={downloadingId === attachment.id}
                      disabled={downloadingId === attachment.id}
                      onClick={() => void download(attachment)}
                    >
                      {downloadingId === attachment.id ? <Loader2 className="animate-spin" /> : <Download />}
                    </Button>
                    {inTrash ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("tasks.remove_attachment")}: ${attachment.filename}`}
                        aria-busy={removingId === attachment.id}
                        disabled={removingId === attachment.id || props.busy}
                        onClick={() => void remove(attachment)}
                      >
                        {removingId === attachment.id ? <Loader2 className="animate-spin" /> : <X />}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>

          {task.assignmentNote?.trim() ? (
            <Section title={t("tasks.assignment_note")} icon={<Sparkles aria-hidden className="size-4 text-muted-foreground" />}>
              <div>
                <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere] text-foreground">{task.assignmentNote}</p>
              </div>
            </Section>
          ) : null}

          {task.sessions.length ? (
            // Every session on this machine the task is tied to, newest
            // first: the runs started from it, and the agent session that
            // filed it. Local by design — the firm never learns which.
            <Section title={t("tasks.sessions_count", { count: task.sessions.length })} icon={<MessageSquarePlus aria-hidden className="size-4 text-muted-foreground" />}>
              <ul className="flex flex-col gap-1">
                {task.sessions.map((link) => (
                  <li key={link.sessionId} className="flex min-w-0 items-center gap-3 rounded-md py-1.5 text-sm">
                    <SessionLinkIcon kind={link.kind} />
                    <span className="min-w-0 flex-1 truncate text-foreground" title={sessionLinkLabel(link)}>
                      {sessionLinkLabel(link)}
                    </span>
                    {props.onOpenSession ? (
                    <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => props.onOpenSession?.(link)}>
                      <SquareArrowOutUpRight />
                      {link.kind === "workflow" ? t("tasks.open_local_run") : t("tasks.open_session")}
                    </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {/* What happened after the task was filed: notes by members, or by an
              agent working for them, oldest first, and a place to add one.
              Never mixed into the triage note above, which only triage writes. */}
          <Section title={t("tasks.history")} icon={<History aria-hidden className="size-4 text-muted-foreground" />}>
            {props.notes.length ? (
              <ol className="flex flex-col gap-4 pb-4">
                {props.notes.map((note) => {
                  const author = noteAuthor(note);
                  return (
                    <li key={note.id} className="flex gap-3">
                      <AssigneeMark name={author} className="mt-0.5" />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{author}</span>
                          {note.source === "agent" ? (
                            <span className="inline-flex items-center gap-1">
                              <Bot aria-hidden className="size-3.5" />
                              {t("tasks.history_via_agent")}
                            </span>
                          ) : null}
                          <span aria-hidden>·</span>
                          <time dateTime={note.createdAt}>{formatTaskDateTime(note.createdAt)}</time>
                        </p>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere] text-foreground">
                          {note.body}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {inTrash ? null : (
              <form className="flex flex-col gap-2" onSubmit={(event) => void addNote(event)}>
                <Textarea
                  aria-label={t("tasks.add_note")}
                  rows={2}
                  maxLength={4_000}
                  value={noteDraft}
                  placeholder={t("tasks.note_placeholder")}
                  disabled={savingNote}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }}
                />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" variant="outline" disabled={savingNote || !noteDraft.trim()} aria-busy={savingNote}>
                    {savingNote ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}
                    {t("tasks.add_note")}
                  </Button>
                </div>
              </form>
            )}
          </Section>

          {task.origin === "intake" ? (
            <Section title={t("tasks.original_message")} icon={<Mail aria-hidden className="size-4 text-muted-foreground" />}>
              {props.submissionPending && !email ? (
                <div aria-busy className="flex flex-col gap-2.5 rounded-[var(--lw-radius-xl)] border border-border p-4">
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              ) : email ? (
                <article className="overflow-hidden rounded-[var(--lw-radius-xl)] border border-border">
                  <div className="flex items-start gap-3 border-b border-border bg-muted/30 px-4 py-3">
                    <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <Fact label={t("tasks.email_from")}>{email.from ?? t("tasks.value_none")}</Fact>
                      <Fact label={t("tasks.email_to")}>{email.to ?? t("tasks.value_none")}</Fact>
                      <Fact label={t("tasks.email_received")}>
                        {formatTaskDateTime(email.receivedAt) || t("tasks.value_none")}
                      </Fact>
                    </dl>
                    {email.channel ? (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                        {email.channel === "api" ? (
                          <Webhook aria-hidden className="size-3" />
                        ) : (
                          <Mail aria-hidden className="size-3" />
                        )}
                        {email.channel === "api" ? t("tasks.channel_api") : t("tasks.channel_email")}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-3 px-4 py-4">
                    {email.subject ? <p className="text-sm font-medium text-foreground">{email.subject}</p> : null}
                    {emailHtml ? (
                      <div
                        className="text-sm leading-relaxed text-foreground [&_a]:underline [&_table]:block [&_table]:overflow-x-auto"
                        dangerouslySetInnerHTML={{ __html: emailHtml }}
                      />
                    ) : email.text ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere] text-foreground">{email.text}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground">{t("tasks.original_message_empty")}</p>
                    )}
                  </div>
                </article>
              ) : (
                <p className="text-sm text-muted-foreground">{t("tasks.original_message_missing")}</p>
              )}
            </Section>
          ) : null}

          <Section title={t("tasks.details")} icon={<ListFilter aria-hidden className="size-4 text-muted-foreground" />}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <Fact label={t("tasks.field_priority")}>
                <PriorityMark priority={task.priority} />
                {taskPriorityLabel(task.priority)}
              </Fact>
              <Fact label={t("tasks.field_due")}>{formatTaskDueDate(task.dueDate) || t("tasks.value_none")}</Fact>
              {task.origin === "intake" ? <Fact label={t("tasks.column_endpoint")}>{taskOriginLabel(task)}</Fact> : null}
              <Fact label={t("tasks.column_created")}>{formatTaskDateTime(task.createdAt)}</Fact>
              {task.createdSession && props.onOpenSession ? (
                // Filed by the agent: the session it happened in is one click
                // away, the same way a local run is.
                <Fact label={t("tasks.created_by")}>
                  <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t("tasks.created_by_agent")}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs"
                    onClick={() => props.onOpenSession?.(task.createdSession!)}
                  >
                    <SquareArrowOutUpRight />
                    {t("tasks.open_session")}
                  </Button>
                </Fact>
              ) : null}
              <Fact label={t("tasks.column_updated")}>{formatTaskDateTime(task.updatedAt)}</Fact>
              {task.lastLocalRunAt ? (
                <Fact label={t("tasks.last_local_run")}>{formatTaskDateTime(task.lastLocalRunAt)}</Fact>
              ) : null}
              {task.deletedAt ? <Fact label={t("tasks.in_trash")}>{formatTaskDate(task.deletedAt)}</Fact> : null}
              {/* Syncing is not the user's concern — until a change of this
                  task could not be pushed, which is the one thing worth saying. */}
              {task.sync.error ? (
                <Fact label={t("tasks.field_sync")}>
                  <SyncMark sync={task.sync} />
                  <span>{t("tasks.sync_unavailable_detail")}</span>
                </Fact>
              ) : null}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}
