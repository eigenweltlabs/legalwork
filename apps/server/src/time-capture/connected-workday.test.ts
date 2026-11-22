import { expect, test } from "bun:test";
import type { CaptureAccount } from "@legalwork/types/time-capture";
import { accountWorkdayEvidence, sourceAvailable } from "./connected-workday.js";
import { workdayEvidence } from "./private-workday.js";

const key = "c".repeat(64);
const account = (provider: CaptureAccount["provider"]) => ({ provider, account: key });
const signal = new AbortController().signal;
const day = "2026-11-12",
  zone = "Europe/Vienna";
test("mail opt-in reads sent subjects for the local date without bodies, recipients, an inferred duration or matter", async () => {
  const paths: string[] = [];
  const result = await accountWorkdayEvidence(
    account("gmail"),
    day,
    zone,
    async (path, opt) => {
      paths.push(path);
      expect(opt?.signal).toBe(signal);
      if (path.includes("format=metadata"))
        return {
          labelIds: ["SENT"], threadId: "thread-fixture", internalDate: String(Date.parse("2026-11-11T23:00:00Z")),
          payload: { headers: [{ name: "Subject", value: "Synthetic heading" }] },
        };
      return { messages: [{ id: "m1" }] };
    },
    signal,
  );
  expect(new URL("https://example.test" + paths[0]).searchParams.get("q")).toContain("-in:spam");
  expect(paths[1]).not.toMatch(/From|To|body|snippet|format=full/i);
  expect(result[0]?.proposal).toMatchObject({
    source: "gmail", mailDirection: "sent",
    narrative: "Synthetic heading",
    startAt: null,
    endAt: null,
    workedMinutes: null,
    projectId: null,
  });
  const proposal = result[0]!.proposal;
  expect(sourceAvailable(proposal, [account("gmail")], { calendar: true, tasks: true })).toBe(true);
  expect(sourceAvailable(proposal, [account("gmail")], { calendar: false, tasks: false, disabledConnections: [account("gmail")] })).toBe(false);
  expect(
    sourceAvailable(proposal, [], { calendar: false, tasks: false, connections: [account("gmail")] }),
  ).toBe(false);
  expect(
    sourceAvailable(proposal, [account("gmail")], {
      calendar: false,
      tasks: false,
      connections: [account("gmail")],
    }),
  ).toBe(true);
});
test("Outlook validates the next page before requesting it and requests metadata only", async () => {
  const paths: string[] = [];
  await expect(
    accountWorkdayEvidence(
      account("outlook"),
      day,
      zone,
      async (path) => {
        if (path.startsWith("/v1.0/me?")) return { mail: "worker@example.test" };
        if (path.includes("/mailFolders/")) return { id: path };
        paths.push(path);
        return { value: [], "@odata.nextLink": "https://evil.test/v1.0/me/messages?skiptoken=private" };
      },
      signal,
    ),
  ).rejects.toMatchObject({ code: "invalid_page_token" });
  expect(paths).toHaveLength(1);
  expect(paths[0]).toStartWith("/v1.0/me/messages?");
  expect(paths[0]).not.toMatch(/bodyPreview|toRecipients|attachments/);
});
test("connected primary calendar and equivalent LegalWork occurrence share identity, with clock duration", async () => {
  const start = "2026-11-12T13:00:00+01:00",
    end = "2026-11-12T13:35:00+01:00";
  const [external] = await accountWorkdayEvidence(
    account("google-calendar"),
    day,
    zone,
    async (path) => {
      if (path.includes("/calendarList?")) return { items: [] };
      expect(path).toStartWith("/calendar/v3/calendars/primary/events?");
      return {
        items: [
          {
            id: "ev1",
            iCalUID: "event@example",
            summary: "Synthetic appointment",
            status: "confirmed",
            start: { dateTime: start },
            end: { dateTime: end },
          },
          { id: "ev2", summary: "Cancelled", status: "cancelled" },
        ],
      };
    },
    signal,
  );
  expect(external?.proposal).toMatchObject({ workedMinutes: 35, projectId: null });
  const [internal] = workdayEvidence(
    [
      {
        id: "internal",
        itemId: "internal",
        uid: "event@example",
        projectId: "project",
        projectName: "Synthetic",
        kind: "event",
        title: "Imported",
        start,
        end,
        timeZone: zone,
        allDay: false,
        status: "active",
        assigneeUserId: null,
        provenance: null,
        verified: true,
        recurring: false,
      },
    ],
    day,
    { calendar: true, tasks: false, intervalMinutes: 0 },
  );
  expect(external?.eventKey).toBe(internal?.eventKey);
});
test("Graph calendar uses UTC and omits all-day duration, cancellations and items outside the requested day", async () => {
  const result = await accountWorkdayEvidence(
    account("outlook-calendar"),
    day,
    zone,
    async (path, opts) => {
      if (path.startsWith("/v1.0/me/calendars?")) return { value: [] };
      expect(path).toStartWith("/v1.0/me/calendar/calendarView?");
      expect(opts?.headers?.Prefer).toContain('outlook.timezone="UTC"');
      return {
        value: [
          {
            id: "1",
            subject: "Across midnight",
            start: { dateTime: "2026-11-11T22:30:00" },
            end: { dateTime: "2026-11-11T23:30:00" },
          },
          {
            id: "2",
            subject: "All day",
            isAllDay: true,
            start: { dateTime: "2026-11-12T00:00:00" },
            end: { dateTime: "2026-11-13T00:00:00" },
          },
          { id: "3", isCancelled: true },
          {
            id: "4",
            subject: "Another day",
            start: { dateTime: "2026-11-13T15:00:00" },
            end: { dateTime: "2026-11-13T15:30:00" },
          },
        ],
      };
    },
    signal,
  );
  expect(result.map((item) => item.proposal.workedMinutes)).toEqual([30, null]);
});

test("Google Calendar preserves an unspecified end, applies the event timezone and excludes a worker decline on an owned secondary calendar", async () => {
  const rows = await accountWorkdayEvidence(account("google-calendar"), day, zone, async path => {
    if (path.includes("/calendarList?")) return { items: [
      { id: "worker@example.test", primary: true, accessRole: "owner" }, { id: "second", accessRole: "owner" }] };
    const event = { summary: "New York appointment", start: { dateTime: day + "T09:00:00.125", timeZone: "America/New_York" },
      end: { dateTime: day + "T10:00:00", timeZone: "America/New_York" } };
    if (path.includes("/primary/")) return { items: [{ ...event, id: "no-end", endTimeUnspecified: true },
      { ...event, id: "timed" }] };
    expect(path).toContain("email");
    return { items: [{ ...event, id: "declined", attendees: [{ self: true, email: "shared@example.test" },
      { email: "worker@example.test", responseStatus: "declined" }] }] };
  }, signal);
  expect(rows.map(row => row.proposal)).toMatchObject([
    { observedAt: day + "T14:00:00.125Z", startAt: null, endAt: null, workedMinutes: null },
    { startAt: day + "T14:00:00.125Z", endAt: day + "T15:00:00.000Z", workedMinutes: 60 } ]);
});
