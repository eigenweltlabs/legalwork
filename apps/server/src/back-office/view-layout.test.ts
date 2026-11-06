import { expect, test } from "bun:test";
import {
  BackOfficeRecordSchema,
  defaultBackOfficeModel,
} from "@legalwork/types/back-office";
import {
  calendarDays,
  dayKey,
  groupViewRecords,
  moveCalendarDate,
  recordDay,
} from "./schema.js";

const now = "2026-11-06T10:00:00.000Z";
const record = (values: Record<string, string | null>) =>
  BackOfficeRecordSchema.parse({
    id: crypto.randomUUID(),
    objectId: "matters",
    values,
    revision: 1,
    schemaRevision: 1,
    ownerId: "owner",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
test("Kanban retains empty stages, record identity and a No Value column", () => {
  const field = defaultBackOfficeModel().objects[0].fields.find(
    (field) => field.id === "status",
  )!;
  const active = record({ name: "Active", status: "Active" }),
    blank = record({ name: "Blank", status: null });
  const groups = groupViewRecords([active, blank], field, []);
  expect(groups.map((group) => group.value)).toEqual([...field.options, null]);
  expect(groups.find((group) => group.value === "Active")?.records).toEqual([
    active,
  ]);
  expect(groups.at(-1)?.records).toEqual([blank]);
});
test("calendar periods cover month boundaries, leap years and both week starts", () => {
  const november = calendarDays(new Date(2026, 10, 6, 12), "month", 0);
  expect(november).toHaveLength(35);
  expect(dayKey(november[0])).toBe("2026-11-01");
  expect(dayKey(november.at(-1)!)).toBe("2026-12-05");
  const leap = calendarDays(new Date(2028, 1, 1, 12), "month", 1);
  expect(leap.map(dayKey)).toContain("2028-02-29");
  expect(leap[0].getDay()).toBe(1);
  expect(
    calendarDays(new Date(2026, 10, 6, 12), "week", 1).map(dayKey),
  ).toEqual([
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-07",
    "2026-11-08",
  ]);
  expect(calendarDays(new Date(2026, 10, 6, 12), "day", 0)).toHaveLength(1);
});
test("calendar moves retain wall-clock time and keep date-only values date-only", () => {
  const field = defaultBackOfficeModel().objects[0].fields.find(
    (field) => field.id === "openedOn",
  )!;
  expect(moveCalendarDate("2026-11-06", field, "2026-12-01")).toBe(
    "2026-12-01",
  );
  const initial = new Date(2026, 9, 24, 10, 30),
    moved = new Date(
      moveCalendarDate(
        initial.toISOString(),
        { ...field, type: "datetime" },
        "2026-10-26",
      ),
    );
  expect(moved.getHours()).toBe(10);
  expect(moved.getMinutes()).toBe(30);
  expect(dayKey(moved)).toBe("2026-10-26");
  expect(recordDay(record({ name: "Undated" }), "openedOn")).toBeNull();
  expect(
    recordDay(record({ name: "Dated", openedOn: "2026-11-06" }), "openedOn"),
  ).toBe("2026-11-06");
});
