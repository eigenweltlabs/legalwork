/**
 * Display helpers for tasks: translated labels for the wire enums, the one
 * ordering rule the app has to know about itself, and the date formats the
 * pane uses, all in the app's current language.
 */
import type {
  LegalworkTaskMember,
  LegalworkTaskPriority,
  LegalworkTaskStatus,
} from "@/app/lib/legalwork-server";
import { currentLocale, t } from "@/i18n";

export type TaskMemberOption = {
  value: string;
  /** What a chip shows once the member is chosen. */
  label: string;
  /** The menu line: the name, else the email, else (last resort) the id. */
  primary: string;
  /** The email under the name, when there is a name to put it under. */
  detail?: string;
};

/**
 * How a member reads in a picker. The menu shows the email under every name,
 * and a chip adds it for a name two members share (one person's work and
 * private account, say), so a chosen value is never ambiguous.
 */
export function taskMemberOptions(members: readonly LegalworkTaskMember[]): TaskMemberOption[] {
  const nameCounts = new Map<string, number>();
  for (const member of members) {
    if (member.name) nameCounts.set(member.name, (nameCounts.get(member.name) ?? 0) + 1);
  }
  return members.map((member) => {
    const primary = member.name ?? member.email ?? member.userId;
    const shared = Boolean(member.name && member.email && (nameCounts.get(member.name) ?? 0) > 1);
    return {
      value: member.userId,
      label: shared ? `${primary} (${member.email})` : primary,
      primary,
      ...(member.name && member.email ? { detail: member.email } : {}),
    };
  });
}

export const TASK_STATUSES: LegalworkTaskStatus[] = [
  "open",
  "in_progress",
  "done",
  "cancelled",
];

/** The order a picker offers them in — Linear's: none, then urgent down to low. */
export const TASK_PRIORITIES: LegalworkTaskPriority[] = [0, 1, 2, 3, 4];

/**
 * The digit that picks a priority while its menu is open (0 = none … 4 = low,
 * as Linear has it); null for any other key, or a key with a modifier held.
 */
export function priorityForKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): LegalworkTaskPriority | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "0":
      return 0;
    case "1":
      return 1;
    case "2":
      return 2;
    case "3":
      return 3;
    case "4":
      return 4;
    default:
      return null;
  }
}

export function taskStatusLabel(status: LegalworkTaskStatus): string {
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

export function taskPriorityLabel(priority: LegalworkTaskPriority): string {
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

export type TaskDateOptions = {
  /** Reference time for "today" and "this week"; defaults to now. */
  now?: Date;
  /** BCP 47 tag; defaults to the app language. */
  locale?: string;
};

const DAY_MS = 86_400_000;

function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** `2024-05-06T…` -> "6 May 2024" in the app language. Invalid or missing values render empty. */
export function formatTaskDate(iso: string | null | undefined, options?: TaskDateOptions): string {
  const date = parseIsoDate(iso);
  if (!date) return "";
  return date.toLocaleDateString(options?.locale ?? currentLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** Date plus wall-clock time, for the moments a reader compares: received, started. */
export function formatTaskDateTime(iso: string | null | undefined, options?: TaskDateOptions): string {
  const date = parseIsoDate(iso);
  if (!date) return "";
  return date.toLocaleString(options?.locale ?? currentLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The compact timestamp a list row carries: the time for today, the weekday
 * for the last six days, otherwise a short date, with the year once it differs.
 */
export function formatTaskListDate(iso: string | null | undefined, options?: TaskDateOptions): string {
  const date = parseIsoDate(iso);
  if (!date) return "";
  const now = options?.now ?? new Date();
  const locale = options?.locale ?? currentLocale();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (daysAgo === 0) return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (daysAgo > 0 && daysAgo < 7) return date.toLocaleDateString(locale, { weekday: "short" });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  return formatTaskDate(iso, { locale });
}

/**
 * A due date as it is shown: the day, and the time only when one was set — a
 * date-only deadline is stored as local midnight, which is not a time anyone
 * means. The year is dropped while it is the current one.
 */
export function formatTaskDueDate(iso: string | null | undefined, options?: TaskDateOptions): string {
  const date = parseIsoDate(iso);
  if (!date) return "";
  const now = options?.now ?? new Date();
  const locale = options?.locale ?? currentLocale();
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  const day = date.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return hasTime ? `${day}, ${date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}` : day;
}

export type TaskDueTone = "overdue" | "today" | "later";

/** Whether a due date has passed (as of the end of its day), is today, or is still ahead. */
export function taskDueTone(iso: string | null | undefined, now: Date = new Date()): TaskDueTone | null {
  const date = parseIsoDate(iso);
  if (!date) return null;
  const daysLeft = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (daysLeft < 0) return "overdue";
  if (daysLeft === 0) return "today";
  return "later";
}

/** An ISO due date as a date input's value (`YYYY-MM-DD`, local day); "" when unset. */
export function taskDueDateInputValue(iso: string | null | undefined): string {
  const date = parseIsoDate(iso);
  if (!date) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
