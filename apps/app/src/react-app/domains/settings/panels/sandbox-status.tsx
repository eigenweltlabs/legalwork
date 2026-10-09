import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function SandboxStatus({ client, canWrite = false }: { client: LegalworkServerClient; canWrite?: boolean }) {
  const [status, setStatus] = useState<Awaited<ReturnType<LegalworkServerClient["sandboxStatus"]>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const networkItems = [
    { value: "allow", label: t("sandbox.network_allow") },
    { value: "block", label: t("sandbox.network_block") },
    { value: "approve", label: t("sandbox.network_approve") },
  ];
  useEffect(() => {
    let cancelled = false;
    void client.sandboxStatus().then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => { if (!cancelled) setError(t("sandbox.status_unavailable")); });
    return () => { cancelled = true; };
  }, [client]);
  if (status && !status.enabled) return null;
  return <div className="rounded-2xl border border-subtle bg-surface p-4" aria-live="polite">
    <div className="font-medium text-ink">{t("sandbox.title")}</div>
    <p className="mt-1 text-sm text-subtext">{t("sandbox.description")}</p>
    {status ? <div className="mt-4 space-y-2">
      <div className="font-medium text-ink">{t("sandbox.network_title")}</div>
      <Select value={status.networkMode} items={networkItems} disabled={!canWrite || saving}
        onValueChange={(mode) => {
          if ((mode !== "allow" && mode !== "block" && mode !== "approve") || mode === status.networkMode) return;
          setSaving(true); setError(null);
          void client.setSandboxNetworkMode(mode).then((result) => {
            setStatus((current) => current ? { ...current, networkMode: result.networkMode } : current);
          }).catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.network_save_failed")))
            .finally(() => setSaving(false));
        }}>
        <SelectTrigger className="w-full" aria-label={t("sandbox.network_title")}><SelectValue /></SelectTrigger>
        <SelectContent>{networkItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-sm text-subtext">{status.networkMode === "allow" ? t("sandbox.network_allow_desc") : status.networkMode === "block" ? t("sandbox.network_block_desc") : t("sandbox.network_approve_desc")}</p>
      <p className="text-xs text-subtext">{t("sandbox.network_scope")}</p>
    </div> : null}
    <p className="mt-2 text-sm text-subtext">{busy || !status ? t("sandbox.preparing") : ready ? t("sandbox.ready") : status.available ? t("sandbox.available") : t("sandbox.setup")}</p>
    {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    <div className="mt-3 flex items-center gap-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void client.prepareSandbox().then(() => { setReady(true); })
          .catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.status_unavailable")))
          .finally(() => setBusy(false));
      }}>{t("sandbox.prepare")}</Button>
    </div>
  </div>;
}
