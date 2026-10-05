import { expect, test } from "bun:test";
import { reminderInstant } from "./reminder-dates.js";

const calculation = { deadlineDay: "2026-10-24", cutoff: "2026-10-24T21:59:59.999Z", timeZone: "Europe/Berlin" };

test("recurring calculated reminders use each occurrence's cutoff and preserve the local clock across DST", () => {
  expect(reminderInstant("2026-10-24", "Europe/Berlin", true, calculation)).toBe("2026-10-24T21:59:59.999Z");
  expect(reminderInstant("2026-10-25", "Europe/Berlin", true, calculation)).toBe("2026-10-25T22:59:59.999Z");
  expect(reminderInstant("2026-10-26", "Europe/Berlin", true, calculation)).toBe("2026-10-26T22:59:59.999Z");
});

test("retains one-off cutoffs and an exclusive next-day midnight cutoff", () => {
  expect(reminderInstant("2026-10-24", "Europe/Berlin", false, calculation)).toBe(calculation.cutoff);
  expect(reminderInstant("2026-10-26", "Europe/Berlin", true, { ...calculation, cutoff: "2026-10-24T22:00:00Z" })).toBe("2026-10-26T23:00:00.000Z");
});

test("keeps ordinary and explicitly timed recurrence reminders at their own instant", () => {
  expect(reminderInstant("2026-10-26T16:00:00Z", "Europe/Berlin", true, calculation)).toBe("2026-10-26T16:00:00.000Z");
  expect(reminderInstant("2026-10-26", "Europe/Berlin", false)).toBe("2026-10-25T23:00:00.000Z");
});

test("rejects invalid receipt cutoffs instead of silently queueing an invalid date", () => {
  expect(() => reminderInstant("2026-10-24", "Europe/Berlin", false, { ...calculation, cutoff: "invalid" })).toThrow("Invalid calculation cutoff");
});
