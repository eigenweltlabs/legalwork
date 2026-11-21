import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { CalendarGrid } from "../src/react-app/domains/calendar/calendar-grid";
import { calendarDisplayColor } from "../src/react-app/domains/calendar/calendar-colors";
import { calendarDay } from "../src/react-app/domains/calendar/calendar-format";
import { WorkdayTimeline } from "../src/react-app/domains/back-office/timesheet-workday-view";

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
  matters: [{ id: "case", name: "Matter Example", reference: "", clientIds: [] }],
  projects: [{ id: "workspace", name: "Work area", matterIds: [] }],
  policies: [],
};

function documentFor(markup: string) {
  const document = new Window().document;
  document.body.innerHTML = markup;
  return document;
}

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

test("the local current-time marker spans the matter calendar once", () => {
  const today = calendarDay(new Date());
  const document = documentFor(renderToStaticMarkup(
    <WorkdayTimeline date={today} proposals={[{ ...untimed, date: today }]}
      state={state} selected={undefined} view="matters" onOpen={() => {}} />,
  ));
  expect(document.querySelectorAll("[data-calendar-column]").length).toBe(2);
  expect(document.querySelectorAll("[data-calendar-now]").length).toBe(1);
  expect(document.querySelector("[data-calendar-now]")?.textContent).toContain("Current time");
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
