import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function risStatusQuery(client: Pick<LegalworkServerClient, "baseUrl" | "risStatus"> | null | undefined) {
  return { queryKey: ["settings", "ris", client?.baseUrl], enabled: Boolean(client),
    queryFn: () => { if (!client) throw new Error(t("ris.unavailable")); return client.risStatus(); },
    staleTime: 15_000, gcTime: 0, refetchInterval: 15_000, retry: false };
}
