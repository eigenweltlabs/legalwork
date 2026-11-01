import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { calendarClientScope, calendarEventRanges, connectedEventOptions } from "../src/react-app/domains/calendar/calendar-cache";
import type { ConnectedCalendar } from "../src/react-app/domains/calendar/connected-calendars";

const calendar: ConnectedCalendar = { key: "google:account:personal", id: "personal", name: "Personal", connectionId: "account", connectorId: "google-calendar", providerName: "Google Calendar" };
const event = { id: "one", title: "Original", start: "2026-10-27T09:00:00Z", end: "2026-10-27T10:00:00Z", allDay: false, status: "confirmed", webUrl: null };
function setup() {
  let events = [event], failed = false, calls = 0;
  const client = { ...createLegalworkServerClient({ baseUrl: "https://calendar.invalid", token: "test-account" }), callExtensionAction: async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 40));
    if (failed) throw new Error("Offline");
    return { ok: true, extensionId: "google-calendar", action: "list_events", result: { events } };
  } };
  return { client, options: connectedEventOptions(client, calendar, "2026-10-26", "2026-11-02", "Europe/Berlin"),
    change: (next: typeof events) => { events = next; }, fail: () => { failed = true; }, calls: () => calls };
}

test("reopening a loaded range synchronously returns cached events without another provider request", async () => {
  const cache = new QueryClient(), fixture = setup();
  try {
    const first = new QueryObserver(cache, fixture.options);
    const stop = first.subscribe(() => {});
    await first.refetch(); stop();
    const reopened = new QueryObserver(cache, fixture.options);
    const stopAgain = reopened.subscribe(() => {});
    expect(reopened.getCurrentResult().data?.[0].title).toBe("Original");
    expect(reopened.getCurrentResult().isFetching).toBe(false);
    expect(fixture.calls()).toBe(1);
    stopAgain();
  } finally { cache.clear(); }
});

test("background failures retain data, and invalidation replaces edits and removes deleted events", async () => {
  const cache = new QueryClient(), fixture = setup();
  try {
    const observer = new QueryObserver(cache, fixture.options);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    fixture.change([{ ...event, title: "Edited" }]);
    const refresh = cache.invalidateQueries({ queryKey: ["calendar"] });
    expect(observer.getCurrentResult().data?.[0].title).toBe("Original");
    await refresh;
    expect(observer.getCurrentResult().data?.map(item => item.title)).toEqual(["Edited"]);
    fixture.change([]);
    await cache.invalidateQueries({ queryKey: ["calendar"] });
    expect(observer.getCurrentResult().data).toEqual([]);
    fixture.fail();
    await observer.refetch();
    expect(observer.getCurrentResult().isError).toBe(true);
    expect(observer.getCurrentResult().data).toEqual([]);
    stop();
  } finally { cache.clear(); }
});

test("a stale cached page is available immediately during a failing background refetch", async () => {
  const cache = new QueryClient(), fixture = setup();
  try {
    await cache.fetchQuery(fixture.options);
    fixture.fail();
    await cache.invalidateQueries({ queryKey: ["calendar"] });
    const observer = new QueryObserver(cache, fixture.options);
    const stop = observer.subscribe(() => {});
    expect(observer.getCurrentResult().data?.[0].title).toBe("Original");
    expect(observer.getCurrentResult().isFetching).toBe(true);
    await observer.refetch();
    expect(observer.getCurrentResult().data?.[0].title).toBe("Original");
    expect(observer.getCurrentResult().isError).toBe(true);
    stop();
  } finally { cache.clear(); }
});

test("cache keys distinguish servers, credentials, connected accounts, calendars and zones without exposing tokens", () => {
  const fixture = setup();
  const key = fixture.options.queryKey;
  expect(key).not.toContain("test-account");
  expect(calendarClientScope(fixture.client)).toEqual(calendarClientScope({ ...fixture.client }));
  for (const client of [{ ...fixture.client, token: "other" }, { ...fixture.client, baseUrl: "https://other.invalid" }]) {
    expect(connectedEventOptions(client, calendar, "2026-10-26", "2026-11-02", "Europe/Berlin").queryKey).not.toEqual(key);
  }
  expect(connectedEventOptions(fixture.client, { ...calendar, key: "other-account:calendar" }, "2026-10-26", "2026-11-02", "Europe/Berlin").queryKey).not.toEqual(key);
  expect(connectedEventOptions(fixture.client, calendar, "2026-10-26", "2026-11-02", "UTC").queryKey).not.toEqual(key);
});

test("day and month ranges reuse week pages across DST and year boundaries", () => {
  expect(calendarEventRanges("2026-10-25", "2026-10-26")).toEqual([{ from: "2026-10-19", to: "2026-10-26" }]);
  expect(calendarEventRanges("2026-12-28", "2027-01-11")).toEqual([{ from: "2026-12-28", to: "2027-01-04" }, { from: "2027-01-04", to: "2027-01-11" }]);
  const month = calendarEventRanges("2026-10-01", "2026-11-01");
  expect(month).toContainEqual(calendarEventRanges("2026-10-28", "2026-10-29")[0]);
});
