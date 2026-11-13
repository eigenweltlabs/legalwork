import { expect, test } from "bun:test";
import { connectorCalendarListSchema, connectorStatusSchema } from "@legalwork/types/connectors";
import { calendarDisplayColor, calendarProjectColor } from "../src/react-app/domains/calendar/calendar-colors";
import { connectedCalendars, connectedCalendarEvents } from "../src/react-app/domains/calendar/connected-calendars";

test("provider calendar colors survive discovery and reach every event", async () => {
  const status = connectorStatusSchema.parse({ configured: true, requiresSignIn: false, connectors: [
    { id: "google-calendar", name: "Google Calendar", configured: true, active: true, connections: [{ id: "google", createdAt: null, needsReconnect: false }] },
    { id: "outlook-calendar", name: "Outlook Calendar", configured: true, active: true, connections: [{ id: "outlook", createdAt: null, needsReconnect: false }] },
  ] });
  const client: Parameters<typeof connectedCalendars>[0] = {
    connectorSavedStatus: async () => status,
    callExtensionAction: async call => ({ ok: true, extensionId: call.extensionId, action: call.action, result: call.action === "list_calendars"
      ? { calendars: [{ id: "calendar", name: "Calendar", color: call.extensionId === "google-calendar" ? "#00AA11" : "#1234AB" }] }
      : { events: [{ id: "event", title: "Meeting", start: "2026-10-28T09:00:00Z", end: "2026-10-28T10:00:00Z", allDay: false, status: "confirmed", webUrl: null }] } }),
  };
  const sources = await connectedCalendars(client);
  expect(sources.calendars.map(item => item.color)).toEqual(["#00aa11", "#1234ab"]);
  for (const calendar of sources.calendars) {
    const [event] = await connectedCalendarEvents(client, calendar, "2026-10-28", "2026-10-29", "Europe/Berlin");
    expect(event.connectedEvent?.calendar.color).toBe(calendar.color);
    expect(calendarDisplayColor(calendar.key, calendar.color).style).toEqual({ "--calendar-color": calendar.color });
  }
});

test("old servers and invalid colors retain their calendars and stable fallback palette", () => {
  const page = connectorCalendarListSchema.parse({ calendars: [{ id: "old", name: "Old" }, { id: "invalid", name: "Invalid", color: "url(https://example.com)" }] });
  expect(page.calendars).toHaveLength(2);
  expect(page.calendars[1].color).toBeNull();
  for (const color of [undefined, null, "", "red", "#abc", "#abcd1234", "var(--foreground)"]) {
    const appearance = calendarDisplayColor("calendar", color);
    expect(appearance.card).toBe(calendarProjectColor("calendar").card);
    expect(appearance.style).toBeUndefined();
  }
});

test("white, black and saturated provider colors never become event text colors", () => {
  for (const color of ["#ffffff", "#000000", "#ffff00", "#0000ff"]) {
    const appearance = calendarDisplayColor("calendar", color);
    expect(appearance.style).toEqual({ "--calendar-color": color });
    expect(appearance.accent).toBe("text-muted-foreground");
    expect(appearance.marker).toContain("var(--calendar-color)");
  }
});
