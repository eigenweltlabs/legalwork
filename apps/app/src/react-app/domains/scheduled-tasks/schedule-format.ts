import type { ScheduledRun, ScheduledTask, TaskSchedule } from "@legalwork/types/scheduled-tasks";
import { t, currentLocale } from "@/i18n";

type RepeatMode = "once" | "interval" | "daily" | "weekdays" | "weekly" | "custom";
const repeatLabels = () => ({ once: t("scheduled.once"), interval: t("scheduled.interval"), daily: t("scheduled.daily"), weekdays: t("scheduled.weekdays"), weekly: t("scheduled.weekly"), custom: t("scheduled.custom") });
export const repeatOptions = () => Object.entries(repeatLabels()).map(([value, label]) => ({ value, label }));
export function repeatMode(schedule: TaskSchedule): RepeatMode {
  if (schedule.kind !== "rrule") return schedule.kind;
  if (schedule.rrule === "FREQ=DAILY") return "daily";
  if (schedule.rrule === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") return "weekdays";
  if (/^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)$/.test(schedule.rrule)) return "weekly";
  return "custom";
}
export function scheduleLabel(schedule: TaskSchedule) {
  return schedule.kind === "interval" ? t("scheduled.every_minutes", { count: schedule.minutes }) : repeatLabels()[repeatMode(schedule)];
}
export function taskStatusLabel(status: ScheduledTask["status"]) {
  return { active: t("scheduled.active"), paused: t("scheduled.paused"), completed: t("scheduled.completed") }[status];
}
export function runStatusLabel(status: ScheduledRun["status"]) {
  return { sent: t("scheduled.run_sent"), failed: t("scheduled.run_failed"), dispatching: t("scheduled.run_dispatching") }[status];
}
export function formatRunTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(currentLocale(), { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
export function localDateTime(value: string, timeZone: string) {
  if (!/Z$|[+-]\d\d:\d\d$/.test(value)) return value.slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (key: string) => parts.find(p => p.type === key)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Changing only the time or zone must not replace a saved weekly day. */
export function weeklyRuleForStart(start: string, original?: TaskSchedule) {
  if (original?.kind === "rrule" && repeatMode(original) === "weekly" && start.slice(0, 10) === localDateTime(original.startAt, original.timeZone).slice(0, 10)) return original.rrule;
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${start.slice(0, 10)}T12:00:00Z`).getUTCDay()];
  return `FREQ=WEEKLY;BYDAY=${weekday}`;
}

/** Start at the next matching local wall time, including later today. */
export function suggestedSchedule(cadence: "daily" | "weekdays" | "monday" | "friday", hour: number, now = new Date()): TaskSchedule {
  const start = new Date(now);
  start.setHours(hour, 0, 0, 0);
  const weekday = cadence === "monday" ? 1 : cadence === "friday" ? 5 : null;
  while (start <= now || (cadence === "weekdays" && [0, 6].includes(start.getDay())) || (weekday !== null && start.getDay() !== weekday)) start.setDate(start.getDate() + 1);
  return { kind: "rrule", startAt: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: cadence === "daily" ? "FREQ=DAILY" : cadence === "weekdays" ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" : cadence === "monday" ? "FREQ=WEEKLY;BYDAY=MO" : "FREQ=WEEKLY;BYDAY=FR" };
}
