import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionCostSummary } from "@legalwork/types/session-cost";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { useLocal } from "@/react-app/kernel/local-provider";

type CostContext = { summary?: SessionCostSummary; pending: boolean; failed: boolean; refresh: () => void };
const SessionCosts = createContext<CostContext | null>(null);

export function SessionCostProvider({ client, workspaceId, sessionId, busy, children }: {
  client: LegalworkServerClient; workspaceId: string; sessionId: string; busy: boolean; children: ReactNode;
}) {
  const { prefs } = useLocal();
  const query = useQuery({
    queryKey: ["session-costs", workspaceId, sessionId, client.baseUrl],
    queryFn: ({ signal }) => client.getSessionCosts(workspaceId, sessionId, signal),
    enabled: prefs.showCosts,
    staleTime: 2_000,
    refetchInterval: busy && prefs.showCosts ? 4_000 : false,
    retry: 1,
  });
  const { refetch } = query;
  useEffect(() => { if (prefs.showCosts && !busy) void refetch(); }, [busy, prefs.showCosts, refetch]);
  return <SessionCosts.Provider value={prefs.showCosts ? {
    summary: query.data, pending: query.isPending, failed: query.isError, refresh: () => { void refetch(); },
  } : null}>{children}</SessionCosts.Provider>;
}

export const useSessionCosts = () => useContext(SessionCosts);
