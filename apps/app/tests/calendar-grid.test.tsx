import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaptureProposal, CaptureState } from "@legalwork/types/time-capture";
import { calendarTimeRange } from "../src/react-app/domains/calendar/calendar-range-selection";
import { CalendarGrid } from "../src/react-app/domains/calendar/calendar-grid";
import { calendarDisplayColor } from "../src/react-app/domains/calendar/calendar-colors";
import { calendarDay } from "../src/react-app/domains/calendar/calendar-format";
import { WorkdayTimeline } from "../src/react-app/domains/back-office/timesheet-workday-view";
import { appointmentBookingId, appointmentSeed, rangeInstant } from "../src/react-app/domains/back-office/timeline-time-entry";
import { localRecordInstant, timeRecordDate } from "../src/react-app/domains/back-office/time-record-values";
import { matterOptions } from "../src/react-app/domains/back-office/timesheet-row";

const anchor = new Date(2026, 10, 19, 12);
const date = calendarDay(anchor);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (time: string) => new Date(date + "T" + time).toISOString();
const proposal: CaptureProposal = {
  key: "review", digest: "a".repeat(64), date, source: "calendar", projectId: "workspace",
  matterId: "case", activity: "RES", narrative: "Review correspondence", dismissed: false,
  startAt: clock("09:00:00"), endAt: clock("09:45:00"), workedMinutes: 45,
};
const unassigned: CaptureProposal = { ...proposal, key: "unassigned", narrative: "Research", matterId: undefined };
const untimed: CaptureProposal = { ...proposal, key: "draft", narrative: "Draft reply", startAt: null, endAt: null };
const state = {
  matters: [
    { id: "case", name: "Matter Example", reference: "", clientIds: [] },
    { id: "replacement", name: "Reassigned matter", reference: "R2", clientIds: ["client"] },
  ],
  projects: [{ id: "workspace", name: "Work area", matterIds: [] }],
  clients: [{ id: "client", name: "Client Example" }],
  policies: [],
};

function documentFor(markup: string) {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document;
}

test("empty timeline ranges snap in both directions and stop at the end of the day", () => {
  expect(calendarTimeRange(601, 601, false)).toEqual({ start: 600, end: 630 });
  expect(calendarTimeRange(601, 660, true)).toEqual({ start: 600, end: 660 });
  expect(calendarTimeRange(663, 600, true)).toEqual({ start: 600, end: 660 });
  expect(calendarTimeRange(600, 604, true)).toEqual({ start: 600, end: 615 });
  expect(calendarTimeRange(1439, 1439, false)).toEqual({ start: 1425, end: 1440 });
  expect(calendarTimeRange(1370, 1490, true)).toEqual({ start: 1365, end: 1440 });
});

test("calendar conversion uses the selected local day and does not guess all-day duration", async () => {
  const event = { id: "event", itemId: "event", uid: "uid", projectId: "workspace", projectName: "Project",
    kind: "event" as const, title: "Planning conference", start: rangeInstant(date, -30), end: rangeInstant(date, 60),
    timeZone, allDay: false, status: "active" as const, assigneeUserId: null, provenance: null, verified: true, recurring: false };
  const directory = { projects: [{ id: "workspace", name: "Project", matterIds: ["case"] }] };
  expect(appointmentSeed(event, date, directory)).toMatchObject({
    date, matterId: "case", narrative: event.title, startAt: rangeInstant(date, 0), endAt: rangeInstant(date, 60),
  });
  expect(appointmentSeed({ ...event, allDay: true }, date, directory)).not.toHaveProperty("startAt");
  expect(appointmentSeed({ ...event, end: null }, date, directory)).not.toHaveProperty("endAt");
  expect(appointmentSeed(event, date, { projects: [{ ...directory.projects[0], matterIds: ["a", "b"] }] }).matterId).toBeUndefined();
  const key = await appointmentBookingId("first worker", event.id, date);
  expect(await appointmentBookingId("first worker", event.id, date)).toBe(key);
  expect(await appointmentBookingId("second worker", event.id, date)).not.toBe(key);
  const storedStart = localRecordInstant(rangeInstant(date, 0));
  expect(timeRecordDate(storedStart)).toBe(date);
  expect(Date.parse(storedStart)).toBe(Date.parse(rangeInstant(date, 0)));
});

test("private day layouts share one calendar and preserve suggestion button attributes", () => {
  for (const view of ["combined", "matters"] as const) {
    const document = documentFor(renderToStaticMarkup(
      <WorkdayTimeline date={date} proposals={[proposal, unassigned, untimed, { ...proposal, key: "another-day", date: "2026-11-20" }]}
        state={state} selected={proposal.key} editorId="editor" view={view} onOpen={() => {}} />,
    ));
    expect(document.querySelectorAll("[data-calendar-time-grid]").length).toBe(1);
    expect(document.querySelectorAll("[data-calendar-hours]").length).toBe(1);
    expect(document.querySelector("[data-calendar-now]")).toBeNull();
    expect(document.querySelectorAll("[data-calendar-column]").length).toBe(view === "combined" ? 1 : 2);
    const review = document.querySelector('button[data-proposal-id="review"]');
    const neutral = document.querySelector('button[data-proposal-id="unassigned"]');
    expect(review?.getAttribute("class")).toContain(calendarDisplayColor("case").card);
    expect(review?.textContent).toContain("Matter Example");
    expect(neutral?.getAttribute("class")).toContain(calendarDisplayColor(null).card);
    expect(neutral?.textContent).toContain("Unassigned matter");
    expect(review?.getAttribute("aria-controls")).toBe("editor");
    expect(review?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-calendar-untimed] button[data-proposal-id="draft"]')).not.toBeNull();
    expect(document.querySelector('[data-proposal-id="another-day"]')).toBeNull();
    if (view === "combined") {
      expect(review?.getAttribute("style")).toContain("50%");
      expect(neutral?.getAttribute("style")).toContain("50%");
    } else {
      expect(review?.closest("[data-calendar-column]")?.getAttribute("data-calendar-column")).toBe("matter-case");
      expect(neutral?.closest("[data-calendar-column]")?.getAttribute("data-calendar-column")).toBe("unassigned");
    }
  }
});

test("saved private draft fields drive both calendar layouts and their accessible decision names", () => {
  const workflowMatter = matterOptions(state).find(option => option.matterId === "replacement")?.label;
  const valuesByMode = [
    { service: "workflow" as const, values: { workflow: true, matter: workflowMatter ?? "", matterId: "replacement", narrative: "Revised private wording" } },
    { service: "records" as const, values: { matter: "replacement", billingNarrative: "Revised private wording" } },
  ];
  for (const { service, values } of valuesByMode) {
    const saved = { date, proposalDigest: proposal.digest, revision: 3, values };
    const drafts: CaptureState["drafts"] = {
      [proposal.key]: saved,
      [untimed.key]: { ...saved, values: service === "workflow"
        ? { workflow: true, matter: "", matterId: null, narrative: "Revised untimed wording" }
        : { matter: null, billingNarrative: "Revised untimed wording" } },
      [unassigned.key]: { ...saved, proposalDigest: "b".repeat(64) },
    };
    for (const view of ["combined", "matters"] as const) {
      const document = documentFor(renderToStaticMarkup(
        <WorkdayTimeline date={date} state={{ ...state, service }} proposals={[proposal, unassigned, untimed]} drafts={drafts}
          selected={undefined} view={view} onOpen={() => {}} decisions={{ canAccept: true, onDecision: () => {}, onFocusedRemoval: () => {} }} />,
      ));
      const timed = document.querySelector(`[data-proposal-id="${proposal.key}"]`);
      const withoutTime = document.querySelector(`[data-proposal-id="${untimed.key}"]`);
      expect(timed?.getAttribute("aria-label")).toContain("Revised private wording");
      expect(timed?.getAttribute("aria-label")).toContain("Reassigned matter");
      expect(timed?.className).toContain(calendarDisplayColor("replacement").card);
      expect(timed?.textContent).not.toContain(proposal.narrative);
      expect(timed?.parentElement?.querySelector("[data-calendar-proposal-actions]")?.getAttribute("aria-label")).toBe("Revised private wording");
      expect(withoutTime?.getAttribute("aria-label")).toContain("Revised untimed wording · Unassigned matter");
      expect(withoutTime?.className).toContain(calendarDisplayColor(null).card);
      expect(document.querySelector(`[data-proposal-id="${unassigned.key}"]`)?.getAttribute("aria-label")).toContain(unassigned.narrative);
      if (view === "matters") expect(timed?.closest('[data-calendar-column="matter-replacement"]')).not.toBeNull();
    }
  }
});

test("the local current-time marker spans the matter calendar once", () => {
  const today = calendarDay(new Date());
  const document = documentFor(renderToStaticMarkup(
    <WorkdayTimeline date={today} proposals={[{ ...untimed, date: today }]}
      state={state} selected={undefined} view="matters" onOpen={() => {}} />,
  ));
  expect(document.querySelectorAll("[data-calendar-column]").length).toBe(1);
  expect(document.querySelector('[data-calendar-column="unassigned"]')).toBeNull();
  expect(document.querySelectorAll("[data-calendar-now]").length).toBe(1);
  expect(document.querySelector("[data-calendar-now]")?.textContent).toContain("Current time");
});

test("short and untimed private blocks each have a separate two-button decision pill", () => {
  const document = documentFor(renderToStaticMarkup(
    <WorkdayTimeline date={date} proposals={[{ ...proposal, endAt: clock("09:02:00") }, untimed]}
      state={state} selected={undefined} view="combined" onOpen={() => {}}
      decisions={{ canAccept: true, onDecision: () => {}, onFocusedRemoval: () => {} }} />,
  ));
  const rails = [...document.querySelectorAll("[data-calendar-proposal-actions]")];
  expect(rails).toHaveLength(2);
  for (const rail of rails) {
    const event = rail.parentElement?.previousElementSibling;
    expect(event?.matches("button[data-proposal-id]")).toBe(true);
    expect(event?.contains(rail)).toBe(false);
    expect([...rail.querySelectorAll("button")].map(button => button.title)).toEqual(["Dismiss suggestion", "Accept suggestion"]);
  }
  expect(document.querySelector('[data-calendar-untimed] [data-calendar-proposal-actions]')).not.toBeNull();
  const timedCard = document.querySelector('[data-calendar-column] button[data-proposal-id="review"]')?.parentElement;
  expect(parseFloat(timedCard?.style.height ?? "0")).toBeGreaterThanOrEqual(28);
});

test("the workday date and actions stay outside the scrolling hours in both day layouts", () => {
  for (const view of ["combined", "matters"] as const) {
    const document = documentFor(renderToStaticMarkup(
      <WorkdayTimeline date={date} proposals={[proposal]} state={state} view={view}
        selected={undefined} onOpen={() => {}} headerActions={<button>Calendar action</button>} />,
    ));
    const header = document.querySelector("[data-calendar-day-header]");
    const hours = document.querySelector("[data-calendar-time-grid]");
    expect(header?.textContent).toContain(String(anchor.getDate()));
    expect(header?.querySelector("button")?.textContent).toBe("Calendar action");
    expect(header?.nextElementSibling).toBe(hours);
    expect(hours?.querySelector("[data-calendar-hours]")).not.toBeNull();
  }
});

test("ordinary calendars retain navigable day headers and their standard all-day strip", () => {
  const document = documentFor(renderToStaticMarkup(
    <CalendarGrid view="day" anchor={anchor} start={anchor} timeZone={timeZone} showProjects
      items={[{ id: "all-day", itemId: "all-day", uid: "all-day", title: "Ordinary calendar note",
        kind: "event", start: date, end: null, timeZone, allDay: true,
        projectId: "workspace", projectName: "Work area", status: "active", assigneeUserId: null,
        provenance: null, verified: true, recurring: false }]}
      onOpen={() => {}} onDay={() => {}} />,
  ));
  expect(document.querySelector('[data-calendar-time-grid] button[aria-label^="View"]')).not.toBeNull();
  expect(document.body.textContent).toContain("All day");
  expect(document.querySelector("[data-proposal-id]")).toBeNull();
  expect(document.querySelector("[data-calendar-untimed]")).toBeNull();
});
