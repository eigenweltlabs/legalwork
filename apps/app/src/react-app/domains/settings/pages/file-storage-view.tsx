import { ShareCloudStorageDialog } from "./share-cloud-storage-dialog";
import { ConnectorWriteSettings, CONNECTOR_SETTINGS_CHANGED } from "../connector-write-settings";
/** @jsxImportSource react */
import { IntegrationAddMenu, IntegrationMoreMenu, IntegrationLibraryRow, IntegrationLibraryHeader, IntegrationSearch, IntegrationGroupHeading, IntegrationEmptyState, useIntegrationAddRequest, useIntegrationLibraryLayout } from "./integration-library";
import { useEffect, useRef, useState } from "react";
import { usePlatform } from "../../../kernel/platform";
import { saveStorageAndSignIn } from "./storage-connect";
import { ConnectionMethodPicker } from "./connection-method-picker";
import { connectorDefinitions } from "@legalwork/types/connectors";
import { ConnectorConfig } from "../connector-config";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import { resolveBrandIconSrc } from "../../../design-system/extension-icon-src";
import { StorageCloudLocations } from "./storage-cloud-locations";
import { ConnectorStatus } from "./connector-status";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Loader2,
  HardDrive,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  storageInputSchema,
  type StorageConnection,
  type StorageOAuthProvider,
  type StorageKind,
  type StorageSecretKey,
} from "@legalwork/types/file-storage";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { t } from "@/i18n";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  STORAGE_CHANGED_EVENT,
  storageAuthDescription,
  storageDefaults,
  storageDescription,
  storageFields,
  storageIcons,
  storageKinds,
  storageLabel,
  storageSecretFields,
} from "./storage-providers";
import { StorageOAuthSignIn } from "./storage-oauth-signin";
import { useHubScope } from "./hub-scope-context";
import { storageConnectionsForScope, storageNeedsSignIn } from "./storage-scope";
import { orgPolicyAllows, useOrgPolicyForbids } from "../../connections/org-policy";
import { OrgPolicyNote } from "../../connections/org-policy-ui";

export function FileStorageView({
  client,
  workspaceId,
}: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
}) {
  const queryClient = useQueryClient();
  const libraryLayout = useIntegrationLibraryLayout();
  const scope = useHubScope() ?? "local";
  const [editor, setEditor] = useState<{ kind: StorageKind; connection?: StorageConnection; provider?: StorageOAuthProvider; account?: StorageConnection } | null>(null);
  const [nativeProvider, setNativeProvider] = useState<string | null>(null);
  const native = connectorDefinitions.find((item) => item.id === nativeProvider);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sharing, setSharing] = useState<StorageConnection | null>(null);
  const [removing, setRemoving] = useState<StorageConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  useEffect(() => { setSearch(""); setPickerOpen(false); setEditor(null); }, [workspaceId, scope]);
  const connections = useQuery({
    queryKey: ["storage-connections", workspaceId],
    queryFn: () => client!.storageConnections(workspaceId!),
    enabled: Boolean(client && workspaceId),
    retry: false,
    refetchInterval: 30_000,
  });
  const providers = useQuery({
    queryKey: ["storage-oauth-providers", workspaceId],
    queryFn: () => client!.storageOAuthProviders(workspaceId!),
    enabled: Boolean(client && workspaceId),
  });
  const allConnections = connections.data?.connections ?? [];
  const detail = allConnections.find(connection => connection.id === detailId);
  const source = libraryLayout?.source ?? "all";
  const visibleConnections = libraryLayout
    ? allConnections.filter(connection => source === "all" || (source === "team" ? Boolean(connection.team) : !connection.team))
    : storageConnectionsForScope(allConnections, scope);
  const nativeDefinition = (connection: StorageConnection) => connection.config.kind === "oauth" ? connectorDefinitions.find(provider => connection.config.kind === "oauth" && provider.id === connection.config.provider) : undefined;
  const storageProviderName = (connection: StorageConnection) => nativeDefinition(connection)?.name ?? (connection.config.kind === "oauth" ? providers.data?.providers.find(provider => connection.config.kind === "oauth" && provider.id === connection.config.provider)?.name ?? connection.config.provider : storageLabel(connection.config.kind));
  const nativeAccounts = useQuery({
    queryKey: ["storage-native-accounts", workspaceId],
    queryFn: () => client!.connectorSavedStatus(),
    enabled: Boolean(client && workspaceId && allConnections.some(connection => connection.enabled && connection.config.kind === "oauth" && connection.config.sharingMode !== "team" && nativeDefinition(connection))),
    retry: false,
    refetchInterval: 30_000,
  });
  const needsSignIn = (connection: StorageConnection) => storageNeedsSignIn(connection, nativeAccounts.data);
  const query = search.trim().toLowerCase();
  const matchingConnections = visibleConnections.filter(connection => !query || `${connection.name} ${storageProviderName(connection)}`.toLowerCase().includes(query));
  const providerQuery = providerSearch.trim().toLowerCase();
  const matchingNativeProviders = connectorDefinitions.filter(provider => provider.kind === "files" && (!providerQuery || provider.name.toLowerCase().includes(providerQuery)));
  const matchingProviders = (providers.data?.providers ?? []).filter(provider => !providerQuery || provider.name.toLowerCase().includes(providerQuery));
  const matchingKinds = storageKinds.filter(kind => !providerQuery || `${storageLabel(kind)} ${storageDescription(kind)}`.toLowerCase().includes(providerQuery));
  // The firm may allow no connections of the member's own.
  const personalForbidden = useOrgPolicyForbids("storage.allowPersonal");
  // The firm's connections are set up on the platform, and who gets them decided there.
  const canAdd = scope === "local" && !personalForbidden;
  const managedAdd = useIntegrationAddRequest("storage", async () => {
    if (busy || !canAdd || !client || !workspaceId || !(await orgPolicyAllows("storage.allowPersonal"))) return;
    setProviderSearch("");
    setPickerOpen(true);
  });
  const openNewEditor = async (next: NonNullable<typeof editor>) => {
    if (scope === "local" && !(await orgPolicyAllows("storage.allowPersonal"))) return;
    setPickerOpen(false);
    setEditor(next);
  };
  const openNativeAccount = (providerId: string) => {
    setPickerOpen(false);
    setDetailId(null);
    setNativeProvider(providerId);
  };
  const openFolderView = (account: StorageConnection) => {
    const provider = nativeDefinition(account);
    if (provider) void openNewEditor({ kind: "oauth", account, provider: { id: provider.id, name: provider.name, rootHint: t(provider.id === "google-drive" ? "storage.google_root_hint" : "storage.microsoft_root_hint") } });
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["storage-connections"] });
    void queryClient.invalidateQueries({ queryKey: ["storage-roots"] });
    void queryClient.invalidateQueries({ queryKey: ["storage-children"] });
    window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT));
  };
  useEffect(() => {
    setEditor(null);
    setNativeProvider(null);
    setRemoving(null);
    setDetailId(null);
    setError("");
  }, [client, workspaceId, scope]);
  useEffect(() => {
    const listener = () => {
      void connections.refetch();
      void queryClient.invalidateQueries({ queryKey: ["storage-native-accounts"] });
    };
    window.addEventListener(STORAGE_CHANGED_EVENT, listener);
    window.addEventListener(CONNECTOR_SETTINGS_CHANGED, listener);
    return () => {
      window.removeEventListener(STORAGE_CHANGED_EVENT, listener);
      window.removeEventListener(CONNECTOR_SETTINGS_CHANGED, listener);
    };
  }, [connections.refetch, queryClient]);
  async function setTeamInstalled(connection: StorageConnection) {
    if (!client || !workspaceId || !connection.team) return;
    setBusy(true);
    setError("");
    try {
      await client.setTeamStorageInstalled(workspaceId, connection.id, !connection.team.installed);
      refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
    finally { setBusy(false); }
  }
  if (!client || !workspaceId)
    return (
      <div className="rounded-2xl border border-border p-6 text-sm text-muted-foreground">
        {t("storage.connect_workspace")}
      </div>
    );
  return (
    <div className="space-y-6">
      <IntegrationLibraryHeader title={t("storage.tab")} description={t(scope === "team" ? "storage.team_intro" : "integrations.storage_description")} actions={<>
        {!managedAdd ? <IntegrationAddMenu disabled={busy || !canAdd} actions={[{ label: t("storage.add"), icon: Plus, onClick: () => { setProviderSearch(""); setPickerOpen(true); } }]} /> : null}
        <IntegrationMoreMenu busy={busy} onRefresh={refresh} />
      </>} />
      {scope === "local" ? <OrgPolicyNote policyKey="storage.allowPersonal" /> : null}
      <IntegrationSearch toolbar value={search} onChange={setSearch} label={t("integrations.search_storage")} />
      {(error || connections.error || nativeAccounts.error) && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error || connections.error?.message || nativeAccounts.error?.message}
        </p>
      )}
      {(libraryLayout || scope === "team") && connections.data?.team?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {connections.data.team.error}
        </p>
      ) : null}
      {connections.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("storage.loading")}
        </div>
      ) : null}
      {matchingConnections.length ? (
        <section className="space-y-3">
          <IntegrationGroupHeading hideInLibrary title={t(scope === "team" ? "integrations.shared_storage" : "integrations.your_storage")} count={matchingConnections.length} />
          <div className="space-y-1">
            {matchingConnections.map((connection) => {
              const Icon = storageIcons[connection.config.kind];
              const provider = nativeDefinition(connection);
              const accountRoot = connection.id.startsWith("connector:");
              const icon = provider && resolveBrandIconSrc(undefined, provider.icon);
              return (
                <IntegrationLibraryRow key={connection.id} name={connection.name} description={`${storageProviderName(connection)} · ${t(connection.readOnly ? "storage.read_only" : "storage.read_write")}`}
                  icon={icon ? <span className="grid size-9 shrink-0 place-items-center"><img src={icon} alt="" className="size-6 object-contain" /></span> : <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border"><Icon className="size-4 text-muted-foreground" /></span>}
                  source={connection.team ? t("firm_hub.scope_team") : undefined} status={needsSignIn(connection) ? <ConnectorStatus state="needs_auth" /> : undefined} busy={busy} onOpen={() => (accountRoot || needsSignIn(connection)) && provider ? openNativeAccount(provider.id) : setDetailId(connection.id)}
                  onEdit={!connection.team && !accountRoot ? () => setEditor({ kind: connection.config.kind, connection }) : undefined}
                  onRemove={!connection.team && !accountRoot ? () => setRemoving(connection) : undefined}
                  actions={!connection.team && provider ? <><DropdownMenuItem disabled={!connections.data?.team?.canManage} onClick={() => setSharing(connection)}>{t("storage.share_team")}</DropdownMenuItem>{accountRoot && canAdd ? <DropdownMenuItem onClick={() => openFolderView(connection)}><Plus />{t("storage.add_folder_view")}</DropdownMenuItem> : null}</> : connection.team && connection.teamInstallation === "optional" ? <DropdownMenuItem disabled={!connection.enabled && !connection.team.installed} onClick={() => void setTeamInstalled(connection)}>{t(connection.team.installed ? "storage.remove_local" : "storage.install")}</DropdownMenuItem> : undefined} />
              );
            })}
          </div>
        </section>
      ) : !connections.isLoading && !connections.error ? (
        <IntegrationEmptyState icon={HardDrive} title={t(query ? "integrations.no_storage_matches" : source === "team" || scope === "team" ? "integrations.no_shared_storage" : "integrations.no_storage_title")} description={query ? t("integrations.search_hint") : source === "team" || scope === "team" ? undefined : t(personalForbidden ? "storage.local_empty_team_only" : "integrations.no_storage_description")} action={!query && canAdd && source !== "team" ? <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}><Plus className="size-4" />{t("storage.add")}</Button> : undefined} />
      ) : null}
      <Dialog open={Boolean(detail)} onOpenChange={open => { if (!open) setDetailId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{detail?.name}</DialogTitle><DialogDescription>{detail ? `${storageProviderName(detail)} · ${t(detail.readOnly ? "storage.read_only" : "storage.read_write")}` : ""}</DialogDescription></DialogHeader>
          {detail ? <div className="space-y-4">
            {needsSignIn(detail) ? <><ConnectorStatus state="needs_auth" /><p className="text-sm text-muted-foreground">{t("integrations.team_sign_in_hint", { name: storageProviderName(detail) })}</p></> : null}
            <p className="text-sm text-muted-foreground">{t(!detail.enabled ? "storage.paused" : detail.team?.installed === false ? "storage.available" : "storage.enabled")}</p>
            {detail.team ? <p className="text-sm text-muted-foreground">{t(detail.teamInstallation === "optional" ? "storage.team_optional" : "storage.team_automatic")}</p> : null}
            {detail.config.kind === "oauth" && !detail.config.accountId && !nativeDefinition(detail) && detail.enabled && detail.team?.installed !== false ? <StorageOAuthSignIn client={client} workspaceId={workspaceId} connectionId={detail.id} revision={detail.updatedAt} onChanged={refresh} /> : null}
            {detail.config.kind === "oauth" && detail.config.sharingMode !== "team" && nativeDefinition(detail) ? <Button variant={needsSignIn(detail) ? "default" : "outline"} onClick={() => { const provider = nativeDefinition(detail); if (provider) openNativeAccount(provider.id); }}>{t(needsSignIn(detail) ? "storage.oauth_connect" : "storage.account_settings")}</Button> : null}
            {detail.team && nativeDefinition(detail) && detail.config.kind === "oauth" && detail.config.sharingMode === "team" ? <ConnectorWriteSettings id={detail.config.provider} kind="files" client={client} /> : null}
            {detail.team && detail.teamInstallation === "optional" ? <Button variant="outline" disabled={busy || (!detail.enabled && !detail.team.installed)} onClick={() => void setTeamInstalled(detail)}>{t(detail.team.installed ? "storage.remove_local" : "storage.install")}</Button> : null}
          </div> : null}
          <DialogFooter>
            {detail && !detail.team ? <Button variant="outline" disabled={busy} onClick={() => { setEditor({ kind: detail.config.kind, connection: detail }); setDetailId(null); }}>{t("common.edit")}</Button> : null}
            <Button onClick={() => setDetailId(null)}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={pickerOpen && canAdd} onOpenChange={setPickerOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-3rem)] flex-col gap-5 sm:max-w-2xl">
          <DialogHeader className="pe-8"><DialogTitle>{t("storage.add")}</DialogTitle><DialogDescription>{t("integrations.storage_picker_description")}</DialogDescription></DialogHeader>
          <IntegrationSearch value={providerSearch} onChange={setProviderSearch} label={t("integrations.search_providers")} />
          <div className="min-h-0 overflow-y-auto">
            {providers.error ? <p role="alert" className="mb-4 text-sm text-destructive">{providers.error.message}</p> : null}
            {providers.isLoading ? <p role="status" className="mb-4 text-sm text-muted-foreground">{t("storage.loading")}</p> : null}
            <div className="grid gap-2 sm:grid-cols-2">
              {matchingNativeProviders.map(provider => {
                const icon = resolveBrandIconSrc(undefined, provider.icon);
                const account = allConnections.find(connection => connection.id.startsWith(`connector:${provider.id}:`));
                return <button key={provider.id} type="button" onClick={() => openNativeAccount(provider.id)} className="flex items-start gap-3 rounded-xl border border-border p-4 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {icon && <img src={icon} alt="" className="mt-0.5 size-5 shrink-0 object-contain" />}<span><span className="block text-sm font-medium">{provider.name}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{t(account ? "connectors.connected" : "storage.oauth_description")}</span></span>
                </button>;
              })}
              {matchingProviders.map(provider => <button key={provider.id} type="button" onClick={() => void openNewEditor({ kind: "oauth", provider })} className="flex items-start gap-3 rounded-xl border border-border p-4 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ArrowUpRight className="mt-0.5 size-5 shrink-0 text-muted-foreground" /><span><span className="block text-sm font-medium">{provider.name}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{t("storage.oauth_description")}</span></span>
              </button>)}
              {matchingKinds.map(kind => { const Icon = storageIcons[kind]; return <button key={kind} type="button" onClick={() => void openNewEditor({ kind })} className="flex items-start gap-3 rounded-xl border border-border p-4 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" /><span><span className="block text-sm font-medium">{storageLabel(kind)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{storageDescription(kind)}</span></span>
              </button>; })}
            </div>
            {!providers.isLoading && matchingNativeProviders.length === 0 && matchingProviders.length === 0 && matchingKinds.length === 0 ? <IntegrationEmptyState icon={HardDrive} title={t("integrations.no_provider_matches")} description={t("integrations.search_hint")} /> : null}
          </div>
        </DialogContent>
      </Dialog>
      {sharing && <ShareCloudStorageDialog client={client} workspaceId={workspaceId} connection={sharing} onClose={() => setSharing(null)} onSaved={refresh} />}
      {editor && (
        <StorageConnectionDialog
          client={client}
          workspaceId={workspaceId}
          kind={editor.kind}
          provider={editor.provider ?? providers.data?.providers.find((p) => editor.connection?.config.kind === "oauth" && editor.connection.config.provider === p.id) ?? (() => { const definition = connectorDefinitions.find((p) => editor.connection?.config.kind === "oauth" && editor.connection.config.provider === p.id); return definition ? { id: definition.id, name: definition.name, rootHint: t(definition.id === "google-drive" ? "storage.google_root_hint" : "storage.microsoft_root_hint") } : undefined; })()}
          connection={editor.connection}
          account={editor.account}
          onClose={() => setEditor(null)}
          onBack={!editor.connection ? () => { setEditor(null); setPickerOpen(true); } : undefined}
          onSaved={refresh}
        />
      )}
      {native && <ExtensionDetailModal open onClose={() => setNativeProvider(null)} name={native.name} description={t(native.descriptionKey)} iconSlug={native.icon} kind="extension" presentation="connector"
        connected={Boolean(connections.data?.connections.some((item) => item.id.startsWith(`connector:${native.id}:`)))}
        configSlot={<>
          <ConnectorConfig id={native.id} legalworkServerClient={client} presentation="dialog" onExtensionConnectionChange={() => refresh()} />
          {canAdd && allConnections.some(connection => connection.id.startsWith(`connector:${native.id}:`)) && <Button variant="outline" onClick={() => {
            const account = allConnections.find(connection => connection.id.startsWith(`connector:${native.id}:`));
            if (account) { setNativeProvider(null); openFolderView(account); }
          }}><Plus />{t("storage.add_folder_view")}</Button>}
        </>} />}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.remove_title")}</DialogTitle>
            <DialogDescription>{t("storage.remove_body", { name: removing?.name ?? "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!removing) return;
                setBusy(true);
                setError("");
                try {
                  await client.removeStorageConnection(workspaceId, removing.id);
                  setRemoving(null);
                  refresh();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : t("storage.failed"));
                  setRemoving(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t("storage.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StorageConnectionDialog({
  client,
  workspaceId,
  kind,
  provider,
  connection,
  account,
  onClose,
  onBack,
  onSaved,
  customSetup,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  kind: StorageKind;
  provider?: StorageOAuthProvider;
  connection?: StorageConnection;
  account?: StorageConnection;
  onClose: () => void;
  onBack?: () => void;
  onSaved: () => void;
  customSetup?: { name: string; onSelect: () => void };
}) {
  const platform = usePlatform();
  const activeSave = useRef<AbortController | null>(null);
  useEffect(() => () => activeSave.current?.abort(), []);
  const initial = connection ?? account;
  const cloud = initial?.config.kind === "oauth" && Boolean(initial.config.accountId);
  const [name, setName] = useState(connection?.name ?? provider?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    initial
      ? Object.fromEntries(Object.entries(initial.config).map(([key, value]) => [key, String(value)]))
      : kind === "oauth" ? { provider: provider?.id ?? "", root: "" } : storageDefaults(kind),
  );
  const [secrets, setSecrets] = useState<Partial<Record<StorageSecretKey, string>>>({});
  const [readOnly, setReadOnly] = useState(initial?.readOnly ?? false);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [busy, setBusy] = useState<"test" | "save" | "signin" | null>(null);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const Icon = storageIcons[kind];
  const providerName = provider?.name ?? storageLabel(kind);
  const change = (key: string, value: string) => {
    setTested(false);
    setError("");
    setValues((current) => ({ ...current, [key]: value }));
  };
  const submit = async (testing: boolean) => {
    setError("");
    setTested(false);
    const config: Record<string, unknown> = { ...values, kind };
    if (!config.endpoint) delete config.endpoint;
    for (const field of storageFields(kind)) if (field.type === "number") config[field.key] = Number(values[field.key]);
    if (kind === "s3") config.forcePathStyle = values.forcePathStyle === "true";
    const input = storageInputSchema.safeParse({
      name: testing && !name.trim() ? storageLabel(kind) : name,
      config,
      secrets,
      readOnly,
      enabled,
    });
    if (!input.success) {
      setError(
        input.error.issues.some((issue) => issue.path.at(-1) === "requestHeaders")
          ? t("storage.invalid_headers")
          : t("storage.check_fields") + " " + input.error.issues.map((issue) => issue.path.join(".")).join(", "),
      );
      return;
    }
    setBusy(testing ? "test" : "save");
    try {
      if (testing) {
        await client.testStorageConnection(workspaceId, input.data, connection?.id);
        setTested(true);
      } else {
        const controller = new AbortController();
        activeSave.current = controller;
        await saveStorageAndSignIn(client, workspaceId, input.data, { id: connection?.id, signal: controller.signal, openLink: url => platform.openLink(url), onWaiting: () => setBusy("signin") });
        onSaved();
        onClose();
      }
    } catch (cause) {
      if (!activeSave.current?.signal.aborted) setError(cause instanceof Error ? cause.message : t("storage.failed"));
    } finally {
      activeSave.current = null;
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!busy || busy === "signin")) { activeSave.current?.abort(); onClose(); }
      }}
    >
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          {onBack ? <Button variant="link" size="xs" className="mb-2 w-fit px-0 text-muted-foreground" onClick={onBack}>{t("integrations.change_provider")}</Button> : null}
          <DialogTitle className="flex items-center gap-3 text-xl">
            <Icon className="size-5 text-muted-foreground" />
            {connection ? t("storage.edit_title") : cloud ? t("storage.add_folder_view") : t("storage.connect_provider", { provider: providerName })}
          </DialogTitle>
          <DialogDescription>{storageDescription(kind)}</DialogDescription>
        </DialogHeader>
        <form
          id="storage-connection-form"
          className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(false);
          }}
        >
          {!connection && !account && customSetup ? <ConnectionMethodPicker name={customSetup.name} onCustom={customSetup.onSelect} disabled={Boolean(busy)} /> : null}
          <fieldset disabled={Boolean(busy)} className="flex min-w-0 flex-col gap-6">
          <Field>
            <FieldLabel htmlFor="storage-name">{t("storage.name")}</FieldLabel>
            <Input
              id="storage-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("storage.name_placeholder")}
              required
              maxLength={100}
              disabled={Boolean(busy)}
            />
            <FieldDescription>{t(cloud ? "storage.personal_view_hint" : "storage.name_help")}</FieldDescription>
          </Field>
          {kind === "oauth" && <Field>
            <FieldLabel htmlFor="storage-oauth-root">{t("storage.oauth_root")}</FieldLabel>
            <Input id="storage-oauth-root" value={values.root ?? ""} onChange={(event) => change("root", event.target.value)} placeholder={provider?.rootHint} />
            <FieldDescription>{cloud ? t(values.provider === "google-drive" ? "storage.google_root_hint" : "storage.microsoft_root_hint") : provider?.rootHint ?? t("storage.oauth_root_hint")} {cloud ? t("storage.account_reused") : t("storage.oauth_edit_root")}</FieldDescription>
            {cloud && values.provider === "google-drive" && <StorageCloudLocations client={client} provider={values.provider} accountId={values.accountId!} onSelect={(id) => change("root", id)} />}
          </Field>}
          {cloud && values.provider !== "google-drive" && <Field>
            <FieldLabel htmlFor="storage-drive-id">{t("storage.drive_id")}</FieldLabel>
            <Input id="storage-drive-id" value={values.driveId ?? ""} onChange={(event) => change("driveId", event.target.value)} required={values.provider === "sharepoint-files"} />
            {values.provider !== "onedrive-personal" && <StorageCloudLocations client={client} provider={values.provider!} accountId={values.accountId!} onSelect={(id) => change("driveId", id)} />}
          </Field>}
          <div className="grid gap-4 sm:grid-cols-2">
            {storageFields(kind).map((field) => (
              <Field
                key={field.key}
                className={
                  kind === "webdav" || field.key === "endpoint" || field.key === "rootPath" || field.key === "hostFingerprint"
                    ? "sm:col-span-2"
                    : ""
                }
              >
                <FieldLabel htmlFor={`storage-${field.key}`}>
                  {field.label}
                  {field.optional && (
                    <span className="text-xs font-normal text-muted-foreground">{t("storage.optional")}</span>
                  )}
                </FieldLabel>
                <Input
                  id={`storage-${field.key}`}
                  value={values[field.key] ?? ""}
                  onChange={(event) => change(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  required={!field.optional}
                  type={field.type ?? "text"}
                  min={field.type === "number" ? 1 : undefined}
                  max={field.type === "number" ? 65535 : undefined}
                  disabled={Boolean(busy)}
                  autoComplete="off"
                />
              </Field>
            ))}
          </div>
          {kind === "s3" && (
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={values.forcePathStyle === "true"}
                onCheckedChange={(checked) => change("forcePathStyle", String(checked))}
                disabled={Boolean(busy)}
              />
              {t("storage.path_style")}
            </label>
          )}
          {kind === "smb" && (
            <div className="space-y-2">
              <FieldLabel htmlFor="storage-encryption">{t("storage.encryption")}</FieldLabel>
              <select
                id="storage-encryption"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={values.encryption}
                onChange={(event) => change("encryption", event.target.value)}
              >
                <option value="if-offered">{t("storage.encryption_available")}</option>
                <option value="required">{t("storage.encryption_required")}</option>
              </select>
            </div>
          )}
          {kind === "ftp" && (
            <Field>
              <FieldLabel htmlFor="storage-security">{t("storage.security")}</FieldLabel>
              <select
                id="storage-security"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={values.security}
                onChange={(event) => change("security", event.target.value)}
                disabled={Boolean(busy)}
              >
                <option value="tls">{t("storage.explicit_tls")}</option>
                <option value="implicit">{t("storage.implicit_tls")}</option>
                <option value="none">{t("storage.plain_ftp")}</option>
              </select>
            </Field>
          )}
          {storageSecretFields(kind).length > 0 && (
            <section className="space-y-4 border-t border-border pt-5">
              <div>
                <h4 className="text-sm font-medium">{t("storage.credentials")}</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{storageAuthDescription(kind)}</p>
                {connection && <p className="mt-1 text-xs text-muted-foreground">{t("storage.keep_secrets")}</p>}
              </div>
              {storageSecretFields(kind).map((field) => (
                <Field key={field.key}>
                  <FieldLabel htmlFor={`storage-${field.key}`}>{field.label}</FieldLabel>
                  {field.multiline ? (
                    <Textarea
                      id={`storage-${field.key}`}
                      aria-describedby={field.description ? `storage-${field.key}-help` : undefined}
                      aria-invalid={field.key === "requestHeaders" && error === t("storage.invalid_headers")}
                      autoComplete="off"
                      value={secrets[field.key] ?? ""}
                      onChange={(event) => {
                        setTested(false);
                        setError("");
                        const value = event.target.value;
                        setSecrets((current) => {
                          const next = { ...current };
                          if (value) next[field.key] = value;
                          else delete next[field.key];
                          return next;
                        });
                      }}
                      placeholder={
                        connection?.configuredSecrets.includes(field.key) && secrets[field.key] !== ""
                          ? t("storage.secret_saved")
                          : field.placeholder
                      }
                      className="min-h-20 font-mono text-xs"
                      disabled={Boolean(busy)}
                      spellCheck={false}
                    />
                  ) : (
                    <Input
                      id={`storage-${field.key}`}
                      type="password"
                      autoComplete="new-password"
                      value={secrets[field.key] ?? ""}
                      onChange={(event) => {
                        setTested(false);
                        const value = event.target.value;
                        setSecrets((current) => {
                          const next = { ...current };
                          if (value) next[field.key] = value;
                          else delete next[field.key];
                          return next;
                        });
                      }}
                      placeholder={
                        connection?.configuredSecrets.includes(field.key) && secrets[field.key] !== ""
                          ? t("storage.secret_saved")
                          : undefined
                      }
                      disabled={Boolean(busy)}
                    />
                  )}
                  {field.description && (
                    <p id={`storage-${field.key}-help`} className="text-xs leading-5 text-muted-foreground">
                      {field.description}
                    </p>
                  )}
                  {connection?.configuredSecrets.includes(field.key) && secrets[field.key] !== "" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="w-fit text-xs"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setSecrets((current) => ({ ...current, [field.key]: "" }));
                        setTested(false);
                      }}
                    >
                      {t("storage.clear_secret")}
                    </Button>
                  )}
                </Field>
              ))}
            </section>
          )}
          <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">{t("storage.read_only")}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("storage.read_only_help")}</span>
              </span>
              <Switch checked={readOnly} onCheckedChange={setReadOnly} disabled={Boolean(busy)} />
            </label>
            {kind !== "oauth" || connection ? <label className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <span>
                <span className="block text-sm font-medium">{t("storage.show_drive")}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("storage.show_drive_help")}</span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={Boolean(busy)} />
            </label> : null}
          </div>
          </fieldset>
          {busy === "signin" ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("storage.oauth_pending")}</p> : null}
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="size-4 shrink-0" />
              {error}
            </p>
          )}
          {tested && (
            <p role="status" className="flex items-start gap-2 text-sm text-green-11">
              <Check className="size-4 shrink-0" />
              {t("storage.test_success")}
            </p>
          )}
        </form>
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-wrap gap-2 border-t border-border bg-muted/20 px-6 py-4">
          {kind !== "oauth" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void submit(true)} className="sm:mr-auto">
            {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("storage.test")}
          </Button>}
          <Button variant="ghost" disabled={Boolean(busy) && busy !== "signin"} onClick={() => { activeSave.current?.abort(); onClose(); }}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="storage-connection-form" disabled={Boolean(busy)}>
            {(busy === "save" || busy === "signin") && <Loader2 className="size-4 animate-spin" />}
            {connection ? t("storage.save_connection") : kind === "oauth" && !cloud ? t("connectors.connect", { name: providerName }) : t("storage.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
