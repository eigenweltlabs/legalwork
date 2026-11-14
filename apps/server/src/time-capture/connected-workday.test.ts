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
          internalDate: String(Date.parse("2026-11-11T23:00:00Z")),
          payload: { headers: [{ name: "Subject", value: "Synthetic heading" }] },
        };
      return { messages: [{ id: "m1" }] };
    },
    signal,
  );
  expect(new URL("https://example.test" + paths[0]).searchParams.get("labelIds")).toBe("SENT");
  expect(paths[1]).not.toMatch(/From|To|body|snippet|format=full/i);
  expect(result[0]?.proposal).toMatchObject({
    source: "gmail",
    narrative: "Synthetic heading",
    startAt: null,
    endAt: null,
    workedMinutes: null,
    projectId: null,
  });
  const proposal = result[0]!.proposal;
  expect(sourceAvailable(proposal, [account("gmail")], { calendar: true, tasks: true })).toBe(false);
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
test("Outlook only reads sent items and validates the next page before requesting it", async () => {
  const paths: string[] = [];
  await expect(
    accountWorkdayEvidence(
      account("outlook"),
      day,
      zone,
      async (path) => {
        paths.push(path);
        return { value: [], "@odata.nextLink": "https://evil.test/v1.0/me/messages?skiptoken=private" };
      },
      signal,
    ),
  ).rejects.toMatchObject({ code: "invalid_page_token" });
  expect(paths).toHaveLength(1);
  expect(paths[0]).toStartWith("/v1.0/me/mailFolders/sentitems/messages?");
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
