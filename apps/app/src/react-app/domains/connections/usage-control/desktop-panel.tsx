/** @jsxImportSource react */
import { useMemo, useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { invalidateEigenweltEntitlements } from "../eigenwelt-entitlements";
import { openDesktopUrl } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { UsageControlPanel, type UsageTransport } from "./panel";

export function DesktopUsagePanel({client,workspaceId}:{client:LegalworkServerClient;workspaceId:string}) {
  const transport = useMemo<UsageTransport>(() => {
    let lastPlan: string | undefined;
    return {
    read: async () => {
      const view = await client.eigenweltUsage(workspaceId);
      if (view.enabled && lastPlan !== view.me.plan) {
        await client.eigenweltEntitlements(workspaceId,{refresh:true});
        invalidateEigenweltEntitlements();
        lastPlan = view.me.plan;
      }
      return view;
    },
    write: action => client.eigenweltUsageAction(workspaceId,action),
    open: async url => { await openDesktopUrl(url); },
  }; }, [client,workspaceId]);
  return <UsageControlPanel key={workspaceId} transport={transport} t={t} />;
}
export function UsageLimitAction({client,workspaceId}:{client:LegalworkServerClient;workspaceId:string}) {
  const [open,setOpen] = useState(false);
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3 text-sm">
    <p>{t("limits.blocked")}</p><Button size="sm" onClick={() => setOpen(true)}>{t("limits.open")}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("limits.title")}</DialogTitle><DialogDescription>{t("limits.request_hint")}</DialogDescription></DialogHeader><DesktopUsagePanel client={client} workspaceId={workspaceId} /></DialogContent></Dialog>
  </div>;
}
