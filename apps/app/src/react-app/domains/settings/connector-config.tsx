/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, ChevronDown, Folder, Loader2, Mail, RefreshCw } from "lucide-react";
import { connectorDefinitions, connectorIsConnected, connectorStatusSchema, type ConnectorStatus, type ConnectorOAuthClient } from "@legalwork/types/connectors";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { usePlatform } from "../../kernel/platform";
import { registerExtensionRuntime } from "./extension-registry";
import type { ExtensionConfigContext } from "./extension-registry";
import { CONNECTOR_SETTINGS_CHANGED, ConnectorWriteSettings } from "./connector-write-settings";
import { resolveBrandIconSrc } from "../../design-system/extension-icon-src";

export function ConnectorConfig({ id, legalworkServerClient: client, onExtensionConnectionChange, presentation = "panel" }: Pick<ExtensionConfigContext, "legalworkServerClient" | "onExtensionConnectionChange"> & { id: string; presentation?: "panel" | "dialog" }) {
  const platform = usePlatform();
  const definition = connectorDefinitions.find((item) => item.id === id);
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<"nango" | "custom" | null>(null);
  const [oauthClient, setOAuthClient] = useState<ConnectorOAuthClient | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tenantId, setTenantId] = useState("");
  const active = useRef<{ cancelled: boolean; flowId?: string } | null>(null);
  const mounted = useRef(false);
  const connectionChange = useRef(onExtensionConnectionChange);
  useEffect(() => { connectionChange.current = onExtensionConnectionChange; }, [onExtensionConnectionChange]);

  const update = useCallback((value: ConnectorStatus) => {
    if (!mounted.current) return;
    const parsed = connectorStatusSchema.parse(value);
    setStatus(parsed);
    setError(null);
    for (const connector of parsed.connectors) connectionChange.current?.(connector.id, connectorIsConnected(connector));
  }, []);

  const refresh = useCallback(async (forceRefresh = false) => {
    if (!client) return;
    const [value, details] = await Promise.all([definition?.kind === "files" && !forceRefresh ? client.connectorSavedStatus(id) : client.connectorStatus(id, forceRefresh), client.connectorOAuthClient(id)]);
    if (!mounted.current) return;
    update(value); setOAuthClient(details); setClientId(details.clientId); setTenantId(details.tenantId); setClientSecret("");
  }, [client, id, update, definition?.kind]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch((value) => { if (mounted.current) setError(value instanceof Error ? value.message : t("connectors.failed")); });
    return () => {
      mounted.current = false;
      const pending = active.current;
      if (pending) {
        pending.cancelled = true;
        if (pending.flowId) void client?.connectorCancelFlow(pending.flowId).catch(() => undefined);
      }
    };
  }, [client, refresh]);

  useEffect(() => {
    const changed = () => {
      if (client) void client.connectorOAuthClient(id).then((details) => { if (mounted.current) setOAuthClient(details); })
        .catch(() => { if (mounted.current) setError(t("connectors.failed")); });
    };
    window.addEventListener(CONNECTOR_SETTINGS_CHANGED, changed);
    return () => window.removeEventListener(CONNECTOR_SETTINGS_CHANGED, changed);
  }, [client, id]);

  const run = async (label: string, command: () => Promise<void>) => {
    if (active.current || busy) return;
    setBusy(label); setError(null); setNotice(null);
    try { await command(); }
    catch (value) { if (mounted.current) setError(value instanceof Error ? value.message : t("connectors.failed")); }
    finally { if (mounted.current) setBusy(null); }
  };

  const connector = status?.connectors.find((item) => item.id === id);
  const connections = connector?.connections ?? [];
  const sharedOutlookAccount = id === "outlook" || id === "outlook-calendar";
  const microsoft = oauthClient?.family === "microsoft";
  const builtIn = oauthClient?.builtIn === true;
  const method = connections.length === 1 ? connections[0].source ?? "nango" : microsoft ? "custom" : selectedMethod ?? (status?.requiresSignIn || oauthClient?.configured ? "custom" : "nango");
  const dirty = clientId.trim() !== oauthClient?.clientId || tenantId.trim() !== oauthClient?.tenantId || Boolean(clientSecret.trim());
  const connect = async (connectionId?: string, source = method) => {
    if (!client) return;
    const pending: { cancelled: boolean; flowId?: string } = { cancelled: false };
    active.current = pending;
    try {
      const flow = await client.connectorConnect(id, connectionId, source);
      pending.flowId = flow.flowId;
      if (pending.cancelled) return;
      platform.openLink(flow.connectUrl);
      while (!pending.cancelled && Date.now() < flow.expiresAt) {
        const result = await client.connectorFlowStatus(flow.flowId);
        if (pending.cancelled) return;
        if (result.status === "connected") { await refresh(); if (mounted.current) setNotice(t("connectors.connected")); return; }
        if (result.status === "expired") break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!pending.cancelled) throw new Error(t("connectors.expired"));
    } finally {
      if (pending.flowId) await client.connectorCancelFlow(pending.flowId).catch(() => undefined);
      if (active.current === pending) active.current = null;
    }
  };

  if (!definition) return null;
  const Icon = definition.kind === "calendar" ? CalendarDays : definition.kind === "files" ? Folder : Mail;
  const iconSrc = resolveBrandIconSrc(undefined, definition.icon);
  const oauthFields = oauthClient && <div className="space-y-3">
    <p className="text-sm text-muted-foreground">{t(oauthClient.family === "google" ? "connectors.google_setup" : "connectors.microsoft_setup")}</p>
    <Field>
      <FieldLabel htmlFor={`${id}-client-id`}>{t("connectors.client_id")}</FieldLabel>
      <Input id={`${id}-client-id`} value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" disabled={Boolean(busy)} />
    </Field>
    {oauthClient.supportsClientSecret && <Field>
      <FieldLabel htmlFor={`${id}-client-secret`}>{t("connectors.client_secret")}</FieldLabel>
      <Input id={`${id}-client-secret`} type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" disabled={Boolean(busy)} placeholder={oauthClient.hasClientSecret ? t("connectors.secret_saved") : undefined} />
    </Field>}
    {oauthClient.family === "microsoft" && <Field>
      <FieldLabel htmlFor={`${id}-tenant-id`}>{t("connectors.tenant_id")}</FieldLabel>
      <Input id={`${id}-tenant-id`} value={tenantId} onChange={(event) => setTenantId(event.target.value)} autoComplete="off" disabled={Boolean(busy)} placeholder={id === "onedrive-personal" ? "consumers" : "common"} />
      <FieldDescription>{t("connectors.tenant_hint")}</FieldDescription>
    </Field>}
    <Field>
      <FieldLabel htmlFor={`${id}-redirect`}>{t("connectors.redirect_uri")}</FieldLabel>
      <Input id={`${id}-redirect`} value={oauthClient.redirectUri} readOnly className="font-mono text-xs" />
    </Field>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("connectors.permissions")}</summary><ul className="mt-2 space-y-1">{oauthClient.scopes.map((scope) => <li key={scope} className="break-all font-mono">{scope}</li>)}</ul></details>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={Boolean(busy) || !clientId.trim() || !dirty} onClick={() => void run("save", async () => {
        if (!client) return;
        await client.connectorSaveOAuthClient(id, { clientId: clientId.trim(), tenantId: tenantId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) });
        await refresh(); setNotice(t("connectors.details_saved"));
      })}>{t("connectors.save_details")}</Button>
      {oauthClient.configured && !builtIn && <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void run("remove", async () => {
        if (client) { await client.connectorRemoveOAuthClient(id); await refresh(); }
      })}>{t(microsoft ? "connectors.use_default_app" : "connectors.remove_details")}</Button>}
    </div>
    <p className="text-xs text-muted-foreground">{t("connectors.local_vault")}</p>
  </div>;
  return (
    <div className="space-y-5">
      {presentation === "panel" && <header className="space-y-2">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {iconSrc ? <img src={iconSrc} alt="" className="size-5 shrink-0 object-contain" /> : <Icon className="size-4" />}
          {definition.name}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t(definition.descriptionKey)}</p>
      </header>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {connections.length > 1 && <Alert variant="destructive"><AlertDescription>{t("connectors.single_account_cleanup")}</AlertDescription></Alert>}
      {notice && <p className="flex items-center gap-2 text-sm text-green-11" role="status"><CheckCircle2 className="size-4 shrink-0" />{notice}</p>}
      {!client && <p className="text-sm text-muted-foreground">{t("connectors.server_required")}</p>}

      <section className="space-y-3" aria-labelledby={`${id}-account-heading`}>
        <div className="flex items-center justify-between gap-3">
          <h3 id={`${id}-account-heading`} className="text-sm font-medium">{t(connections.length ? "connectors.account_single" : "connectors.account_heading")}</h3>
          <Button variant="ghost" size="sm" disabled={Boolean(busy) || !client} onClick={() => void run("refresh", () => refresh(true))}>
            <RefreshCw className={busy === "refresh" || (!status && !error && client) ? "size-3.5 animate-spin" : "size-3.5"} />
            {t("connectors.refresh")}
          </Button>
        </div>
        {connections.map((connection, index) => (
          <div key={connection.id} className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {connections.length > 1 && <p className="font-medium text-foreground">{t("connectors.account", { count: index + 1 })}</p>}
              <p>{t(connection.source === "custom" ? builtIn ? "connectors.microsoft_signin" : "connectors.method_custom" : "connectors.method_nango")}</p>
              {connection.needsReconnect && <p className="mt-1 text-destructive">{t("connectors.reconnect_needed")}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={Boolean(busy) || connections.length > 1} onClick={() => void run("connect", () => connect(connection.id, connection.source === "custom" ? "custom" : "nango"))}>
                {busy === "connect" && <Loader2 className="size-3.5 animate-spin" />}{t("connectors.reconnect")}
              </Button>
              <Button variant="outline" size="sm" disabled={Boolean(busy) || connections.length > 1 || (sharedOutlookAccount && !connector?.active)} onClick={() => void run("test", async () => {
                if (client) { await client.connectorTest(id, connection.id); setNotice(t("connectors.test_passed")); }
              })}>{busy === "test" && <Loader2 className="size-3.5 animate-spin" />}{t("connectors.test")}</Button>
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={Boolean(busy)} onClick={() => void run("disconnect", async () => {
                if (client) update(await client.connectorDisconnect(id, connection.id));
              })}>{t("connectors.disconnect")}</Button>
            </div>
          </div>
        ))}
        {sharedOutlookAccount && connections.length === 1 && <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t(connector?.active ? "connectors.activation_active" : "connectors.activation_available")}</p>
            <Button variant={connector?.active ? "outline" : "default"} size="sm" disabled={Boolean(busy) || !client} onClick={() => void run("activate", async () => {
              if (client) { await client.connectorActivation(id, connections[0].id, !connector?.active); await refresh(); }
            })}>{t(connector?.active ? "connectors.deactivate" : "connectors.activate", { name: definition.name })}</Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("connectors.outlook_shared")}</p>
        </div>}
        {status && connections.length === 0 && <>
          {!microsoft && <Field>
            <FieldLabel htmlFor={`${id}-method`}>{t("connectors.method")}</FieldLabel>
            <Select value={method} disabled={Boolean(busy)} onValueChange={(value) => { if (value === "nango" || value === "custom") setSelectedMethod(value); }}>
              <SelectTrigger id={`${id}-method`} className="w-full"><SelectValue>{t(method === "custom" ? "connectors.method_custom" : "connectors.method_nango")}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="nango">{t("connectors.method_nango")}</SelectItem><SelectItem value="custom">{t("connectors.method_custom")}</SelectItem></SelectContent>
            </Select>
          </Field>}
          {client && <div className="border-t border-border py-3"><ConnectorWriteSettings id={id} kind={definition.kind} client={client} /></div>}
          {method === "custom" && !builtIn && oauthFields}
          {method === "nango" && status?.requiresSignIn && <Alert><AlertDescription>{t("connectors.signin_hint")}</AlertDescription></Alert>}
          {method === "nango" && status && !status.requiresSignIn && !connector?.configured && <Alert><AlertDescription>{t("connectors.unavailable")}</AlertDescription></Alert>}
          <Button disabled={Boolean(busy) || !client || (method === "custom" ? !oauthClient?.configured || dirty : !connector?.configured || status.requiresSignIn)} onClick={() => void run("connect", () => connect())}>
            {busy === "connect" && <Loader2 className="size-4 animate-spin" />}{t("connectors.connect", { name: definition.name })}
          </Button>
        </>}
        {busy === "connect" && <div className="flex items-center gap-3">
          <p className="flex-1 text-sm text-muted-foreground" role="status">{t("connectors.waiting")}</p>
          <Button variant="ghost" size="sm" onClick={() => {
            const pending = active.current;
            if (pending) { pending.cancelled = true; if (pending.flowId) void client?.connectorCancelFlow(pending.flowId).catch(() => undefined); }
          }}>{t("connectors.cancel")}</Button>
        </div>}
      </section>

      {client && connections.length > 0 && <div className="border-t border-border pt-5"><ConnectorWriteSettings id={id} kind={definition.kind} client={client} /></div>}

      <details className="group border-t border-border pt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          {t("connectors.connection_details")}<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 pb-1 pt-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{t(method === "custom" ? builtIn ? "connectors.direct_privacy" : "connectors.custom_privacy" : "connectors.privacy", { name: definition.name })}</p>
          {sharedOutlookAccount && connections.length === 0 && <p className="text-xs leading-relaxed text-muted-foreground">{t("connectors.outlook_shared")}</p>}
          {method === "custom" && (connections.length > 0 || builtIn) && <details className="space-y-3">
            <summary className="cursor-pointer text-sm font-medium">{t(builtIn ? "connectors.method_custom" : "connectors.oauth_details")}</summary>
            {oauthFields}
          </details>}
        </div>
      </details>
    </div>
  );
}

for (const { id } of connectorDefinitions) registerExtensionRuntime({ id,
  settingsPanel: (ctx) => <ConnectorConfig key={id} {...ctx} id={id} presentation="dialog" />,
  isConnected: (_entry, ctx) => ctx.extensionConnections?.[id] === true,
});
