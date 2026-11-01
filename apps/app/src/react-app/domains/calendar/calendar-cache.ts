import { queryOptions } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarDay, shiftDay } from "./calendar-format";
import { connectedCalendarEvents, type ConnectedCalendar } from "./connected-calendars";

// Keep private data in memory only. Opaque credential IDs avoid putting tokens
// in query keys, while separating accounts served from the same endpoint.
const credentials = new Map<string | undefined, string>();
export function calendarClientScope(client: Pick<LegalworkServerClient, "baseUrl" | "token"> | null) {
  if (!credentials.has(client?.token)) credentials.set(client?.token, crypto.randomUUID());
  return [client?.baseUrl, credentials.get(client?.token)];
}

export const calendarCachePolicy = { staleTime: 60_000, gcTime: 30 * 60_000, refetchInterval: 60_000 };

// Stable Monday-based pages are shared by day, week and month views. Moving
// one week only loads the new edge instead of fetching every visible day again.
export function calendarEventRanges(from: string, to: string) {
  const first = new Date(`${from}T12:00:00`);
  const ranges: { from: string; to: string }[] = [];
  for (let day = shiftDay(first, -((first.getDay() + 6) % 7)); calendarDay(day) < to; day = shiftDay(day, 7)) {
    ranges.push({ from: calendarDay(day), to: calendarDay(shiftDay(day, 7)) });
  }
  return ranges;
}

export function connectedEventOptions(client: LegalworkServerClient | null, calendar: ConnectedCalendar, from: string, to: string, timeZone: string) {
  return queryOptions({
    queryKey: ["calendar", ...calendarClientScope(client), "connected-events", calendar.key, from, to, timeZone],
    enabled: Boolean(client),
    queryFn: () => client ? connectedCalendarEvents(client, calendar, from, to, timeZone) : [],
    ...calendarCachePolicy, retry: false,
  });
}
