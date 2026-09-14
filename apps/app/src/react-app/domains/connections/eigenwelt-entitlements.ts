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
 * The server keeps ONE connection for the account, shared by every workspace
 * (the secret platformToken never reaches the app); this query surfaces the
 * app-safe view (entitlements + platformURL) so UI can gate features and link
 * out to billing. One cache entry for all workspaces, so a sign-in or sign-out
 * from one workspace shows in every other one at once.
 */

const EIGENWELT_ENTITLEMENTS_ROOT = ["eigenwelt-entitlements"] as const;

export function eigenweltEntitlementsQueryKey() {
  return EIGENWELT_ENTITLEMENTS_ROOT;
}

/** Refetch after a sign-in re-connects the firm (entitlements may have changed). */
export function invalidateEigenweltEntitlements() {
  const queryClient = getReactQueryClient();
  void queryClient.invalidateQueries({ queryKey: EIGENWELT_ENTITLEMENTS_ROOT });
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
    queryKey: eigenweltEntitlementsQueryKey(),
    enabled: Boolean(input.enabled !== false && input.client && input.workspaceId),
    staleTime: 20_000,
    // Keep entitlements live: each read makes the server opportunistically
    // refresh its access token (rotating) and pull the current plan/usage AND
    // the firm's model list, so a plan change or a model an admin turned on or
    // off on the platform propagates without re-signing-in. Short staleness so
    // switching back to the app after a change on the platform picks it up.
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
