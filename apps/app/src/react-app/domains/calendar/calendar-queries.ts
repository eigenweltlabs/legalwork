import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { connectedCalendars, type ConnectedCalendar } from "./connected-calendars";
import { calendarCachePolicy, calendarClientScope, calendarEventRanges, connectedEventOptions } from "./calendar-cache";

export type CalendarSource = { id: string; name: string; workspaceId: string; client: LegalworkServerClient };
export type CalendarContext = { client: LegalworkServerClient | null; workspaceId?: string; remoteSources?: CalendarSource[] };

export function useCalendarRefresh() {
  const cache = useQueryClient();
  return () => { void cache.invalidateQueries({ queryKey: ["calendar"] }); };
}

export function useCalendarOccurrences(context: CalendarContext, from: string, to: string) {
  const { client, workspaceId } = context;
  const sources = workspaceId ? [] : context.remoteSources ?? [];
  return useQuery({
    queryKey: ["calendar", ...calendarClientScope(client), workspaceId ?? "all", sources.map(source => [source.id, calendarClientScope(source.client), source.workspaceId]), from, to],
    enabled: Boolean(client),
    ...calendarCachePolicy,
    queryFn: async () => {
      if (!client) return { occurrences: [], unavailable: [] };
      const responses = await Promise.allSettled([client.calendarOccurrences(workspaceId ?? null, from, to), ...sources.map(source => source.client.calendarOccurrences(source.workspaceId, from, to))]);
      const local = responses[0];
      if (local.status === "rejected") throw local.reason;
      const occurrences = [...local.value.occurrences], unavailable: string[] = [];
      responses.slice(1).forEach((response, index) => {
        const source = sources[index];
        if (response.status === "rejected") { unavailable.push(source.name); return; }
        occurrences.push(...response.value.occurrences.map(item => ({ ...item, id: `${source.id}:${item.id}`, projectId: source.id, projectName: source.name })));
      });
      return { occurrences: occurrences.sort((a, b) => a.start.localeCompare(b.start)), unavailable };
    },
  });
}

export function useCalendarRecords({ client, workspaceId }: CalendarContext) {
  return useQuery({
    queryKey: ["calendar", ...calendarClientScope(client), workspaceId, "items"],
    enabled: Boolean(client && workspaceId),
    queryFn: () => client && workspaceId ? client.calendarItems(workspaceId, true) : { items: [], conflicts: [] },
    ...calendarCachePolicy,
  });
}

export function useConnectedCalendars(client: LegalworkServerClient | null) {
  const cache = useQueryClient();
  const queryKey = ["calendar", ...calendarClientScope(client), "connections"];
  return useQuery({
    queryKey, enabled: Boolean(client),
    queryFn: () => client ? connectedCalendars(client, cache.getQueryData<Awaited<ReturnType<typeof connectedCalendars>>>(queryKey)?.calendars) : { calendars: [], unavailable: [] },
    ...calendarCachePolicy, retry: false,
  });
}

export function useConnectedCalendarEvents(client: LegalworkServerClient | null, calendars: ConnectedCalendar[], from: string, to: string) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const pages = calendars.flatMap(calendar => calendarEventRanges(from, to).map(range => ({ calendar, ...range })));
  const queries = useQueries({ queries: pages.map(page => connectedEventOptions(client, page.calendar, page.from, page.to, timeZone)) });
  return queries.map((query, index) => ({ ...query, ...pages[index] }));
}
