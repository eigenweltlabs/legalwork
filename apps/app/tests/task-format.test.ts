import { describe, expect, test } from "bun:test";

import {
  TASK_PRIORITIES,
  formatTaskDate,
  formatTaskDueDate,
  formatTaskListDate,
  priorityForKey,
  taskDueDateInputValue,
  taskDueTone,
  taskMemberOptions,
} from "../src/react-app/domains/tasks/task-format";

describe("priorities", () => {
  test("are offered in Linear's order and picked by their digit", () => {
    expect(TASK_PRIORITIES).toEqual([0, 1, 2, 3, 4]);
    const plain = { metaKey: false, ctrlKey: false, altKey: false };
    expect(priorityForKey({ key: "0", ...plain })).toBe(0);
    expect(priorityForKey({ key: "4", ...plain })).toBe(4);
    expect(priorityForKey({ key: "5", ...plain })).toBeNull();
    expect(priorityForKey({ key: "a", ...plain })).toBeNull();
    // A digit with a modifier is somebody else's shortcut.
    expect(priorityForKey({ key: "1", ...plain, metaKey: true })).toBeNull();
  });
});

// Monday 14 September 2026, 15:00 local time. Local components throughout, so
// the day boundaries the helper reasons about are the machine's own.
const now = new Date(2026, 8, 14, 15, 0);
const iso = (year: number, month: number, day: number, hour = 9, minute = 40) =>
  new Date(year, month, day, hour, minute).toISOString();

describe("formatTaskListDate", () => {
  test("today is a time", () => {
    expect(formatTaskListDate(iso(2026, 8, 14), { now, locale: "en" })).toMatch(/9:40/);
  });

  test("the last six days are a weekday", () => {
    expect(formatTaskListDate(iso(2026, 8, 13), { now, locale: "en" })).toBe("Sun");
    expect(formatTaskListDate(iso(2026, 8, 8), { now, locale: "en" })).toBe("Tue");
  });

  test("a week ago and older is a short date", () => {
    expect(formatTaskListDate(iso(2026, 8, 7), { now, locale: "en" })).toBe("Sep 7");
    expect(formatTaskListDate(iso(2026, 7, 25), { now, locale: "en" })).toBe("Aug 25");
  });

  test("another year carries the year", () => {
    expect(formatTaskListDate(iso(2025, 8, 3), { now, locale: "en" })).toBe("Sep 3, 2025");
  });

  test("follows the language", () => {
    expect(formatTaskListDate(iso(2026, 7, 25), { now, locale: "de" })).toBe("25. Aug.");
    // Browsers abbreviate with a dot ("So."), Bun's ICU without; both are the weekday.
    expect(formatTaskListDate(iso(2026, 8, 13), { now, locale: "de" })).toMatch(/^So\.?$/);
    expect(formatTaskListDate(iso(2026, 8, 14), { now, locale: "de" })).toMatch(/^0?9:40$/);
  });

  test("missing or invalid input renders empty", () => {
    expect(formatTaskListDate(null, { now })).toBe("");
    expect(formatTaskListDate(undefined, { now })).toBe("");
    expect(formatTaskListDate("not a date", { now })).toBe("");
  });
});

describe("formatTaskDate", () => {
  test("is the full date", () => {
    expect(formatTaskDate(iso(2026, 8, 7), { locale: "en" })).toBe("Sep 7, 2026");
    expect(formatTaskDate(iso(2026, 8, 7), { locale: "de" })).toBe("7. Sept. 2026");
  });

  test("renders nothing for a missing value", () => {
    expect(formatTaskDate(null)).toBe("");
  });
});

describe("formatTaskDueDate", () => {
  test("a date-only deadline (local midnight) is the day, without a time", () => {
    expect(formatTaskDueDate(iso(2026, 8, 18, 0, 0), { now, locale: "en" })).toBe("Sep 18");
    expect(formatTaskDueDate(iso(2026, 8, 18, 0, 0), { now, locale: "de" })).toBe("18. Sept.");
  });

  test("a deadline with a time shows it", () => {
    expect(formatTaskDueDate(iso(2026, 8, 18, 14, 30), { now, locale: "en" })).toBe("Sep 18, 2:30 PM");
  });

  test("another year carries the year", () => {
    expect(formatTaskDueDate(iso(2027, 0, 5, 0, 0), { now, locale: "en" })).toBe("Jan 5, 2027");
  });

  test("renders nothing for a missing value", () => {
    expect(formatTaskDueDate(null, { now })).toBe("");
  });
});

describe("taskDueTone", () => {
  test("yesterday is overdue, today is today, tomorrow is later", () => {
    expect(taskDueTone(iso(2026, 8, 13, 23, 59), now)).toBe("overdue");
    expect(taskDueTone(iso(2026, 8, 14, 0, 0), now)).toBe("today");
    expect(taskDueTone(iso(2026, 8, 15, 0, 0), now)).toBe("later");
    expect(taskDueTone(null, now)).toBeNull();
  });
});

describe("taskDueDateInputValue", () => {
  test("is the local calendar day, zero-padded, or empty", () => {
    expect(taskDueDateInputValue(iso(2026, 8, 5, 0, 0))).toBe("2026-09-05");
    expect(taskDueDateInputValue(null)).toBe("");
    expect(taskDueDateInputValue("nope")).toBe("");
  });
});

describe("taskMemberOptions", () => {
  const member = (userId: string, name: string | null, email: string | null) => ({ userId, name, email, role: "org:member" });

  test("shows the email under a name, and in the chip only for a name two members share", () => {
    const [work, yavio, solo] = taskMemberOptions([
      member("u1", "Johann Machemer", "johann@eigenweltlabs.com"),
      member("u2", "Johann Machemer", "johann@yavio.ai"),
      member("u3", "Anna Schmidt", "anna@kanzlei.de"),
    ]);
    expect(work).toEqual({ value: "u1", label: "Johann Machemer (johann@eigenweltlabs.com)", primary: "Johann Machemer", detail: "johann@eigenweltlabs.com" });
    expect(yavio.label).toBe("Johann Machemer (johann@yavio.ai)");
    expect(solo).toEqual({ value: "u3", label: "Anna Schmidt", primary: "Anna Schmidt", detail: "anna@kanzlei.de" });
  });

  test("falls back to the email, then the id, without a second line", () => {
    const [emailOnly, bare] = taskMemberOptions([member("u4", null, "johann@johann-machemer.de"), member("u5", null, null)]);
    expect(emailOnly).toEqual({ value: "u4", label: "johann@johann-machemer.de", primary: "johann@johann-machemer.de" });
    expect(bare).toEqual({ value: "u5", label: "u5", primary: "u5" });
  });
});
