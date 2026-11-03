import { useState, type KeyboardEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { researchWebsite } from "@legalwork/types/legal-research";
import type { LegalworkBrowserPassword, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";

/** Destination links and credential permissions are deliberately separate controls. */
export function BrowserPasswordWebsites({ client, connection, disabled = false, onBusyChange, onSaved }: {
  client: LegalworkServerClient;
  connection: LegalworkBrowserPassword;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
}) {
  const [saved, setSaved] = useState(connection);
  const [adding, setAdding] = useState<"website" | "login" | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const update = async (operation: () => Promise<{ item: LegalworkBrowserPassword }>) => {
    if (busy || disabled || !client.canApprove) return;
    setBusy(true); onBusyChange(true); setError("");
    try {
      const result = await operation();
      setSaved(result.item); onSaved();
      setAdding(null); setUrl("");
    } catch { setError(t("settings.browser_passwords.urls_failed")); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const add = () => {
    const destination = researchWebsite.safeParse(url.trim());
    if (!destination.success) {
      setError(t("research.invalid_url")); return;
    }
    if (!adding) return;
    void update(() => client.addBrowserPasswordWebsite(saved.id, adding === "login" ? { loginUrl: destination.data } : { url: destination.data }));
  };
  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault(); add();
  };
  const addForm = <div className="space-y-3 pt-1">
    <label className="block space-y-1 text-sm"><span>{t("catalog.website_url")}</span><Input autoFocus type="url" value={url} maxLength={2000} placeholder="https://" onKeyDown={addOnEnter} onChange={event => setUrl(event.target.value)} /></label>
    <div className="flex justify-end gap-2">
      <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(null); setUrl(""); setError(""); }}>{t("common.cancel")}</Button>
      <Button type="button" size="sm" disabled={!url.trim()} onClick={add}>{t("settings.browser_passwords.save_url")}</Button>
    </div>
  </div>;
  return <fieldset data-testid="browser-password-websites" disabled={busy || disabled || !client.canApprove} className="min-w-0 space-y-4 rounded-lg border border-border p-3">
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{t("settings.browser_passwords.destinations")}</p>
        {!adding ? <Button type="button" size="sm" variant="outline" onClick={() => setAdding("website")}><Plus className="size-3.5" />{t("settings.browser_passwords.add_url")}</Button> : null}</div>
      <p className="text-xs leading-5 text-muted-foreground">{t("settings.browser_passwords.destinations_hint")}</p>
      {saved.websites.map(site => <div key={site.url} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
        <span className="min-w-0 flex-1 break-all text-xs">{site.url}</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("settings.browser_passwords.remove_url", { url: site.url })}
          onClick={() => void update(() => client.removeBrowserPasswordWebsite(saved.id, { url: site.url }))}><Trash2 className="size-3.5" /></Button>
      </div>)}
      {adding === "website" ? addForm : null}
    </div>
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">{t("settings.browser_passwords.login_websites")}</p>
        {!adding ? <Button type="button" size="sm" variant="outline" onClick={() => setAdding("login")}><Plus className="size-3.5" />{t("settings.browser_passwords.add_login_url")}</Button> : null}</div>
      <p className="text-xs leading-5 text-muted-foreground">{t("settings.browser_passwords.login_websites_hint")}</p>
      <p className="break-all text-xs text-muted-foreground">{saved.origin}</p>
      {(saved.additionalOrigins ?? []).map(origin => <div key={origin} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
        <span className="min-w-0 flex-1 break-all text-xs">{origin}</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label={t("settings.browser_passwords.remove_login_url", { url: origin })}
          onClick={() => void update(() => client.removeBrowserPasswordWebsite(saved.id, { loginUrl: origin }))}><Trash2 className="size-3.5" /></Button>
      </div>)}
      {adding === "login" ? addForm : null}
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </fieldset>;
}
