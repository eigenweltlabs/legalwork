/**
 * Display helpers for intake tasks: translated labels for the wire enums and
 * the one ordering rule the app has to know about itself.
 */
import type {
  EigenweltIntakeTaskPriority,
  EigenweltIntakeTaskStatus,
} from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export const INTAKE_TASK_STATUSES: EigenweltIntakeTaskStatus[] = [
  "open",
  "in_progress",
  "done",
  "cancelled",
];

export function intakeStatusLabel(status: EigenweltIntakeTaskStatus): string {
  switch (status) {
    case "open":
      return t("tasks.status_open");
    case "in_progress":
      return t("tasks.status_in_progress");
    case "done":
      return t("tasks.status_done");
    case "cancelled":
      return t("tasks.status_cancelled");
  }
}

export function intakePriorityLabel(priority: EigenweltIntakeTaskPriority): string {
  switch (priority) {
    case 1:
      return t("tasks.priority_urgent");
    case 2:
      return t("tasks.priority_high");
    case 3:
      return t("tasks.priority_medium");
    case 4:
      return t("tasks.priority_low");
    case 0:
      return t("tasks.priority_none");
  }
}

/** Tone for the priority marker. "None" stays invisible rather than grey-on-grey. */
export function intakePriorityToneClass(priority: EigenweltIntakeTaskPriority): string {
  switch (priority) {
    case 1:
      return "bg-red-9";
    case 2:
      return "bg-amber-9";
    case 3:
      return "bg-sky-9";
    case 4:
      return "bg-muted-foreground/50";
    case 0:
      return "bg-transparent";
  }
}

/** `2024-05-06T…` -> a short local date. Invalid or missing values render empty. */
export function formatIntakeDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString();
}
