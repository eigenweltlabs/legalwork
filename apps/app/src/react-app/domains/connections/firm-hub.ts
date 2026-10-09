import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FirmHubView } from "@legalwork/types/firm-hub";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { onSyncPoke } from "@/react-app/kernel/sync-events";

/**
 * The firm's Knowledge Hub as this computer follows it (server firm-hub.ts):
 * read again whenever the server says the hub changed.
 */
export const FIRM_HUB_QUERY_KEY = ["firm-hub"] as const;

export function useFirmHub(client: LegalworkServerClient | null) {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      onSyncPoke((poke) => {
        if (!poke.hub && !poke.resync) return;
        void queryClient.invalidateQueries({ queryKey: FIRM_HUB_QUERY_KEY });
        // The Team tab's lists of what the firm shares.
        void queryClient.invalidateQueries({ queryKey: ["eigenwelt-hub"] });
      }),
    [queryClient],
  );
  return useQuery<FirmHubView>({
    queryKey: FIRM_HUB_QUERY_KEY,
    enabled: client !== null,
    queryFn: () => {
      if (!client) throw new Error("No LegalWork server");
      return client.firmHub();
    },
  });
}
