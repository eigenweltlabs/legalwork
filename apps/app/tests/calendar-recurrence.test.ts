import { expect, test } from "bun:test";
import { calendarRecurrence } from "../src/react-app/domains/calendar/calendar-recurrence";

test("weekly rules expose the interval, selected weekdays and a bounded series", () => {
  expect(calendarRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10"])).toEqual({
    frequency: "WEEKLY", interval: 2, days: ["MO", "WE", "FR"], monthDays: [], count: 10, until: null, advanced: false,
  });
});
test("monthly rules retain ordinal weekdays and all-day or timed end dates", () => {
  expect(calendarRecurrence(["RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z"])).toMatchObject({ frequency: "MONTHLY", interval: 1, days: ["-1FR"], until: "2027-12-31" });
  expect(calendarRecurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20271231"])).toMatchObject({ monthDays: ["15"], until: "2027-12-31" });
});
test("missing schedules stay unknown and custom exceptions point to the source calendar", () => {
  expect(calendarRecurrence([])).toBeNull();
  expect(calendarRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=0;BYDAY=MO", "EXDATE:20261102T090000Z"])).toMatchObject({ interval: 1, advanced: true });
  expect(calendarRecurrence(["RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=MO;BYSETPOS=1"])).toMatchObject({ frequency: "YEARLY", advanced: true });
});
