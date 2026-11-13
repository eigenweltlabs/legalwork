import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { occurrenceDay, occursOnDay } from "./calendar-format";

export const CALENDAR_HOUR_HEIGHT = 48;
const MINIMUM_MINUTES = 20;

function minuteOfDay(value: string, timeZone: string) {
  if (value.length <= 19) return Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  return Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
}

/** Split overnight events at local midnight. Date-only entries stay in the all-day strip. */
export function calendarDaySegments<T extends CalendarOccurrence>(items: T[], day: string) {
  return items.filter(item => !item.allDay && occursOnDay(item, day)).map(item => {
    const start = occurrenceDay(item) < day ? 0 : minuteOfDay(item.start, item.timeZone);
    const hasEnd = Boolean(item.end && item.end > item.start);
    const end = hasEnd && item.end
      ? occurrenceDay({ ...item, start: item.end }) > day ? 1440 : minuteOfDay(item.end, item.timeZone)
      : start;
    // Point deadlines and short meetings need a readable, clickable minimum size.
    return { item, start, end: Math.max(start, end), displayStart: Math.min(start, 1440 - MINIMUM_MINUTES), displayEnd: Math.min(1440, Math.max(end, start + MINIMUM_MINUTES)) };
  }).sort((a, b) => a.displayStart - b.displayStart || b.displayEnd - a.displayEnd || a.start - b.start || a.item.id.localeCompare(b.item.id));
}

/** Allocate overlapping intervals to columns; expand into adjacent columns when free. */
export function layoutCalendarDay<T extends CalendarOccurrence>(items: T[], day: string) {
  type Segment = ReturnType<typeof calendarDaySegments<T>>[number] & { column: number; columns: number; span: number };
  const result: Segment[] = [];
  let group: Segment[] = [], ends: number[] = [], groupEnd = 0;
  const finish = () => {
    for (const segment of group) {
      segment.columns = ends.length;
      while (segment.column + segment.span < segment.columns && !group.some(other =>
        other.column === segment.column + segment.span && other.displayStart < segment.displayEnd && other.displayEnd > segment.displayStart)) segment.span++;
    }
    result.push(...group);
    group = []; ends = []; groupEnd = 0;
  };
  for (const segment of calendarDaySegments(items, day)) {
    if (group.length && segment.displayStart >= groupEnd) finish();
    let column = ends.findIndex(end => end <= segment.displayStart);
    if (column < 0) column = ends.length;
    ends[column] = segment.displayEnd;
    group.push({ ...segment, column, columns: 1, span: 1 });
    groupEnd = Math.max(groupEnd, segment.displayEnd);
  }
  finish();
  return result;
}
