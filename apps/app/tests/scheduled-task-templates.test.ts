import { expect, test } from "bun:test";
import { localDateTime, suggestedSchedule } from "../src/react-app/domains/scheduled-tasks/schedule-format";

test("morning routines skip the weekend once Friday's time has passed", () => {
  const schedule = suggestedSchedule("weekdays", 6, new Date(2026, 9, 9, 10));
  expect(schedule).toMatchObject({ kind: "rrule", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" });
  expect(localDateTime(schedule.startAt, schedule.timeZone)).toBe("2026-10-12T06:00");
});

test("weekly reviews choose Friday at 16:00, including a later run today", () => {
  const before = suggestedSchedule("friday", 16, new Date(2026, 9, 9, 15));
  const after = suggestedSchedule("friday", 16, new Date(2026, 9, 9, 16));
  expect(before).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=FR" });
  expect(localDateTime(before.startAt, before.timeZone)).toBe("2026-10-09T16:00");
  expect(localDateTime(after.startAt, after.timeZone)).toBe("2026-10-16T16:00");
});

test("daily schedules retain weekends and roll over the year", () => {
  const weekend = suggestedSchedule("daily", 10, new Date(2026, 9, 10, 9));
  const nextYear = suggestedSchedule("daily", 10, new Date(2026, 11, 31, 11));
  expect(weekend).toMatchObject({ rrule: "FREQ=DAILY" });
  expect(localDateTime(weekend.startAt, weekend.timeZone)).toBe("2026-10-10T10:00");
  expect(localDateTime(nextYear.startAt, nextYear.timeZone)).toBe("2027-01-01T10:00");
});

test("weekly planning starts on Monday morning", () => {
  const schedule = suggestedSchedule("monday", 9, new Date(2026, 9, 9, 17));
  expect(schedule).toMatchObject({ rrule: "FREQ=WEEKLY;BYDAY=MO" });
  expect(localDateTime(schedule.startAt, schedule.timeZone)).toBe("2026-10-12T09:00");
});
