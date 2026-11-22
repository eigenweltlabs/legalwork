import { queryOptions } from "@tanstack/react-query";
import { isLoopbackLegalworkServerUrl, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { calendarClientScope } from "../calendar/calendar-cache";

export function timeTrackingProfile(client: LegalworkServerClient | null | undefined) {
  return queryOptions({
    queryKey: ["time-tracking-profile", ...calendarClientScope(client ?? null)],
    enabled: Boolean(client && isLoopbackLegalworkServerUrl(client.baseUrl)),
    queryFn: () => client!.activityProfile(),
    staleTime: 30_000, refetchInterval: 30_000, retry: false,
  });
}
