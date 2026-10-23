/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { ConnectorCloudAccess } from "@legalwork/types/connectors";
import { onSyncPoke } from "@/react-app/kernel/sync-events";

export const CONNECTOR_SETTINGS_CHANGED = "legalwork-connector-settings-changed";
export function ConnectorWriteSettings({ id, kind, client }: { id: string; kind: "mail" | "calendar" | "files"; client: LegalworkServerClient | null | undefined }) {
  const [enabled, setEnabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false); setError(null);
    if (client) void client.connectorSettings(id).then((value) => {
      if (!cancelled) { setEnabled(value.writeAccess); setReadOnly(value.readOnly); setLoaded(true); }
    }).catch(() => { if (!cancelled) setError(t("connectors.write_settings_failed")); });
    return () => { cancelled = true; };
  }, [client, id]);
  if (!client) return null;
  return <section className="space-y-3" aria-labelledby={`${id}-write-label`}>
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <label id={`${id}-write-label`} htmlFor={`${id}-write-access`} className="text-sm font-medium text-dls-text">{t("connectors.write_access")}</label>
        <p id={`${id}-write-description`} className="text-[13px] leading-relaxed text-dls-secondary">{kind === "mail" ? t("connectors.write_access_mail") : kind === "calendar" ? t("connectors.write_access_calendar") : t("connectors.write_access_files")}</p>
      </div>
      <Switch id={`${id}-write-access`} aria-describedby={`${id}-write-description`} checked={enabled} disabled={!loaded || busy || readOnly} onCheckedChange={(value) => {
        if (busy || !loaded) return;
        setBusy(true); setError(null);
        void client.setConnectorSettings(id, value).then((settings) => {
          setEnabled(settings.writeAccess);
          window.dispatchEvent(new Event(CONNECTOR_SETTINGS_CHANGED));
        }).catch(() => setError(t("connectors.write_settings_failed"))).finally(() => setBusy(false));
      }} />
    </div>
    <details className="group text-xs text-dls-secondary">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {t("connectors.permissions_help")}<ChevronDown className="size-3 transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 leading-relaxed">{t("connectors.write_access_permissions")}</p>
    </details>
    {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    <ConnectorCloudSettings id={id} client={client} />
  </section>;
}

function ConnectorCloudSettings({ id, client }: { id: string; client: LegalworkServerClient }) {
  const [value, setValue] = useState<ConnectorCloudAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => { void client.connectorCloudAccess(id).then(result => {
      if (!cancelled) { setValue(result); setError(result.syncError); }
    }).catch(() => { if (!cancelled) setError(true); }); };
    setValue(null); setError(false); load();
    const unsubscribe = onSyncPoke(poke => { if (poke.connectors) load(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [client, id]);
  return <div className="flex items-start justify-between gap-4 border-t border-dls-border pt-3">
    <div className="space-y-1">
      <label htmlFor={`${id}-cloud-access`} className="text-sm font-medium text-dls-text">{t("connectors.cloud_access")}</label>
      <p className="text-[13px] leading-relaxed text-dls-secondary">{t(value?.available ? "connectors.cloud_access_description" : "connectors.cloud_access_unavailable")}</p>
      {error && <p className="text-sm text-destructive" role="alert">{t("connectors.cloud_access_failed")}</p>}
    </div>
    <Switch id={`${id}-cloud-access`} checked={value?.enabled ?? false} disabled={!value?.available || value.readOnly || busy || error} onCheckedChange={enabled => {
      if (busy) return;
      setBusy(true); setError(false);
      void client.setConnectorCloudAccess(id, enabled).then(result => { setValue(result); setError(result.syncError); }).catch(() => setError(true)).finally(() => setBusy(false));
    }} />
  </div>;
}
