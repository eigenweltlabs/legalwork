import { queryOptions, useQuery } from "@tanstack/react-query";

import type {
  EigenweltEntitlements,
  EigenweltEntitlementsView,
  EigenweltFeature,
  LegalworkServerClient,
} from "../../../app/lib/legalwork-server";
import { getReactQueryClient } from "../../infra/query-client";

/**
 * Read model for the connected Eigenwelt firm's subscription entitlements.
 * The server keeps ONE connection for the account, shared by every workspace
 * (the secret platformToken never reaches the app); this query surfaces the
 * app-safe view (entitlements + platformURL) so UI can gate features and link
 * out to billing. One cache entry for all workspaces, so a sign-in or sign-out
 * from one workspace shows in every other one at once.
 */

const EIGENWELT_ENTITLEMENTS_ROOT = ["eigenwelt-entitlements"] as const;
let lastAccessErrorRefreshAt = 0;

export function eigenweltEntitlementsQueryKey() {
  return EIGENWELT_ENTITLEMENTS_ROOT;
}

/** Refetch after a sign-in re-connects the firm (entitlements may have changed). */
export function invalidateEigenweltEntitlements() {
  const queryClient = getReactQueryClient();
  void queryClient.invalidateQueries({ queryKey: EIGENWELT_ENTITLEMENTS_ROOT });
}

/** Live and saved errors can describe the same failure repeatedly. Refresh
 * once per short interval so transcript renders cannot cause a request loop. */
export function refreshEigenweltEntitlementsAfterAccessError() {
  const now = Date.now();
  if (now - lastAccessErrorRefreshAt < 20_000) return;
  lastAccessErrorRefreshAt = now;
  void getReactQueryClient().invalidateQueries(
    { queryKey: EIGENWELT_ENTITLEMENTS_ROOT },
    { cancelRefetch: false },
  );
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

export function eigenweltEntitlementsQueryOptions(input: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: eigenweltEntitlementsQueryKey(),
    enabled: Boolean(input.enabled !== false && input.client && input.workspaceId),
    staleTime: 20_000,
    // Force a platform refresh: a valid 15-minute access token must not keep
    // serving the previous subscription after the gateway revokes access.
    refetchOnWindowFocus: true,
    refetchInterval: (query) => query.state.data?.reconnecting ? 15_000 : 5 * 60_000,
    queryFn: async (): Promise<EigenweltEntitlementsView> => {
      if (!input.client || !input.workspaceId) {
        return { entitlements: null, account: null, platformURL: null, connected: false };
      }
      return input.client.eigenweltEntitlements(input.workspaceId, { refresh: true });
    },
  });
}

export function useEigenweltEntitlements(input: Parameters<typeof eigenweltEntitlementsQueryOptions>[0]) {
  return useQuery(eigenweltEntitlementsQueryOptions(input));
}
