import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, RefreshCw, Shield, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { changeOrgPolicySetting } from "../../connections/org-policy";
import { HubTabs } from "../segmented-tabs";
import { SandboxNetworkControl, networkDescription, type NetworkMode } from "./sandbox-network-control";

export function SandboxStatus({ client, canWrite = false, variant = "full" }: { client: LegalworkServerClient; canWrite?: boolean; variant?: "full" | "quick" }) {
  const metadataInterval = useMetadataPolling(client.baseUrl, 5000);
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["sandbox-default", client.baseUrl], queryFn: () => client.sandboxStatus(), refetchInterval: metadataInterval });
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
  const toggle = variant === "quick" ? <Switch
    aria-label={t("sandbox.title")}
    checked={status?.enabled === true}
    disabled={disabled}
    onCheckedChange={enabled => { if (status) void save({ enabled, networkMode: status.networkMode }); }}
  /> : <fieldset disabled={disabled} className="shrink-0 disabled:opacity-50">
    <HubTabs label={t("sandbox.title")} items={[{ id: "off", label: t("sandbox.choice_off") }, { id: "on", label: t("sandbox.choice_on") }]} value={status?.enabled ? "on" : "off"} onChange={value => { if (status) void save({ enabled: value === "on", networkMode: status.networkMode }); }} />
  </fieldset>;
  const policyNote = status?.policy ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <Lock className="size-3.5" aria-hidden />{t(status.policy.locked ? "sandbox.managed" : "sandbox.firm_default", { org: status.policy.orgName || t("org_policy.your_firm") })}
  </p> : null;
  const errorNotice = error || query.isError ? <div className="space-y-2">
    <p role="alert" className="text-sm text-destructive">{error ?? (query.error instanceof Error ? query.error.message : t("sandbox.status_unavailable"))}</p>
    {query.error instanceof LegalworkServerError && query.error.code === "execution_settings_invalid" && canWrite && client.canApprove ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void save({ enabled: true, networkMode: "block" }); }}>{t("sandbox.on")} · {t("sandbox.network_block")}</Button> : null}
  </div> : null;
  if (variant === "quick") return <section className="space-y-3" aria-label={t("sandbox.title")}>
    <div className="divide-y divide-subtle rounded-2xl border border-subtle bg-surface shadow-xs">
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-base font-medium text-ink">{t("sandbox.title")}</h3>
          <p className="text-sm text-subtext">{t("onboarding_permissions.sandbox_description")}</p>
        </div>
        {toggle}
      </div>
      {status?.enabled ? <div className="space-y-2.5 px-4 py-3.5">
        <div className="space-y-0.5">
          <h4 className="text-base font-medium text-ink">{t("sandbox.network_title")}</h4>
          <p className="text-sm text-subtext">{t("onboarding_permissions.network_description")}</p>
        </div>
        <SandboxNetworkControl value={status.networkMode} disabled={disabled} onChange={networkMode => { void save({ enabled: true, networkMode }); }} />
      </div> : null}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{status?.policy?.locked ? t("sandbox.managed_scope") : t("onboarding_permissions.sandbox_scope")}</p>
    {policyNote}
    {status?.enabled && status.available === false ? <p role="status" className="text-sm text-muted-foreground">{t("sandbox.setup")}</p> : null}
    {errorNotice}
  </section>;
  return <section className="space-y-6 py-2" aria-label={t("sandbox.title")}>
    <div className="space-y-1">
      <h3 className="text-base font-medium text-foreground">{t("sandbox.title")}</h3>
      <p className="text-sm text-muted-foreground">{status?.policy?.locked ? t("sandbox.managed_scope") : t("sandbox.application_scope")}</p>
      {policyNote}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <h4 className="text-sm font-medium">{t("sandbox.execution_title")}</h4>
        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{status?.enabled ? t("sandbox.description") : t("sandbox.off_description")}</p>
      </div>
      {toggle}
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
        <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-2"><Icon className="size-4" aria-hidden />{!status || status.enabled && status.available === null ? t("sandbox.preparing") : status.enabled ? status.available ? t("sandbox.protected") : t("sandbox.unavailable") : t("sandbox.host")}</span>
      </div>
      {status?.enabled && status.available === false ? <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("sandbox.setup")}</p>
        <Button variant="outline" size="sm" disabled={busy || !canWrite || !client.canApprove} onClick={() => {
          setBusy(true); setError(null);
          void client.prepareSandbox().then(refresh).catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.status_unavailable"))).finally(() => setBusy(false));
        }}>{t("sandbox.prepare")}</Button>
      </div> : null}
      {status && !status.policy ? <p className="text-xs text-muted-foreground">{syncLabels[status.sync]}</p> : null}
    </div>
    {errorNotice}
  </section>;
}
