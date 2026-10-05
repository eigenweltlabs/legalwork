import { useMemo } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { invalidateEigenweltEntitlements } from "../eigenwelt-entitlements";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { UsageTransport } from "./transport";

export function useDesktopUsageTransport(
  client: LegalworkServerClient,
  workspaceId: string,
) {
  return useMemo<UsageTransport>(() => {
    let lastPlan: string | undefined;
    return {
      read: async () => {
        const view = await client.eigenweltUsage(workspaceId);
        if (view.enabled && lastPlan !== view.me.plan) {
          await client.eigenweltEntitlements(workspaceId, { refresh: true });
          invalidateEigenweltEntitlements();
          lastPlan = view.me.plan;
        }
        return view;
      },
      write: (action) => client.eigenweltUsageAction(workspaceId, action),
      open: async (url) => {
        await openDesktopUrl(url);
      },
    };
  }, [client, workspaceId]);
}
