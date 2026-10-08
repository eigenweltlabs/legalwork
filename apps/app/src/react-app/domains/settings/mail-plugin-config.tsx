/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Loader2, Mail, ShieldCheck } from "lucide-react";
import { mailPluginStatusSchema, type MailPluginStatus, type MailProvider } from "@legalwork/types/mail-plugins";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/i18n";
import { usePlatform } from "../../kernel/platform";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { registerExtensionRuntime, type ExtensionConfigContext } from "./extension-registry";

type MailConfigClient = Pick<LegalworkServerClient, "mailPluginStatus" | "mailPluginConnectStart" | "mailPluginConnectStatus" | "mailPluginConnectCancel" | "mailPluginDisconnect" | "mailPluginWorkspaceAccess">;
type MailPluginConfigProps = Pick<ExtensionConfigContext, "localWorkspaceId" | "onExtensionConnectionChange"> & { provider: MailProvider; hostLegalworkServerClient?: MailConfigClient | null };
export function MailPluginConfig({ provider, hostLegalworkServerClient: client, localWorkspaceId, onExtensionConnectionChange }: MailPluginConfigProps) {
  const platform = usePlatform();
  const [status, setStatus] = useState<MailPluginStatus | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<{ id: string; cancelled: boolean } | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const title = provider === "gmail" ? "Gmail" : "Outlook";
  const apply = (value: MailPluginStatus) => {
    if (!mounted.current) return;
    setStatus(value);
    onExtensionConnectionChange?.(provider, value.accounts.some((account) => account.workspaceAccess));
  };
  const refresh = async () => { const version = generation.current; if (client) { const value = mailPluginStatusSchema.parse(await client.mailPluginStatus(provider, localWorkspaceId)); if (version === generation.current) apply(value); } };
  useEffect(() => {
    mounted.current = true;
    generation.current++;
    setStatus(null); setError(null); setNotice(null); setBusy(false); setConnecting(false);
    void refresh().catch(() => { if (mounted.current) setError(t("mail_plugin.connection_error")); });
    return () => {
      mounted.current = false;
      generation.current++;
      const flow = pending.current;
      if (flow) { flow.cancelled = true; pending.current = null; void client?.mailPluginConnectCancel(provider, flow.id).catch(() => undefined); }
    };
  }, [client, provider, localWorkspaceId]);
  const run = async (operation: () => Promise<void>) => {
    const version = generation.current;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); }
    catch (failure) { if (mounted.current && version === generation.current) setError(failure instanceof Error ? failure.message : t("mail_plugin.connection_error")); }
    finally { if (mounted.current && version === generation.current) setBusy(false); }
  };
  const connect = async () => {
    if (!client || !localWorkspaceId) return;
    const version = generation.current;
    const start = await client.mailPluginConnectStart(provider, { canWrite, workspaceId: localWorkspaceId });
    if (!mounted.current || version !== generation.current) { await client.mailPluginConnectCancel(provider, start.flowId); return; }
    const flow = { id: start.flowId, cancelled: false };
    pending.current = flow;
    setConnecting(true);
    try {
      await platform.openLink(start.authUrl);
      while (!flow.cancelled && Date.now() < start.expiresAt) {
        const result = await client.mailPluginConnectStatus(provider, flow.id);
        if (flow.cancelled) return;
        if (result.status === "connected") { await refresh(); return; }
        if (result.status !== "pending") throw new Error(result.error || t("mail_plugin.signin_incomplete"));
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!flow.cancelled) throw new Error(t("mail_plugin.signin_expired"));
    } finally {
      if (pending.current === flow) pending.current = null;
      if (mounted.current) setConnecting(false);
      if (flow.cancelled) await client.mailPluginConnectCancel(provider, flow.id);
    }
  };
  const cancel = () => {
    const flow = pending.current;
    if (flow) { flow.cancelled = true; void client?.mailPluginConnectCancel(provider, flow.id).catch(() => undefined); }
  };
  return <div className="space-y-4">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <Alert><AlertDescription>{notice}</AlertDescription></Alert>}
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="size-5" />{title}</CardTitle><CardDescription>{t("mail_plugin.description")}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <p className="flex items-start gap-2 text-sm text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0" />{t("mail_plugin.privacy")}</p>
        {!localWorkspaceId && <p className="text-sm text-muted-foreground">{t("mail_plugin.local_project_required")}</p>}
        {status && !status.configured && <p className="text-sm text-muted-foreground">{t("mail_plugin.not_available")}</p>}
        {status?.accounts.map((account) => <div key={account.id} className="space-y-3 rounded-xl border border-border p-3">
          <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{account.email}</p><p className="text-xs text-muted-foreground">{account.canWrite ? t("mail_plugin.read_write") : t("mail_plugin.read_only")}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            if (!client) return;
            const result = await client.mailPluginDisconnect(provider, account.id);
            await refresh();
            if (provider === "outlook") setNotice(t("mail_plugin.microsoft_disconnect_notice"));
            else if (!result.providerRevoked) setNotice(t("mail_plugin.google_disconnect_notice"));
          })}>{t("mail_plugin.disconnect")}</Button></div>
          {localWorkspaceId && <label className="flex items-center gap-2 text-sm"><Checkbox checked={account.workspaceAccess === true} disabled={busy} onCheckedChange={(enabled) => void run(async () => {
            if (client) apply(await client.mailPluginWorkspaceAccess(provider, account.id, localWorkspaceId, enabled === true));
          })} />{t("mail_plugin.project_access")}</label>}
        </div>)}
        <label className="flex items-start gap-2 text-sm"><Checkbox checked={canWrite} disabled={busy} onCheckedChange={(value) => setCanWrite(value === true)} /><span>{t("mail_plugin.write_permission")}<span className="mt-1 block text-xs text-muted-foreground">{t("mail_plugin.send_confirmation")}</span></span></label>
        <p className="text-xs text-muted-foreground">{t("mail_plugin.connect_project_notice")}</p>
      </CardContent>
      <CardFooter className="flex-wrap gap-2"><Button disabled={busy || !client || !localWorkspaceId || status?.configured !== true} onClick={() => void run(connect)}>{busy && <Loader2 className="size-4 animate-spin" />}{t("mail_plugin.connect", { provider: title })}</Button>{connecting && <Button variant="outline" onClick={cancel}>{t("mail_plugin.cancel")}</Button>}<Button variant="ghost" disabled={busy || !client} onClick={() => void run(refresh)}>{t("mail_plugin.refresh")}</Button></CardFooter>
    </Card>
    {provider === "outlook" && <a className="text-xs text-muted-foreground underline" href="https://myapps.microsoft.com/" target="_blank" rel="noreferrer">{t("mail_plugin.manage_microsoft")}</a>}
    {provider === "gmail" && <a className="text-xs text-muted-foreground underline" href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">{t("mail_plugin.manage_google")}</a>}
  </div>;
}
for (const provider of ["gmail", "outlook"] satisfies MailProvider[]) registerExtensionRuntime({
  id: provider,
  settingsPanelRefs: [`legalwork.${provider}.settings`],
  settingsPanel: (ctx) => <MailPluginConfig key={`${provider}:${ctx.localWorkspaceId}`} {...ctx} provider={provider} />,
  isConnected: (_entry, ctx) => ctx.extensionConnections?.[provider] === true,
});
