import type { TaskSchedule } from "@legalwork/types/scheduled-tasks";
import { t, currentLocale } from "@/i18n";

export const repeatModes = ["once", "interval", "daily", "weekdays", "weekly", "custom"];
export function repeatMode(schedule: TaskSchedule): string {
  if (schedule.kind !== "rrule") return schedule.kind;
  if (schedule.rrule === "FREQ=DAILY") return "daily";
  if (schedule.rrule === "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") return "weekdays";
  if (/^FREQ=WEEKLY;BYDAY=(MO|TU|WE|TH|FR|SA|SU)$/.test(schedule.rrule)) return "weekly";
  return "custom";
}
export function scheduleLabel(schedule: TaskSchedule) {
  return schedule.kind === "interval" ? t("scheduled.every_minutes", { count: schedule.minutes }) : t(`scheduled.${repeatMode(schedule)}`);
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
