import { describe, expect, test } from "bun:test";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { deadlineReviewLabel, calendarDay, calendarRange, moveCalendar, occurrenceDay, occursOnDay } from "../src/react-app/domains/calendar/calendar-format";

function event(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
  return { id: "entry", itemId: "entry", uid: "entry", projectId: "project", projectName: "Project", kind: "event", title: "Meeting", start: "2026-10-01", end: null, allDay: true, timeZone: "Europe/Berlin", status: "active", assigneeUserId: null, provenance: null, verified: true, recurring: false, ...overrides };
}

describe("calendar navigation", () => {
  test("weeks start on Monday and cross month and year boundaries", () => {
    const range = calendarRange(new Date(2026, 9, 4), "week");
    expect([range.from, range.to]).toEqual(["2026-09-28", "2026-10-05"]);
    const year = calendarRange(new Date(2027, 0, 1), "week");
    expect([year.from, year.to]).toEqual(["2026-12-28", "2027-01-04"]);
  });
  test("weekly navigation keeps the weekday through daylight-saving transitions", () => {
    const next = moveCalendar(new Date(2026, 2, 27), "week", 1);
    expect(calendarDay(next)).toBe("2026-04-03");
    expect(calendarDay(moveCalendar(next, "week", -1))).toBe("2026-03-27");
  });
  test("month navigation from the 31st does not skip February", () => {
    const next = moveCalendar(new Date(2026, 0, 31), "month", 1);
    expect(calendarDay(next)).toBe("2026-02-01");
    const agenda = calendarRange(next, "agenda");
    expect([agenda.from, agenda.to]).toEqual(["2026-02-01", "2026-03-01"]);
  });
});

describe("calendar day placement", () => {
  test("date-only deadlines never shift with a time zone", () => {
    expect(occurrenceDay(event({ timeZone: "America/Los_Angeles" }))).toBe("2026-10-01");
    expect(occursOnDay(event(), "2026-10-02")).toBe(false);
  });
  test("uses the event's time zone for a timestamp and preserves floating time", () => {
    expect(occurrenceDay(event({ allDay: false, start: "2026-10-01T23:30:00Z" }))).toBe("2026-10-02");
    expect(occurrenceDay(event({ allDay: false, start: "2026-10-01T23:30:00" }))).toBe("2026-10-01");
  });
  test("all-day events span days but exclude DTEND", () => {
    const item = event({ start: "2026-09-30", end: "2026-10-03" });
    expect(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"].map(day => occursOnDay(item, day))).toEqual([false, true, true, true, false]);
  });
  test("timed events ending at midnight do not occupy the following day", () => {
    const item = event({ allDay: false, start: "2026-09-30T20:00:00+02:00", end: "2026-10-02T00:00:00+02:00" });
    expect(occursOnDay(item, "2026-10-01")).toBe(true);
    expect(occursOnDay(item, "2026-10-02")).toBe(false);
    expect(occursOnDay({ ...item, end: "2026-10-02T00:30:00+02:00" }, "2026-10-02")).toBe(true);
  });
  test("zero-length events remain visible on their start date", () => {
    expect(occursOnDay(event({ end: "2026-10-01" }), "2026-10-01")).toBe(true);
  });
});

test("manual entry is distinguished from an unreviewed calculation or override", () => {
  expect(deadlineReviewLabel(event({ verified: false, provenance: { kind: "manual", source: "", reason: "" } }))).toBe("Entered manually");
  expect(deadlineReviewLabel(event({ verified: false, provenance: { kind: "manual", source: "", reason: "Changed calculated date" } }))).toBe("Needs review");
  expect(deadlineReviewLabel(event({ verified: false, provenance: { kind: "imported", source: "calendar.ics" } }))).toBe("Needs review");
  expect(deadlineReviewLabel(event({ verified: true }))).toBe("Deadline reviewed");
});
