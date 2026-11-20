import { expect, test } from "bun:test";
import { captureProposalSchema } from "@legalwork/types/time-capture";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import { adjacentPeriod, periodDates } from "../src/react-app/domains/back-office/timesheet-row";
import { proposalValues, timeRecordDate } from "../src/react-app/domains/back-office/time-record-values";
import { conflictingTimeFields, copyTimeRecordValues, timeCellChanges } from "../src/react-app/domains/back-office/time-record-edits";

const state = TimesheetStateSchema.parse({ userId: "worker", scope: "local", canManage: true, canReview: true,
  entries: [], matters: [{ id: "matter", name: "Demo", reference: "", clientIds: ["client"] }],
  clients: [{ id: "client", name: "Demo client" }], projects: [{ id: "project", name: "Demo project", matterIds: ["matter"] }],
  people: [], products: [], policies: [], invoices: [] });

test("stopwatch rows infer both minute fields from exact elapsed time and the effective project rule", () => {
  for (const [seconds, up, nearest] of [[601, 20, 10], [899, 20, 10], [900, 20, 20], [10, 10, 0]]) {
    const proposal = captureProposalSchema.parse({ key: crypto.randomUUID(), digest: "0".repeat(64), date: "2026-11-18", source: "stopwatch",
      projectId: "project", activity: "RES", narrative: "Private source", workedMinutes: Math.round(seconds / 60) || null,
      startAt: "2026-11-18T10:00:00.000Z", endAt: new Date(Date.parse("2026-11-18T10:00:00Z") + seconds * 1000).toISOString(), dismissed: false });
    const original = structuredClone(proposal);
    expect(proposalValues(proposal, state)).toMatchObject({ recordedMinutes: up, billableMinutes: up });
    const nearestState = { ...state, policies: [{ scope: "project", targetId: "project", effectiveFrom: "2026-11-01", revision: 1, stopwatchRoundUp: false }] } satisfies typeof state;
    expect(proposalValues(proposal, nearestState)).toMatchObject({ recordedMinutes: nearest, billableMinutes: nearest });
    expect(proposalValues(proposal, { ...nearestState, policies: nearestState.policies.map(policy => ({ ...policy, incrementMinutes: 6 })) }).recordedMinutes).toBe(Math.round(seconds / 360) * 6);
    expect(proposal).toEqual(original);
  }
});

test("date-only service dates stay on their selected day across time zones", () => {
  const previous = process.env.TZ;
  try {
    for (const timezone of ["Europe/Vienna", "America/Los_Angeles"]) {
      process.env.TZ = timezone;
      expect(timeRecordDate("2026-11-18")).toBe("2026-11-18");
      expect(timeRecordDate(new Date(2026, 10, 18, 23, 30).toISOString())).toBe("2026-11-18");
      expect(timeRecordDate("2026-11-19T00:05:00.000Z", "2026-11-18")).toBe("2026-11-18");
      expect(timeRecordDate("2026-11-18T00:05:00+05:00")).toBe("2026-11-18");
      expect(timeRecordDate(null)).toBe("");
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("record sheet edits preserve genuine clocks when the selected service date stays the same", () => {
  const serviceDate = "2026-11-18";
  const startedAt = "2026-11-19T00:00:00.000Z", endedAt = "2026-11-19T00:10:00.000Z";
  const proposal = captureProposalSchema.parse({ key: crypto.randomUUID(), digest: "0".repeat(64), date: serviceDate,
    source: "stopwatch", projectId: "project", activity: "RES", narrative: "Private source", workedMinutes: 10, startAt: startedAt, endAt: endedAt, dismissed: false });
  const values = proposalValues(proposal, state), clientForMatter = () => null;
  expect(values).toMatchObject({ startedAt, endedAt, serviceDate });
  expect(timeCellChanges(values, { startedAt: serviceDate }, serviceDate, undefined, clientForMatter)).toEqual({});
  const nextDay = "2026-11-20";
  const move = timeCellChanges(values, { startedAt: nextDay }, serviceDate, undefined, clientForMatter);
  expect(move).toEqual({ startedAt: nextDay, serviceDate: nextDay, endedAt: null });
  expect(conflictingTimeFields(move, ["serviceDate"])).toEqual(new Set(["startedAt", "serviceDate", "endedAt"]));
  expect(copyTimeRecordValues(values, [], nextDay, "member:worker", true)).toMatchObject({ startedAt: nextDay, serviceDate: nextDay, endedAt: null });
});


test("monthly navigation clamps the service day and includes every day of a leap February", () => {
  expect(adjacentPeriod("2028-01-31", "month", 1)).toBe("2028-02-29");
  expect(adjacentPeriod("2027-03-31", "month", -1)).toBe("2027-02-28");
  const dates = periodDates("2028-02-12", "month");
  expect([dates[0], dates.at(-1), dates.length]).toEqual(["2028-02-01", "2028-02-29", 29]);
});
