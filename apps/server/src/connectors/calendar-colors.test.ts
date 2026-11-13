import { expect, test } from "bun:test";
import { calendarListInput, googleCalendarAdapter, outlookCalendarAdapter } from "./calendar.js";
import type { ConnectorRequest } from "./request.js";

const input = calendarListInput.parse({});

test("Google calendar colors come from CalendarList, including read-only shared calendars", async () => {
  const request: ConnectorRequest = async (path, options) => {
    expect(path).toStartWith("/calendar/v3/users/me/calendarList?");
    expect(options?.method).toBeUndefined();
    return { items: [
      { id: "personal", summary: "Personal", backgroundColor: "#12ABef", colorId: "1", accessRole: "owner", primary: true },
      { id: "shared", summary: "Team", backgroundColor: "#FF0000", accessRole: "reader" },
      { id: "unset", summary: "Unset" },
      { id: "invalid", summary: "Invalid", backgroundColor: "red; background: url(https://example.com)" },
    ], nextPageToken: "next" };
  };
  const page = await googleCalendarAdapter.calendars(request, input);
  expect(page.calendars.map(({ id, color, canWrite }) => ({ id, color, canWrite }))).toEqual([
    { id: "personal", color: "#12abef", canWrite: true }, { id: "shared", color: "#ff0000", canWrite: false },
    { id: "unset", color: null, canWrite: false }, { id: "invalid", color: null, canWrite: false },
  ]);
  expect(page.nextPageToken).toBe("next");
});

test("Outlook explicitly selects hexColor and preserves calendars with automatic or invalid colors", async () => {
  const request: ConnectorRequest = async (path, options) => {
    const url = new URL(path, "https://graph.microsoft.com");
    expect(url.searchParams.get("$select")?.split(",")).toContain("hexColor");
    expect(options?.method).toBeUndefined();
    return { value: [
      { id: "chosen", name: "Chosen", hexColor: "#AABBCC", canEdit: true, isDefaultCalendar: true },
      { id: "auto", name: "Automatic", hexColor: "", color: "auto" },
      { id: "old", name: "Old" }, { id: "invalid", name: "Invalid", hexColor: "var(--foreground)" },
    ] };
  };
  const page = await outlookCalendarAdapter.calendars(request, input);
  expect(page.calendars.map(({ id, color }) => ({ id, color }))).toEqual([
    { id: "chosen", color: "#aabbcc" }, { id: "auto", color: null }, { id: "old", color: null }, { id: "invalid", color: null },
  ]);
  expect(page.calendars[0]).toMatchObject({ primary: true, canWrite: true });
});
