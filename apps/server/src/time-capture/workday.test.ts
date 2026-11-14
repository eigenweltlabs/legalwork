import { expect, test } from "bun:test";
import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { workdayEvidence } from "./private-workday.js";
const sample: CalendarOccurrence = {
  id: "local:event",
  itemId: "evt",
  uid: "evt",
  projectId: "m",
  projectName: "Sample",
  kind: "event",
  title: "Synthetic event",
  start: "2026-11-12T09:15:00",
  end: "2026-11-12T09:39:00",
  timeZone: "Europe/Vienna",
  allDay: false,
  status: "active",
  assigneeUserId: null,
  provenance: null,
  verified: true,
  recurring: false,
};

test("calendar opt-in preserves real instants and minutes, deduplicates evidence and ignores deadlines", () => {
  const day = "2026-11-12",
    settings = { calendar: true, tasks: false, intervalMinutes: 0 as const };
  expect(workdayEvidence([sample], day, { ...settings, calendar: false })).toEqual([]);
  const result = workdayEvidence(
    [
      sample,
      { ...sample, id: "duplicate" },
      { ...sample, kind: "deadline" },
      { ...sample, status: "cancelled" },
    ],
    day,
    settings,
  );
  expect(result).toHaveLength(1);
  expect(result[0]?.proposal).toMatchObject({ startAt: "2026-11-12T08:15:00.000Z", workedMinutes: 24 });
  expect(result[0]?.proposal.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(workdayEvidence([sample], "2026-11-13", settings)).toEqual([]);
});
test("completed task only provides context without invented working time", () => {
  const settings = { calendar: false, tasks: true, intervalMinutes: 0 as const };
  const task: CalendarOccurrence = {
    ...sample,
    kind: "task",
    allDay: true,
    start: "2026-11-12",
    end: null,
    status: "done",
  };
  expect(
    workdayEvidence([task, { ...task, status: "open" }], "2026-11-12", settings).map((x) => x.proposal),
  ).toMatchObject([{ workedMinutes: null, startAt: null, endAt: null }]);
});
