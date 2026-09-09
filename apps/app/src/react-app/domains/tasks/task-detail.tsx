/** @jsxImportSource react */
/**
 * One intake task: the parsed task, the message it came from, its attachments,
 * what triage decided, and the single next action — open the cloud run the
 * platform already started, or start a local one.
 */
import { useMemo, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { ArrowLeft, Download, Loader2, Paperclip, Play, SquareArrowOutUpRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import type {
  EigenweltIntakeAttachment,
  EigenweltIntakeMember,
  EigenweltIntakeTask,
  EigenweltIntakeTaskStatus,
} from "@/app/lib/legalwork-server";
import { formatBytes } from "@/app/utils";
import { t } from "@/i18n";
import {
  INTAKE_TASK_STATUSES,
  formatIntakeDate,
  intakePriorityLabel,
  intakePriorityToneClass,
  intakeStatusLabel,
} from "./task-format";
import { readIntakeSubmission } from "./task-submission";
import type { IntakeTaskLocalRun } from "./task-run-store";

/** The "unassigned" choice needs a non-empty Select value of its own. */
const UNASSIGNED = "__unassigned__";

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

function MetaRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{props.label}</span>
      <span className="truncate text-sm text-foreground">{props.children}</span>
    </div>
  );
}

export type TaskDetailProps = {
  task: EigenweltIntakeTask;
  /** Raw `submission` half of the relayed detail; shape is not pinned by the contract. */
  submission: unknown;
  /** The detail fetch is still in flight, so "no original message" is not yet true. */
  submissionPending: boolean;
  members: EigenweltIntakeMember[];
  localRun: IntakeTaskLocalRun | null;
  busy: boolean;
  onBack: () => void;
  onStatusChange: (status: EigenweltIntakeTaskStatus) => void;
  onAssigneeChange: (userId: string | null) => void;
  onStartWorkflow: () => void;
  onOpenLocalRun: (run: IntakeTaskLocalRun) => void;
  onDownloadAttachment: (attachment: EigenweltIntakeAttachment) => Promise<void>;
};

export function TaskDetail(props: TaskDetailProps) {
  const { task, localRun } = props;
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const email = useMemo(() => readIntakeSubmission(props.submission), [props.submission]);
  const emailHtml = useMemo(() => (email?.html ? sanitizeEmailHtml(email.html) : null), [email]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-5">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={props.onBack}>
            <ArrowLeft size={14} />
            {t("tasks.back_to_list")}
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`size-2 shrink-0 rounded-full ${intakePriorityToneClass(task.priority)}`}
            />
            <h1 className="min-w-0 text-[22px] font-medium leading-tight tracking-[-0.02em]">{task.title}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{intakeStatusLabel(task.status)}</Badge>
            <Badge variant="outline">{intakePriorityLabel(task.priority)}</Badge>
            <span className="text-xs text-muted-foreground">{task.endpointName}</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 rounded-2xl border border-border bg-card p-4 sm:grid-cols-4">
          <MetaRow label={t("tasks.column_created")}>{formatIntakeDate(task.createdAt)}</MetaRow>
          <MetaRow label={t("tasks.column_updated")}>{formatIntakeDate(task.updatedAt)}</MetaRow>
          <MetaRow label={t("tasks.field_due")}>
            {formatIntakeDate(task.dueDate) || t("tasks.value_none")}
          </MetaRow>
          <MetaRow label={t("tasks.column_assignee")}>
            {task.assigneeName ?? t("tasks.unassigned")}
          </MetaRow>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("tasks.column_status")}</Label>
            <Select
              value={task.status}
              disabled={props.busy}
              onValueChange={(value) => {
                const next = INTAKE_TASK_STATUSES.find((status) => status === value);
                if (next) props.onStatusChange(next);
              }}
            >
              <SelectTrigger className="w-44" aria-label={t("tasks.column_status")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {INTAKE_TASK_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {intakeStatusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t("tasks.column_assignee")}</Label>
            <Select
              value={task.assigneeUserId ?? UNASSIGNED}
              disabled={props.busy}
              onValueChange={(value) => props.onAssigneeChange(value === UNASSIGNED ? null : value)}
            >
              <SelectTrigger className="w-56" aria-label={t("tasks.column_assignee")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={UNASSIGNED}>{t("tasks.unassigned")}</SelectItem>
                  {props.members.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.name ?? member.email ?? member.userId}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {localRun ? (
              <Button variant="outline" onClick={() => props.onOpenLocalRun(localRun)}>
                <SquareArrowOutUpRight size={14} />
                {t("tasks.open_local_run")}
              </Button>
            ) : null}
            {/* Triage may already have started the workflow in the cloud; in
                that case the local run button would create a second one. */}
            {task.cloudRunId ? (
              <Badge variant="outline">{t("tasks.cloud_run_running")}</Badge>
            ) : (
              <Button onClick={props.onStartWorkflow} disabled={props.busy}>
                {props.busy ? <Loader2 className="size-4 animate-spin" /> : <Play size={14} />}
                {t("tasks.start_workflow")}
              </Button>
            )}
          </div>
        </div>

        {task.assignmentNote?.trim() ? (
          <section className="flex flex-col gap-1.5 rounded-2xl border border-border bg-muted/40 p-4">
            <h2 className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              {t("tasks.assignment_note")}
            </h2>
            <p className="whitespace-pre-wrap text-sm text-foreground">{task.assignmentNote}</p>
          </section>
        ) : null}

        {task.description.trim() ? (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-sm font-medium">{t("tasks.field_description")}</h2>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">{t("tasks.original_message")}</h2>
          {props.submissionPending && !email ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : email ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <MetaRow label={t("tasks.email_from")}>{email.from ?? t("tasks.value_none")}</MetaRow>
                <MetaRow label={t("tasks.email_to")}>{email.to ?? t("tasks.value_none")}</MetaRow>
                <MetaRow label={t("tasks.email_received")}>
                  {formatIntakeDate(email.receivedAt) || t("tasks.value_none")}
                </MetaRow>
              </div>
              {email.subject ? (
                <p className="text-sm font-medium text-foreground">{email.subject}</p>
              ) : null}
              {emailHtml ? (
                <div
                  className="text-sm leading-relaxed text-foreground [&_a]:underline [&_table]:block [&_table]:overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: emailHtml }}
                />
              ) : email.text ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{email.text}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t("tasks.original_message_empty")}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("tasks.original_message_missing")}</p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">
            {t("tasks.attachments_count", { count: task.attachments.length })}
          </h2>
          {task.attachments.length ? (
            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
              {task.attachments.map((attachment) => (
                <li key={attachment.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Paperclip size={14} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(attachment.size)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("tasks.download_attachment")}
                    disabled={downloadingId === attachment.id}
                    onClick={async () => {
                      setDownloadingId(attachment.id);
                      try {
                        await props.onDownloadAttachment(attachment);
                      } catch (error) {
                        toast.error(
                          error instanceof Error ? error.message : t("tasks.download_failed"),
                        );
                      } finally {
                        setDownloadingId(null);
                      }
                    }}
                  >
                    {downloadingId === attachment.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("tasks.attachments_empty")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
