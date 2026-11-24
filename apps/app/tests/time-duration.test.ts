import { expect, test } from "bun:test";
import { formatTimeDuration, parseTimeDuration, isTimeDurationField } from "../src/react-app/domains/back-office/time-duration";

test("duration shorthand follows the selected input format while stored values remain minutes", () => {
  for (const format of ["hours", "minutes"] as const) {
    expect(parseTimeDuration("38", format)).toBe(38);
    expect(parseTimeDuration("1:38", format)).toBe(98);
    expect(parseTimeDuration("", format)).toBeNull();
    expect(parseTimeDuration("0", format)).toBe(0);
  }
  expect(parseTimeDuration("138", "hours")).toBe(98);
  expect(parseTimeDuration("138", "minutes")).toBe(138);
  expect(formatTimeDuration(138, "hours")).toBe("2:18");
  expect(formatTimeDuration(98, "hours")).toBe("1:38");
  expect(formatTimeDuration(98, "minutes")).toBe("98");
  expect(parseTimeDuration("60", "hours")).toBe(60);
  expect(parseTimeDuration("2400", "hours")).toBe(1440);
  expect(formatTimeDuration(6000, "hours")).toBe("100:00");
});

test("ambiguous or invalid input is rejected without treating malformed HHMM as minute counts", () => {
  for (const value of ["160", "199", "1:60", "-1", "1.5", "1e2", "abc", "1:"])
    expect(() => parseTimeDuration(value, "hours")).toThrow();
  expect(parseTimeDuration("160", "minutes")).toBe(160);
  expect(isTimeDurationField("timeEntries", "recordedMinutes")).toBe(true);
  expect(isTimeDurationField("timeEntries", "hourlyRate")).toBe(false);
  expect(isTimeDurationField("matters", "recordedMinutes")).toBe(false);
});
