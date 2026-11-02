import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { researchWebsite, type ResearchProvider } from "@legalwork/types/legal-research";
import type { LegalworkBrowserPassword, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { t } from "@/i18n";

/** Only this private form holds password text. Lists and URLs contain saved IDs only. */
export function ResearchConnectionDialog({ client, workspaceId, provider, connection, template, onClose, onSaved }: {
  client: LegalworkServerClient; workspaceId: string; provider?: ResearchProvider;
  connection?: LegalworkBrowserPassword; template?: LegalworkBrowserPassword; onClose: () => void; onSaved: () => void;
}) {
  const cache = useQueryClient();
  const [name, setName] = useState(connection?.label ?? provider?.name ?? template?.label ?? "");
  const [username, setUsername] = useState(connection?.username ?? "");
  const [password, setPassword] = useState("");
  const [researchUrl, setResearchUrl] = useState(connection?.websites[0]?.url ?? provider?.researchUrl ?? (template?.websites.find(site => site.providerId)?.url ?? template?.websites[0]?.url) ?? "");
  const [loginUrl, setLoginUrl] = useState(connection?.origin ?? provider?.loginUrl ?? template?.origin ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A retry after linking fails must reuse the just-saved login, not create a duplicate.
  const savedId = useRef(connection?.id);
  const submit = async () => {
    if (busy || !client.canApprove) return;
    const website = researchWebsite.safeParse(researchUrl), login = researchWebsite.safeParse(loginUrl.trim() || researchUrl);
    if (!name.trim() || !website.success || !login.success) { setError(t("research.invalid_url")); return; }
    setBusy(true); setError("");
    try {
      const { item } = await client.saveBrowserPassword({ id: savedId.current, label: name.trim(), origin: new URL(login.data).origin, username, ...(password ? { password } : {}) });
      savedId.current = item.id; setPassword("");
      if (!connection) await client.configureResearchDatabase(workspaceId, provider
        ? { providerId: provider.id, country: provider.countries.length === 1 ? provider.countries[0] : "OTHER", passwordId: item.id, ...(!provider.loginUrl ? { loginUrl: login.data } : {}) }
        : { name: name.trim(), researchUrl: website.data, loginUrl: login.data, country: "OTHER", passwordId: item.id });
      await cache.invalidateQueries({ queryKey: ["browser-passwords"] });
      onSaved(); onClose();
    } catch { setError(t("research.setup_failed")); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
      <DialogHeader><DialogTitle>{connection ? t("catalog.manage_login") : provider ? t("research.connect_title", { name: provider.name }) : t("catalog.save_browser_login")}</DialogTitle><DialogDescription>{t("catalog.research_setup")}</DialogDescription></DialogHeader>
      <form id="research-connection" data-private data-ph-mask className="min-h-0 space-y-5 overflow-y-auto" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className="block space-y-2 text-sm"><span className="block">{t("catalog.login_name")}</span><Input value={name} required maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        {!provider && !connection ? <label className="block space-y-2 text-sm"><span className="block">{t("catalog.website_url")}</span><Input value={researchUrl} type="url" required disabled={busy} onChange={event => setResearchUrl(event.target.value)} /></label> : null}
        {!connection && !provider?.loginUrl ? <label className="block space-y-2 text-sm"><span className="block">{t("research.login_url")}</span><Input value={loginUrl} type="url" disabled={busy} onChange={event => setLoginUrl(event.target.value)} /></label> : null}
        <label className="block space-y-2 text-sm"><span className="block">{t("settings.browser_passwords.username")}</span><Input value={username} autoComplete="username" maxLength={500} disabled={busy} onChange={event => setUsername(event.target.value)} /></label>
        <label className="block space-y-2 text-sm"><span className="block">{t("settings.browser_passwords.password")}</span><Input type="password" value={password} autoComplete="new-password" required={!savedId.current} maxLength={10000} disabled={busy} placeholder={connection ? t("catalog.keep_password") : undefined} onChange={event => setPassword(event.target.value)} /></label>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </form>
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button type="submit" form="research-connection" disabled={busy || !client.canApprove}>{t(busy ? "settings.environment.saving" : "research.set_up")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
