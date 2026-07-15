import { useQuery } from "@tanstack/react-query";

import type {
  EigenweltEntitlements,
  EigenweltEntitlementsView,
  EigenweltFeature,
  LegalworkServerClient,
} from "../../../app/lib/legalwork-server";
import { getReactQueryClient } from "../../infra/query-client";

/**
 * Read model for the connected Eigenwelt firm's subscription entitlements.
 * The server persists them per-workspace (the secret platformToken never
 * reaches the app); this query surfaces the app-safe view (entitlements +
 * platformURL) so UI can gate features and link out to billing.
 */

const EIGENWELT_ENTITLEMENTS_ROOT = ["eigenwelt-entitlements"] as const;

export function eigenweltEntitlementsQueryKey(workspaceId: string) {
  return [...EIGENWELT_ENTITLEMENTS_ROOT, workspaceId] as const;
}

/** Refetch after a sign-in re-connects the firm (entitlements may have changed). */
export function invalidateEigenweltEntitlements(workspaceId?: string) {
  const queryClient = getReactQueryClient();
  void queryClient.invalidateQueries({
    queryKey: workspaceId ? eigenweltEntitlementsQueryKey(workspaceId) : EIGENWELT_ENTITLEMENTS_ROOT,
  });
}

/** True when the firm's plan grants a specific gated feature. */
export function hasEigenweltFeature(
  entitlements: EigenweltEntitlements | null | undefined,
  feature: EigenweltFeature,
): boolean {
  return Boolean(entitlements?.features?.includes(feature));
}

/** Billing/upgrade URL for the connected platform (falls back to the prod host). */
export function eigenweltBillingUrl(platformURL: string | null | undefined): string {
  const base = (platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "");
  return `${base}/billing`;
}

export function useEigenweltEntitlements(input: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: eigenweltEntitlementsQueryKey(input.workspaceId ?? ""),
    enabled: Boolean(input.enabled !== false && input.client && input.workspaceId),
    staleTime: 60_000,
    // Keep entitlements live: each read makes the server opportunistically
    // refresh its access token (rotating) and pull the current plan/usage, so a
    // plan change on the platform propagates without re-signing-in.
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<EigenweltEntitlementsView> => {
      if (!input.client || !input.workspaceId) {
        return { entitlements: null, account: null, platformURL: null, connected: false };
      }
      return input.client.eigenweltEntitlements(input.workspaceId);
    },
  });
}
