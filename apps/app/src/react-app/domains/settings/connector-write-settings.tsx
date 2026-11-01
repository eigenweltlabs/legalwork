/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type {ConnectorMailAccess,ConnectorCalendarAccess} from "@legalwork/types/connectors";
import { ChevronDown } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";

export const CONNECTOR_SETTINGS_CHANGED = "legalwork-connector-settings-changed";
export function ConnectorWriteSettings({ id, kind, client, mailOptions=false, calendarOptions=false, onReconnect }: { id: string; kind: "mail" | "calendar" | "files"; client: LegalworkServerClient | null | undefined; mailOptions?:boolean; calendarOptions?:boolean; onReconnect?:()=>Promise<void> }) {
  const features:(keyof ConnectorMailAccess)[]=id==='outlook'?['contacts','sharedMailboxes']:['contacts'];
  const [mailAccess,setMailAccess]=useState<ConnectorMailAccess>({contacts:false,sharedMailboxes:false});
  const [calendarAccess,setCalendarAccess]=useState<ConnectorCalendarAccess>({sharedCalendars:false});
  const [enabled, setEnabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false); setError(null);
    if (client) void client.connectorSettings(id).then((value) => {
      if (!cancelled) { setEnabled(value.writeAccess); setMailAccess(value.mailAccess??{contacts:false,sharedMailboxes:false}); setCalendarAccess(value.calendarAccess??{sharedCalendars:false}); setReadOnly(value.readOnly); setLoaded(true); }
    }).catch(() => { if (!cancelled) setError(t("connectors.write_settings_failed")); });
    return () => { cancelled = true; };
  }, [client, id]);
  if (!client) return null;
  async function saveOptional(feature:keyof ConnectorMailAccess,value:boolean){
    if(!client||busy||!loaded)return;setBusy(true);setError(null);
    try{const result=await client.setConnectorMailAccess(id,{...mailAccess,[feature]:value});setMailAccess(result.mailAccess??{contacts:false,sharedMailboxes:false});window.dispatchEvent(new Event(CONNECTOR_SETTINGS_CHANGED));if(value)await onReconnect?.();}
    catch{setError(t('connectors.write_settings_failed'));}finally{setBusy(false);}
  }
  async function saveSharedCalendars(value:boolean){
    if(!client||busy||!loaded)return;setBusy(true);setError(null);
    try{const result=await client.setConnectorCalendarAccess(id,{sharedCalendars:value});setCalendarAccess(result.calendarAccess??{sharedCalendars:false});window.dispatchEvent(new Event(CONNECTOR_SETTINGS_CHANGED));if(value)await onReconnect?.();}
    catch{setError(t('connectors.write_settings_failed'));}finally{setBusy(false);}
  }
  return <section className="space-y-3" aria-labelledby={`${id}-write-label`}>
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <label id={`${id}-write-label`} htmlFor={`${id}-write-access`} className="text-sm font-medium text-dls-text">{t("connectors.write_access")}</label>
        {kind==="files"&&<p id={`${id}-write-description`} className="text-[13px] leading-relaxed text-dls-secondary">{t("connectors.write_access_files")}</p>}
      </div>
      <Switch id={`${id}-write-access`} aria-describedby={kind==="files"?`${id}-write-description`:undefined} checked={enabled} disabled={!loaded || busy || readOnly} onCheckedChange={(value) => {
        if (busy || !loaded) return;
        setBusy(true); setError(null);
        void client.setConnectorSettings(id, value).then(async(settings) => {
          setEnabled(settings.writeAccess);
          window.dispatchEvent(new Event(CONNECTOR_SETTINGS_CHANGED));
          if(value&&kind==='calendar'&&calendarOptions)await onReconnect?.();
        }).catch(() => setError(t("connectors.write_settings_failed"))).finally(() => setBusy(false));
      }} />
    </div>
    {kind==="files"&&<details className="group text-xs text-dls-secondary">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {t("connectors.permissions_help")}<ChevronDown className="size-3 transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 leading-relaxed">{t("connectors.write_access_permissions")}</p>
    </details>}
    {kind==='mail'&&mailOptions&&<div className="space-y-3">{features.map(feature=><div key={feature} className="flex items-center justify-between gap-4"><label htmlFor={`${id}-${feature}`} className="text-sm">{t(feature==='contacts'?'connectors.mail_contacts':'connectors.mail_shared_mailboxes')}</label><Switch id={`${id}-${feature}`} checked={mailAccess[feature]} disabled={!loaded||busy||readOnly} onCheckedChange={value=>void saveOptional(feature,value)}/></div>)}</div>}
    {id==='outlook-calendar'&&calendarOptions&&<div className="flex items-center justify-between gap-4"><label htmlFor={`${id}-shared-calendars`} className="text-sm">{t('connectors.calendar_shared')}</label><Switch id={`${id}-shared-calendars`} checked={calendarAccess.sharedCalendars} disabled={!loaded||busy||readOnly} onCheckedChange={value=>void saveSharedCalendars(value)}/></div>}
    {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
  </section>;
}
