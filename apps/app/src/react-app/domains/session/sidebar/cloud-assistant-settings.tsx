import { useEffect, useState } from "react";
import type { CloudAssistantStatus } from "@legalwork/types/cloud-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function CloudAssistantSettings({ client }: { client: LegalworkServerClient }) {
  const [status, setStatus] = useState<CloudAssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  useEffect(() => {
    let closed = false;
    const refresh = async () => {
      try { const next = await client.cloudAssistantStatus(); if (!closed) { setStatus(next); setRefreshError(null); } }
      catch { if (!closed) setRefreshError(t("assistant.cloud_unavailable")); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { closed = true; clearInterval(timer); };
  }, [client]);
  const settingUp = status && ["preparing", "syncing", "starting"].includes(status.state);
  const change = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { setStatus(await (enabled ? client.enableCloudAssistant() : client.disableCloudAssistant())); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("assistant.cloud_unavailable")); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2 border-t border-border py-4">
    <label className="flex items-start justify-between gap-4">
      <span className="space-y-1"><span className="block text-sm font-medium">{t("assistant.cloud_title")}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{t("assistant.cloud_hint")}</span></span>
      <Switch className="mt-0.5 shrink-0" aria-label={t("assistant.cloud_title")} checked={status?.enabled ?? false}
        disabled={!status?.connected || busy || Boolean(settingUp)} onCheckedChange={value => { void change(value); }} />
    </label>
    {!status?.connected && <p className="text-xs text-muted-foreground">{t("assistant.cloud_sign_in")}</p>}
    {status?.connected && <p className="text-xs text-muted-foreground">{t("assistant.cloud_schedules")}</p>}
    {settingUp && <p role="status" className="text-xs text-muted-foreground">{t(status.state === "syncing" ? "assistant.cloud_syncing" : status.state === "starting" ? "assistant.cloud_starting" : "assistant.cloud_preparing")}</p>}
    {status?.enabled && <p role="status" className="text-xs text-muted-foreground">{t("assistant.cloud_ready", { account: status.accountName ?? "Eigenwelt" })}</p>}
    {(error || status?.error || refreshError) && <p role="alert" className="text-xs text-destructive">{error ?? status?.error ?? refreshError}</p>}
    {status?.state === "error" && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { void change(true); }}>{t("assistant.cloud_retry")}</Button>}
  </div>;
}
