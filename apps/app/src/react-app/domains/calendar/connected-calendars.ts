import type { CalendarOccurrence } from "@legalwork/types/calendar";
import { connectorIsConnected, connectorCalendarListSchema, connectorCalendarEventsSchema, type ConnectorCalendarEvent } from "@legalwork/types/connectors";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export type ConnectedCalendar = {
  key: string; id: string; connectionId: string; connectorId: "google-calendar" | "outlook-calendar";
  providerName: string; name: string; color?: string | null;
};
export type CalendarDisplayOccurrence = CalendarOccurrence & {
  connectedEvent?: ConnectorCalendarEvent & { calendar: ConnectedCalendar };
};
type CalendarReader = Pick<LegalworkServerClient, "connectorSavedStatus" | "callExtensionAction">;

async function pages<T>(read: (pageToken?: string) => Promise<{ items: T[]; nextPageToken?: string | null }>) {
  const items: T[] = [], visited = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await read(pageToken);
    items.push(...page.items);
    pageToken = page.nextPageToken ?? undefined;
    if (pageToken && (visited.has(pageToken) || visited.size >= 100)) throw new Error(t("calendar.connected_page_limit"));
    if (pageToken) visited.add(pageToken);
  } while (pageToken);
  return items;
}

export async function connectedCalendars(client: CalendarReader, previous: ConnectedCalendar[] = []) {
  const sources: { id: ConnectedCalendar["connectorId"]; name: string }[] = [{ id: "google-calendar", name: "Google Calendar" }, { id: "outlook-calendar", name: "Outlook Calendar" }];
  // Avoid discovering unrelated integrations or letting one account block the other.
  const statuses = await Promise.allSettled(sources.map(source => client.connectorSavedStatus(source.id)));
  const unavailable = statuses.flatMap((result, index) => result.status === "rejected" ? [sources[index].name] : []);
  const providers = statuses.flatMap((result, index) => result.status === "fulfilled" ? result.value.connectors.filter(connector => connector.id === sources[index].id) : []);
  const results = await Promise.allSettled(providers.map(async provider => {
    if (!connectorIsConnected(provider)) return [];
    const connectorId = provider.id;
    if (connectorId !== "google-calendar" && connectorId !== "outlook-calendar") return [];
    const connectionId = provider.connections[0].id;
    const calendars = await pages(async pageToken => {
      const response = await client.callExtensionAction({ extensionId: connectorId, action: "list_calendars", args: { connectionId, maxResults: 50, ...(pageToken ? { pageToken } : {}) } });
      const page = connectorCalendarListSchema.parse(response.result);
      return { items: page.calendars, nextPageToken: page.nextPageToken };
    });
    return calendars.map(calendar => {
      const entry: ConnectedCalendar = { ...calendar, key: JSON.stringify([connectorId, connectionId, calendar.id]), connectionId, connectorId, providerName: provider.name };
      return entry;
    });
  }));
  const calendars: ConnectedCalendar[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") calendars.push(...result.value);
    else unavailable.push(providers[index].name);
    const provider = providers[index];
    if (provider.active !== false && provider.connections.some(connection => connection.needsReconnect)) unavailable.push(provider.name);
  });
  // A transient discovery failure must not unmount cached event queries. A
  // successful empty response (disconnect or account change) remains authoritative.
  calendars.push(...previous.filter(calendar => {
    if (!unavailable.includes(calendar.providerName)) return false;
    const provider = providers.find(provider => provider.id === calendar.connectorId);
    return provider ? connectorIsConnected(provider) && provider.connections[0].id === calendar.connectionId
      : statuses[sources.findIndex(source => source.id === calendar.connectorId)].status === "rejected";
  }));
  return { calendars: [...new Map(calendars.map(calendar => [calendar.key, calendar])).values()], unavailable: [...new Set(unavailable)] };
}

export function connectedCalendarRange(from: string, to: string) {
  // Use local midnight boundaries, including their DST-specific offsets.
  return { timeMin: new Date(`${from}T00:00:00`).toISOString(), timeMax: new Date(`${to}T00:00:00`).toISOString() };
}

export async function connectedCalendarEvents(client: CalendarReader, calendar: ConnectedCalendar, from: string, to: string, timeZone: string): Promise<CalendarDisplayOccurrence[]> {
  const events = await pages(async pageToken => {
    const response = await client.callExtensionAction({ extensionId: calendar.connectorId, action: "list_events", args: {
      connectionId: calendar.connectionId, calendarId: calendar.id, ...connectedCalendarRange(from, to), maxResults: 100, ...(pageToken ? { pageToken } : {}),
    } });
    const page = connectorCalendarEventsSchema.parse(response.result);
    return { items: page.events, nextPageToken: page.nextPageToken };
  });
  const occurrences: CalendarDisplayOccurrence[] = [];
  for (const event of events) {
    if (!event.start) continue; // Cancelled Google instances can have no date.
    const instant = (value: string) => {
      if (event.allDay) return value.slice(0, 10);
      // The Outlook adapter requests UTC; Graph omits the trailing Z.
      const date = new Date(calendar.connectorId === "outlook-calendar" && !/(Z|[+-]\d\d:\d\d)$/i.test(value) ? `${value}Z` : value);
      if (!Number.isFinite(date.getTime())) throw new Error(t("calendar.connected_invalid_date"));
      return date.toISOString();
    };
    const start = instant(event.start), end = event.end ? instant(event.end) : null;
    // Providers filter by instants; all-day dates float independently of the
    // viewer's UTC offset and must also overlap the visible calendar days.
    if (event.allDay && (start >= to || (end ? end <= from : start < from))) continue;
    const id = JSON.stringify([calendar.key, event.id]);
    occurrences.push({ id, itemId: event.id, uid: id, projectId: null, projectName: calendar.name, kind: "event", title: event.title,
      start, end, allDay: event.allDay, timeZone,
      status: event.status === "cancelled" ? "cancelled" : "active", assigneeUserId: null, provenance: null, verified: true,
      recurring: Boolean(event.recurringEventId || event.recurring || event.recurrence.length),
      connectedEvent: { ...event, calendar, webUrl: safeCalendarUrl(event.webUrl) },
    });
  }
  return [...new Map(occurrences.map(occurrence => [occurrence.id, occurrence])).values()];
}

export function safeCalendarUrl(value: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
