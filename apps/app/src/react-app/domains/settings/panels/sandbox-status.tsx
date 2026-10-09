import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

type NetworkMode = "allow" | "block" | "approve";
export function SandboxNetworkControl({ value, disabled, onChange }: { value: NetworkMode; disabled: boolean; onChange: (mode: NetworkMode) => void }) {
  const items = [
    { value: "allow", label: t("sandbox.network_allow") },
    { value: "block", label: t("sandbox.network_block") },
    { value: "approve", label: t("sandbox.network_approve") },
  ];
  return <div className="space-y-2">
    <div className="font-medium">{t("sandbox.network_title")}</div>
    <Select value={value} items={items} disabled={disabled} onValueChange={mode => {
      if (mode === "allow" || mode === "block" || mode === "approve") onChange(mode);
    }}>
      <SelectTrigger className="w-full" aria-label={t("sandbox.network_title")}><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
    <p className="text-sm text-subtext">{value === "allow" ? t("sandbox.network_allow_desc") : value === "block" ? t("sandbox.network_block_desc") : t("sandbox.network_approve_desc")}</p>
  </div>;
}

export function SandboxStatus({ client, canWrite = false }: { client: LegalworkServerClient; canWrite?: boolean }) {
  const query = useQuery({ queryKey: ["sandbox-default", client.baseUrl], queryFn: () => client.sandboxStatus(), refetchInterval: 5000 });
  const status = query.data;
  const syncLabels = {
    local: t("sandbox.sync_local"), syncing: t("sandbox.sync_syncing"),
    synced: t("sandbox.sync_synced"), pending: t("sandbox.sync_pending"), conflict: t("sandbox.sync_conflict"),
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (settings: { enabled: boolean; networkMode: NetworkMode }) => {
    setBusy(true); setError(null);
    try { await client.setSandboxSettings(settings); await query.refetch(); }
    catch (error) { setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")); }
    finally { setBusy(false); }
  };
  return <div className="rounded-2xl border border-subtle bg-surface p-4" aria-live="polite">
    <div className="flex items-center justify-between gap-4">
      <div><div className="font-medium text-ink">{t("sandbox.title")}</div><p className="mt-1 text-sm text-subtext">{t("sandbox.application_scope")}</p></div>
      <Switch aria-label={t("sandbox.title")} checked={status?.enabled ?? false} disabled={!status?.supported || !canWrite || !client.canApprove || busy} onCheckedChange={enabled => { if (status) void save({ enabled, networkMode: status.networkMode }); }} />
    </div>
    <p className="mt-3 text-sm text-subtext">{status?.enabled ? t("sandbox.description") : t("sandbox.off_description")}</p>
    {status?.enabled ? <div className="mt-4 space-y-3">
      <SandboxNetworkControl value={status.networkMode} disabled={!canWrite || !client.canApprove || busy} onChange={networkMode => { void save({ enabled: true, networkMode }); }} />
      <p className="text-xs text-subtext">{t("sandbox.network_scope")}</p>
      <p className="text-sm text-subtext">{status.available ? t("sandbox.available") : t("sandbox.setup")}</p>
      {!status.available ? <Button variant="outline" size="sm" disabled={busy || !client.canApprove} onClick={() => {
        setBusy(true); setError(null);
        void client.prepareSandbox().then(() => query.refetch()).catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.status_unavailable"))).finally(() => setBusy(false));
      }}>{t("sandbox.prepare")}</Button> : null}
    </div> : null}
    {status ? <p className="mt-3 text-xs text-subtext">{syncLabels[status.sync]}</p> : null}
    {error || query.isError ? <p role="alert" className="mt-2 text-sm text-destructive">{error ?? t("sandbox.status_unavailable")}</p> : null}
  </div>;
}
