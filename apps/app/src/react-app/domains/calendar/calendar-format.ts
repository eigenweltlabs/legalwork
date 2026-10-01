import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import { currentLocale, t } from "@/i18n";

export type CalendarViewMode = "week" | "month" | "agenda";

export function calendarDay(day: Date) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export function shiftDay(day: Date, offset: number) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
}

export function calendarRange(anchor: Date, view: CalendarViewMode) {
  const first = view === "week" ? shiftDay(anchor, 0) : new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = view === "agenda" ? first : shiftDay(first, -((first.getDay() + 6) % 7));
  const end = view === "agenda" ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1) : shiftDay(start, view === "week" ? 7 : 42);
  return { start, end, from: calendarDay(start), to: calendarDay(end) };
}

export function moveCalendar(anchor: Date, view: CalendarViewMode, direction: number) {
  return view === "week" ? shiftDay(anchor, direction * 7) : new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

function zonedDay(value: string, timeZone: string) {
  // Floating iCalendar times keep their wall-clock date.
  if (value.length <= 19) return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function occurrenceDay(item: CalendarOccurrence) {
  return item.allDay ? item.start.slice(0, 10) : zonedDay(item.start, item.timeZone);
}

/** iCalendar end dates are exclusive; an event ending at midnight stays on the preceding day. */
export function occursOnDay(item: CalendarOccurrence, day: string) {
  const start = occurrenceDay(item);
  if (day < start) return false;
  if (!item.end || item.end <= item.start) return day === start;
  const end = item.allDay ? item.end.slice(0, 10) : zonedDay(item.end, item.timeZone);
  const midnight = item.allDay || (item.end.length === 19 ? item.end.slice(11) === "00:00:00" :
    new Intl.DateTimeFormat("en-GB", { timeZone: item.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(item.end)) === "00:00:00");
  return day < end || (!midnight && day === end) || day === start;
}

export function formatCalendarDay(value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(currentLocale(), options);
}

export function occurrenceTime(item: CalendarOccurrence) {
  if (item.allDay) return t("calendar.all_day");
  if (item.start.length === 19) return item.start.slice(11, 16);
  return new Intl.DateTimeFormat(currentLocale(), { timeZone: item.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(item.start));
}

export function isCompleted(item: CalendarOccurrence) { return item.status === "done" || item.status === "completed"; }
export function isActive(item: CalendarOccurrence) { return !isCompleted(item) && item.status !== "cancelled"; }
export function calendarError(error: unknown) { return error instanceof Error ? error.message : t("calendar.failed"); }

export function calendarKindLabel(kind: CalendarOccurrence["kind"]) {
  const labels = { deadline: t("calendar.deadline"), task: t("calendar.task"), event: t("calendar.event"), journal: t("calendar.journal"), freebusy: t("calendar.freebusy") };
  return labels[kind];
}

export function provenanceLabel(kind: CalendarItem["provenance"]["kind"] | "task") {
  const labels = { manual: t("calendar.manual"), calculated: t("calendar.calculated"), imported: t("calendar.imported"), task: t("calendar.task") };
  return labels[kind];
}

export function deadlineReviewLabel(item: Pick<CalendarOccurrence, "verified" | "provenance">) {
  if (item.verified) return t("calendar.verified");
  if (item.provenance?.kind === "manual" && !item.provenance.reason) return t("calendar.entered_manually");
  return t("calendar.unverified");
}
