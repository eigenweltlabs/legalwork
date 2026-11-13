import { describe, expect, test } from "bun:test";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { calendarDaySegments, layoutCalendarDay } from "../src/react-app/domains/calendar/calendar-layout";
import { calendarDay, calendarRange, moveCalendar, occursInRange } from "../src/react-app/domains/calendar/calendar-format";

function event(id: string, start: string, end: string | null, overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return { id, itemId: id, uid: id, title: id, projectId: "project", projectName: "Project", kind: "event", start, end, allDay: false,
    timeZone: "Europe/Berlin", status: "active", assigneeUserId: null, provenance: null, verified: true, recurring: false, ...overrides };
}
const timed = (id: string, start: string, end: string) => event(id, `2026-10-28T${start}:00+01:00`, `2026-10-28T${end}:00+01:00`);

describe("calendar timetable", () => {
  test("ten back-to-back meetings keep their actual times and use the full column", () => {
    const meetings = Array.from({ length: 10 }, (_, index) => timed(String(index), `${String(9 + index).padStart(2, "0")}:00`, `${String(10 + index).padStart(2, "0")}:00`));
    const layout = layoutCalendarDay(meetings, "2026-10-28");
    expect(layout).toHaveLength(10);
    expect(layout.map(item => [item.start, item.end, item.column, item.columns, item.span])).toEqual(
      meetings.map((_, index) => [(9 + index) * 60, (10 + index) * 60, 0, 1, 1]));
  });
  test("simultaneous and chained overlaps never cover another event", () => {
    const layout = layoutCalendarDay([
      timed("briefing", "09:00", "09:45"), timed("review", "09:30", "11:30"),
      timed("client", "09:45", "10:30"), timed("contract", "10:30", "11:15"),
      timed("hearing", "11:00", "12:00"), timed("strategy", "11:15", "12:00"),
      timed("afternoon", "13:00", "13:45"),
    ], "2026-10-28");
    expect(Math.max(...layout.map(item => item.columns))).toBe(3);
    expect(layout.find(item => item.item.id === "afternoon")?.columns).toBe(1);
    for (const left of layout) for (const right of layout) {
      if (left === right || left.start >= right.displayEnd || right.start >= left.displayEnd) continue;
      expect(left.column + left.span <= right.column || right.column + right.span <= left.column).toBe(true);
    }
  });
  test("widens events into columns freed later in an overlap group", () => {
    const layout = layoutCalendarDay([timed("long", "09:00", "12:00"), timed("early", "09:00", "10:00"), timed("third", "09:00", "10:00"), timed("later", "10:00", "11:00")], "2026-10-28");
    expect(layout.find(item => item.item.id === "later")?.span).toBe(2);
  });
  test("clips overnight events at midnight and respects exclusive midnight ends", () => {
    const overnight = event("overnight", "2026-10-27T23:30:00+01:00", "2026-10-28T01:00:00+01:00");
    expect(calendarDaySegments([overnight], "2026-10-27").map(({ start, end }) => [start, end])).toEqual([[1410, 1440]]);
    expect(calendarDaySegments([overnight], "2026-10-28").map(({ start, end }) => [start, end])).toEqual([[0, 60]]);
    expect(calendarDaySegments([event("midnight", overnight.start, "2026-10-28T00:00:00+01:00")], "2026-10-28")).toEqual([]);
  });
  test("preserves point deadlines and reserves readable space for very short meetings", () => {
    const layout = layoutCalendarDay([timed("short", "09:00", "09:05"), event("deadline", "2026-10-28T09:05:00+01:00", null, { kind: "deadline" })], "2026-10-28");
    expect(layout.map(({ start, end, displayEnd, columns }) => [start, end, displayEnd, columns])).toEqual([[540, 545, 560, 2], [545, 545, 565, 2]]);
    expect(calendarDaySegments([event("all-day", "2026-10-28", "2026-10-29", { allDay: true })], "2026-10-28")).toEqual([]);
  });
  test("places UTC and floating timestamps at the expected local wall-clock time", () => {
    expect(calendarDaySegments([event("utc", "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z"), event("floating", "2026-10-28T09:00:00", "2026-10-28T10:00:00")], "2026-10-28").map(({ start, end }) => [start, end])).toEqual([[540, 600], [540, 600]]);
  });
  test("keeps meetings and point deadlines just before midnight fully clickable", () => {
    const layout = layoutCalendarDay([timed("late", "23:50", "23:55"), event("cutoff", "2026-10-28T23:59:00+01:00", null, { kind: "deadline" })], "2026-10-28");
    expect(layout.map(({ start, displayStart, displayEnd, columns }) => [start, displayStart, displayEnd, columns])).toEqual([[1430, 1420, 1440, 2], [1439, 1420, 1440, 2]]);
    expect(layout.every(item => item.displayEnd - item.displayStart >= 20)).toBe(true);
  });
  test("day navigation crosses a daylight-saving boundary by dates, not 24-hour intervals", () => {
    const next = moveCalendar(new Date(2026, 9, 24), "day", 1);
    const range = calendarRange(next, "day");
    expect([range.from, range.to]).toEqual(["2026-10-25", "2026-10-26"]);
    expect(calendarDay(moveCalendar(next, "day", 1))).toBe("2026-10-26");
    expect(calendarDay(moveCalendar(new Date(2026, 11, 31), "day", 1))).toBe("2027-01-01");
  });
  test("clips adjacent source dates after projecting them onto the viewer's time zone", () => {
    const late = event("late call", "2026-10-27T23:30:00-07:00", "2026-10-28T00:30:00-07:00");
    expect(occursInRange(late, "2026-10-28", "2026-10-29")).toBe(true);
    expect(occursInRange(late, "2026-10-27", "2026-10-28")).toBe(false);
    expect(occursInRange(event("all-day", "2026-10-27", "2026-10-28", { allDay: true }), "2026-10-28", "2026-10-29")).toBe(false);
    expect(occursInRange(event("ends at midnight", "2026-10-27T21:00:00+01:00", "2026-10-28T00:00:00+01:00"), "2026-10-28", "2026-10-29")).toBe(false);
  });
});
