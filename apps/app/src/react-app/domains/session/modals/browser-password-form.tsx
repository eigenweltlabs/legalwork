import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import type { BrowserPasswordRequest } from "@legalwork/types/browser-password-request";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineCard, InlineCardFooter, InlineCardHeader } from "@/components/chat/inline-card";
import { t } from "@/i18n";

/** Password state belongs only to this card, never the chat/form answer cache. */
export function BrowserPasswordForm({ request, client, busy, onComplete, onCancel }: {
  request: BrowserPasswordRequest;
  client?: LegalworkServerClient;
  busy: boolean;
  onComplete: (id: string) => void;
  onCancel: () => void;
}) {
  const id = useId(), cache = useQueryClient();
  const [username, setUsername] = useState(request.username), [password, setPassword] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null), [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false), [error, setError] = useState("");
  const active = useRef(true), submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const available = Boolean(client?.canApprove);
  const existing = useQuery({ queryKey: ["browser-passwords", client?.baseUrl, request.website],
    queryFn: () => { if (!client) throw new Error(t("browser_password_request.unavailable")); return client.listBrowserPasswords(request.website); }, enabled: available });
  const entries = existing.data?.items ?? [];
  const entryId = savedId ?? (entries.length ? selectedId || entries[0]!.id : null);
  const disabled = busy || saving;
  const save = async () => {
    if (!client || !available || disabled || submitting.current) return;
    const entry = entries.find(item => item.id === entryId);
    if (entryId && (savedId || !request.startUrl || entry?.websites?.some(site => site.url === request.startUrl))) { onComplete(entryId); return; }
    submitting.current = true; setSaving(true); setError("");
    try {
      if (entryId && !entry) throw new Error("The selected saved login is unavailable.");
      const { item } = await client.saveBrowserPassword({ ...(entry ? { id: entry.id, origin: entry.origin, label: entry.label, username: entry.username } : { origin: request.website, label: request.label, username, password }), ...(request.startUrl ? { websiteUrl: request.startUrl } : {}) });
      if (!active.current) return;
      setPassword(""); setSavedId(item.id);
      void cache.invalidateQueries({ queryKey: ["browser-passwords", client.baseUrl] });
      onComplete(item.id);
    } catch {
      if (active.current) setError(t("browser_password_request.save_failed"));
    } finally {
      submitting.current = false;
      if (active.current) setSaving(false);
    }
  };
  const rowClass = "grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 border-b border-border/50 px-5 py-2.5 focus-within:bg-muted/20";
  return <InlineCard>
    <form data-private data-ph-mask onSubmit={event => { event.preventDefault(); void save(); }}>
      <InlineCardHeader icon={<KeyRound className="size-3.5 text-muted-foreground" />} title={t("browser_password_request.title")} />
      <div className={rowClass}>
        <span className="text-xs text-muted-foreground">{t("settings.browser_passwords.website")}</span>
        <span className="min-w-0 break-all text-sm" title={request.website}>{request.website}</span>
      </div>
      {request.startUrl ? <div className={rowClass}>
        <span className="text-xs text-muted-foreground">{t("website_connections.destination")}</span>
        <span className="min-w-0 break-all text-sm">{request.startUrl}</span>
      </div> : null}
      {!available ? <p role="alert" className="px-5 py-3 text-xs text-muted-foreground">{t("browser_password_request.unavailable")}</p> : null}
      {existing.isLoading ? <p role="status" className="px-5 py-3 text-xs text-muted-foreground">{t("settings.browser_passwords.loading")}</p> : null}
      {existing.error ? <div role="alert" className="space-y-2 px-5 py-3 text-xs text-destructive"><p>{t("browser_password_request.load_failed")}</p>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => void existing.refetch()}>{t("browser_password_request.retry")}</Button></div> : null}
      {entryId ? <div className="space-y-2 px-5 py-4">
        <p role="status" className="text-sm">{t("browser_password_request.saved")}</p>
        {entries.length > 1 ? <select aria-label={t("browser_password_request.account")} className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={entryId} disabled={disabled}
          onChange={event => setSelectedId(event.currentTarget.value)}>
          {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.label}{entry.username ? ` · ${entry.username}` : ""}</option>)}
        </select> : null}
      </div> : <div className="space-y-3 px-5 py-4">
        <div className="space-y-1.5">
          <label htmlFor={`${id}-username`} className="text-xs font-medium">{t("settings.browser_passwords.username")}</label>
          <Input id={`${id}-username`} autoComplete="username" value={username} placeholder={t("browser_password_request.username_placeholder")} maxLength={500} disabled={disabled || !available} onChange={event => setUsername(event.currentTarget.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-password`} className="text-xs font-medium">{t("settings.browser_passwords.password")}</label>
          <Input id={`${id}-password`} type="password" autoComplete="current-password" value={password} placeholder={t("browser_password_request.password_placeholder")} required maxLength={10000} disabled={disabled || !available} onChange={event => setPassword(event.currentTarget.value)} />
        </div>
      </div>}
      {error ? <p role="alert" className="mx-5 mb-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      <InlineCardFooter className="flex-wrap">
        <span className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground" title={t("browser_password_request.manage")}><LockKeyhole className="size-3" />{t("browser_password_request.privacy")}</span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setPassword(""); onCancel(); }}>{t("settings.environment.cancel")}</Button>
        <Button type="submit" size="sm" disabled={disabled || !available || existing.isLoading || Boolean(existing.error) || !entryId && !password}>
          {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {t(saving ? "settings.environment.saving" : entryId ? "browser_password_request.continue" : "browser_password_request.save")}
        </Button>
      </InlineCardFooter>
    </form>
  </InlineCard>;
}
