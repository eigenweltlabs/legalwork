import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";

type StatusReader = Pick<LegalworkServerClient, "baseUrl" | "connectorSavedStatus">;

/** Saved account metadata is safe to retry; never reconnects or requests new permissions. */
export function connectorStatusQuery(client: StatusReader | null) {
  return {
    queryKey: ["settings", "connector-accounts", client?.baseUrl],
    enabled: Boolean(client),
    queryFn: async () => {
      if (!client) throw new Error("Connector server unavailable");
      return client.connectorSavedStatus();
    },
    retry: (failures: number, error: Error) => failures < 2 && !(error instanceof LegalworkServerError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429),
    staleTime: 15_000,
    gcTime: 0,
    refetchInterval: 15_000,
  };
}
