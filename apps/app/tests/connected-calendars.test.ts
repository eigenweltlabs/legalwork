import { describe, expect, test } from "bun:test";
import { connectorStatusSchema } from "@legalwork/types/connectors";
import { connectedCalendars, connectedCalendarEvents, connectedCalendarRange, safeCalendarUrl, type ConnectedCalendar } from "../src/react-app/domains/calendar/connected-calendars";
import { occursOnDay, occurrenceDay } from "../src/react-app/domains/calendar/calendar-format";
import { createCalendarVisibility } from "../src/react-app/domains/calendar/calendar-visibility";

const google: ConnectedCalendar = { key: "google:personal", id: "calendar", name: "Personal", connectionId: "account", connectorId: "google-calendar", providerName: "Google Calendar" };
const outlook: ConnectedCalendar = { ...google, key: "outlook:personal", connectorId: "outlook-calendar", providerName: "Outlook Calendar" };
const status = connectorStatusSchema.parse({ configured: true, requiresSignIn: false, connectors: [
  { id: "google-calendar", name: "Google Calendar", configured: true, active: true, connections: [{ id: "google", createdAt: null, needsReconnect: false }] },
  { id: "outlook-calendar", name: "Outlook Calendar", configured: true, active: true, connections: [{ id: "outlook", createdAt: null, needsReconnect: false }] },
] });
type Reader = Parameters<typeof connectedCalendars>[0];
function reader(run: (call: Parameters<Reader["callExtensionAction"]>[0]) => unknown, saved = status): Reader {
  return { connectorSavedStatus: async () => saved, callExtensionAction: async call => ({ ok: true, extensionId: call.extensionId, action: call.action, result: await run(call) }) };
}
const event = { id: "event", title: "Appointment", start: "2026-10-26T23:30:00Z", end: "2026-10-27T00:30:00Z", allDay: false, status: "confirmed", webUrl: "https://calendar.google.com/event" };

describe("connected calendar discovery", () => {
  test("lists every page, binds account IDs, and distinguishes matching calendar IDs across providers", async () => {
    const calls: Parameters<Reader["callExtensionAction"]>[0][] = [];
    const result = await connectedCalendars(reader(call => {
      calls.push(call);
      return { calendars: [{ id: call.args?.pageToken ? "second" : "calendar", name: "Calendar" }], nextPageToken: call.extensionId === "google-calendar" && !call.args?.pageToken ? "page2" : null };
    }));
    expect(result.calendars).toHaveLength(3);
    expect(new Set(result.calendars.map(calendar => calendar.key)).size).toBe(3);
    expect(calls.every(call => call.action === "list_calendars" && call.args?.connectionId === (call.extensionId === "google-calendar" ? "google" : "outlook"))).toBe(true);
    expect(result.unavailable).toEqual([]);
  });
  test("an unavailable provider does not hide the other provider", async () => {
    const result = await connectedCalendars(reader(call => {
      if (call.extensionId === "outlook-calendar") throw new Error("Reconnect needed");
      return { calendars: [{ id: "calendar", name: "Personal" }] };
    }));
    expect(result.calendars.map(calendar => calendar.providerName)).toEqual(["Google Calendar"]);
    expect(result.unavailable).toEqual(["Outlook Calendar"]);
  });
  test("saved status failures are isolated to one provider", async () => {
    const client = reader(() => ({ calendars: [{ id: "calendar", name: "Personal" }] }));
    const result = await connectedCalendars({ ...client, connectorSavedStatus: async id => {
      if (id === "google-calendar") throw new Error("Unavailable");
      expect(id).toBe("outlook-calendar");
      return status;
    } });
    expect(result.calendars.map(calendar => calendar.providerName)).toEqual(["Outlook Calendar"]);
    expect(result.unavailable).toEqual(["Google Calendar"]);
  });
  test("inactive, expired and ambiguous account connections are not read", async () => {
    const saved = structuredClone(status);
    saved.connectors[0].active = false;
    saved.connectors[1].connections[0].needsReconnect = true;
    const result = await connectedCalendars(reader(() => { throw new Error("Must not access inactive accounts"); }, saved));
    expect(result.calendars).toEqual([]);
    expect(result.unavailable).toEqual(["Outlook Calendar"]);
    saved.connectors[1].connections[0].needsReconnect = false;
    saved.connectors[1].connections.push({ id: "other", createdAt: null, needsReconnect: false });
    expect((await connectedCalendars(reader(() => { throw new Error("Must not select an arbitrary account"); }, saved))).calendars).toEqual([]);
  });
  test("repeating pagination is reported instead of looping", async () => {
    const result = await connectedCalendars(reader(() => ({ calendars: [], nextPageToken: "same-page" })));
    expect(result.calendars).toEqual([]);
    expect(result.unavailable).toEqual(["Google Calendar", "Outlook Calendar"]);
  });
});

describe("connected calendar occurrences", () => {
  test.skipIf(process.env.TZ !== "Europe/Berlin")("visible ranges use local midnight across a 25-hour DST day", () => {
    expect(connectedCalendarRange("2026-10-25", "2026-10-26")).toEqual({ timeMin: "2026-10-24T22:00:00.000Z", timeMax: "2026-10-25T23:00:00.000Z" });
  });
  test("reads all event pages in the visible range and deduplicates overlapping responses", async () => {
    const calls: Parameters<Reader["callExtensionAction"]>[0][] = [];
    const result = await connectedCalendarEvents(reader(call => {
      calls.push(call);
      return { events: [event, ...(call.args?.pageToken ? [{ ...event, id: "next" }] : [])], nextPageToken: call.args?.pageToken ? null : "page2" };
    }), google, "2026-10-26", "2026-11-02", "Europe/Berlin");
    expect(result).toHaveLength(2);
    expect(calls[0].args).toEqual({ connectionId: "account", calendarId: "calendar", ...connectedCalendarRange("2026-10-26", "2026-11-02"), maxResults: 100 });
    expect(calls[1].args?.pageToken).toBe("page2");
    expect(result[0].projectId).toBeNull();
    expect(result[0].connectedEvent?.calendar).toEqual(google);
    expect(occurrenceDay(result[0])).toBe("2026-10-27");
  });
  test("Outlook UTC values without an offset are normalized before local placement", async () => {
    const [item] = await connectedCalendarEvents(reader(() => ({ events: [{ ...event, start: "2026-10-26T23:30:00.0000000", end: "2026-10-27T00:30:00.0000000", recurring: true }] })), outlook, "2026-10-26", "2026-11-02", "Europe/Berlin");
    expect(item.start).toBe("2026-10-26T23:30:00.000Z");
    expect(occurrenceDay(item)).toBe("2026-10-27");
    expect(item.recurring).toBe(true);
  });
  test("all-day end dates remain exclusive and cancelled instances without dates are skipped", async () => {
    const result = await connectedCalendarEvents(reader(() => ({ events: [{ ...event, start: "2026-10-26", end: "2026-10-28", allDay: true }, { ...event, id: "cancelled", start: null, end: null, status: "cancelled" }] })), google, "2026-10-26", "2026-11-02", "America/Los_Angeles");
    expect(result).toHaveLength(1);
    expect(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"].map(day => occursOnDay(result[0], day))).toEqual([false, true, true, false]);
  });
  test("invalid event dates and looping event pages are errors, not empty calendars", async () => {
    await expect(connectedCalendarEvents(reader(() => ({ events: [{ ...event, start: "broken" }] })), google, "2026-10-26", "2026-11-02", "UTC")).rejects.toThrow("invalid event date");
    await expect(connectedCalendarEvents(reader(() => ({ events: [], nextPageToken: "loop" })), google, "2026-10-26", "2026-11-02", "UTC")).rejects.toThrow("too many pages");
  });
  test("all-day events returned near UTC range boundaries must overlap the visible calendar dates", async () => {
    const result = await connectedCalendarEvents(reader(() => ({ events: [
      { ...event, id: "previous-day", start: "2026-11-30", end: "2026-12-01", allDay: true },
      { ...event, id: "spanning", start: "2026-11-30", end: "2026-12-02", allDay: true },
      { ...event, id: "next-month", start: "2027-01-01", end: "2027-01-02", allDay: true },
    ] })), outlook, "2026-12-01", "2027-01-01", "Europe/Berlin");
    expect(result.map(item => item.itemId)).toEqual(["spanning"]);
  });
  test("provider links reject scripts, insecure URLs, and embedded credentials", () => {
    const credentialExample = new URL("https://example.invalid/");
    credentialExample.username = "placeholder";
    credentialExample.password = "placeholder";
    for (const url of [null, "javascript:alert(1)", "http://outlook.com/", credentialExample.href, "invalid"]) expect(safeCalendarUrl(url)).toBeNull();
    expect(safeCalendarUrl("https://outlook.live.com/calendar/item")).toBe("https://outlook.live.com/calendar/item");
  });
});

test("calendar visibility survives reloads independently for the global calendar and each project", async () => {
  const memory = new Map<string, string>();
  const useCalendarVisibility = createCalendarVisibility(() => ({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } }));
  useCalendarVisibility.setState({ hidden: {} });
  const store = useCalendarVisibility.getState();
  store.setVisible("project-a", google.key, false);
  store.setVisible("global", outlook.key, false);
  store.setVisible("project-a", google.key, false);
  expect(useCalendarVisibility.getState().hidden).toEqual({ "project-a": [google.key], global: [outlook.key] });
  store.setVisible("project-a", google.key, true);
  expect(useCalendarVisibility.getState().hidden).toEqual({ "project-a": [], global: [outlook.key] });
  const saved = memory.get("legalwork.calendar-visibility.v1");
  expect(saved).toBeDefined();
  useCalendarVisibility.setState({ hidden: {} });
  if (saved) memory.set("legalwork.calendar-visibility.v1", saved);
  await useCalendarVisibility.persist.rehydrate();
  expect(useCalendarVisibility.getState().hidden).toEqual({ "project-a": [], global: [outlook.key] });
});

test("discovery failures keep cached calendars, while disconnection and account replacement clear the old account", async () => {
  const previous = [{ ...google, connectionId: "google" }];
  const unavailable = reader(() => { throw new Error("Offline"); });
  expect((await connectedCalendars(unavailable, previous)).calendars).toEqual(previous);
  const disconnected = structuredClone(status);
  disconnected.connectors[0].connections = [];
  expect((await connectedCalendars(reader(() => ({ calendars: [] }), disconnected), previous)).calendars).toEqual([]);
  const replaced = structuredClone(status);
  replaced.connectors[0].connections[0].id = "replacement";
  expect((await connectedCalendars(reader(() => { throw new Error("Offline"); }, replaced), previous)).calendars).toEqual([]);
});

test("rich event details survive parsing and projection onto the viewer's clock", async () => {
  const details = {
    description: "<p>Full context</p>", descriptionType: "html", timeZone: "America/New_York", location: "Boardroom",
    organizer: { displayName: "Partner", email: "partner@example.invalid" },
    attendees: [{ displayName: "Client", email: "client@example.invalid", responseStatus: "accepted", optional: true }],
    conference: { url: "https://meet.google.com/example" }, recurrence: ["RRULE:FREQ=WEEKLY"], recurringEventId: "series",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] },
    attachments: [{ title: "Agenda", fileUrl: "https://docs.google.com/example" }], source: { title: "Matter", url: "https://example.invalid/matter" },
  };
  const [item] = await connectedCalendarEvents(reader(() => ({ events: [{ ...event, ...details }] })), google, "2026-10-26", "2026-11-02", "Europe/Berlin");
  expect(item.connectedEvent).toMatchObject(details);
  expect(item.timeZone).toBe("Europe/Berlin");
  expect(item.recurring).toBe(true);
});
