import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, RefreshCw, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { changeOrgPolicySetting } from "../../connections/org-policy";
import { HubTabs } from "../segmented-tabs";
import { SandboxNetworkControl, networkDescription, type NetworkMode } from "./sandbox-network-control";

export function SandboxStatus({ client, canWrite = false }: { client: LegalworkServerClient; canWrite?: boolean }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["sandbox-default", client.baseUrl], queryFn: () => client.sandboxStatus(), refetchInterval: 5000 });
  const status = query.data;
  const syncLabels = {
    local: t("sandbox.sync_local"), syncing: t("sandbox.sync_syncing"),
    synced: t("sandbox.sync_synced"), pending: t("sandbox.sync_pending"), conflict: t("sandbox.sync_conflict"),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = !status?.supported || !canWrite || !client.canApprove || busy || status.policy?.locked === true;
  const refresh = async () => {
    await query.refetch();
    await cache.invalidateQueries({ queryKey: ["session-sandbox", client.baseUrl] });
  };
  const save = async (settings: { enabled: boolean; networkMode: NetworkMode }) => {
    setBusy(true); setError(null);
    try { await changeOrgPolicySetting("sandbox", () => client.setSandboxSettings(settings).then(() => undefined), client); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")); }
    finally { setBusy(false); }
  };
  const Icon = status?.enabled ? Shield : ShieldOff;
  return <section className="space-y-6 py-2" aria-label={t("sandbox.title")}>
    <div className="space-y-1">
      <h3 className="text-base font-medium text-foreground">{t("sandbox.title")}</h3>
      <p className="text-sm text-muted-foreground">{status?.policy?.locked ? t("sandbox.managed_scope") : t("sandbox.application_scope")}</p>
      {status?.policy ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3.5" aria-hidden />{t(status.policy.locked ? "sandbox.managed" : "sandbox.firm_default", { org: status.policy.orgName || t("org_policy.your_firm") })}
      </p> : null}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <h4 className="text-sm font-medium">{t("sandbox.execution_title")}</h4>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{status?.enabled ? t("sandbox.description") : t("sandbox.off_description")}</p>
      </div>
      <fieldset disabled={disabled} className="shrink-0 disabled:opacity-50">
        <HubTabs label={t("sandbox.title")} items={[{ id: "off", label: t("sandbox.choice_off") }, { id: "on", label: t("sandbox.choice_on") }]} value={status?.enabled ? "on" : "off"} onChange={value => { if (status) void save({ enabled: value === "on", networkMode: status.networkMode }); }} />
      </fieldset>
    </div>
    {status?.enabled ? <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          <h4 className="text-sm font-medium">{t("sandbox.network_title")}</h4>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{networkDescription(status.networkMode)}</p>
        </div>
        <SandboxNetworkControl value={status.networkMode} disabled={disabled} onChange={networkMode => { void save({ enabled: true, networkMode }); }} />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("sandbox.network_scope")}</p>
    </div> : null}
    <div className="space-y-3 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-4">
        <h4 className="text-sm text-muted-foreground">{t("sandbox.this_computer")}</h4>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refresh(); }}><RefreshCw className="size-3.5" />{t("sandbox.prepare")}</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>{t("sandbox.commands")}</span>
        <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-2"><Icon className="size-4" aria-hidden />{!status ? t("sandbox.preparing") : status.enabled ? status.available ? t("sandbox.protected") : t("sandbox.unavailable") : t("sandbox.host")}</span>
      </div>
      {status?.enabled && !status.available ? <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("sandbox.setup")}</p>
        <Button variant="outline" size="sm" disabled={busy || !canWrite || !client.canApprove} onClick={() => {
          setBusy(true); setError(null);
          void client.prepareSandbox().then(refresh).catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.status_unavailable"))).finally(() => setBusy(false));
        }}>{t("sandbox.prepare")}</Button>
      </div> : null}
      {status && !status.policy ? <p className="text-xs text-muted-foreground">{syncLabels[status.sync]}</p> : null}
    </div>
    {error || query.isError ? <p role="alert" className="text-sm text-destructive">{error ?? t("sandbox.status_unavailable")}</p> : null}
  </section>;
}
