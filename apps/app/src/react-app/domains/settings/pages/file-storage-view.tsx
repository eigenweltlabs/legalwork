/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
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
import { cn } from "@/lib/utils";
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
import { storageConnectionsForScope } from "./storage-scope";

export function FileStorageView({
  client,
  workspaceId,
}: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
}) {
  const queryClient = useQueryClient();
  const scope = useHubScope() ?? "local";
  const [editor, setEditor] = useState<{ kind: StorageKind; connection?: StorageConnection; provider?: StorageOAuthProvider } | null>(null);
  const [removing, setRemoving] = useState<StorageConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addSection = useRef<HTMLElement>(null);
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
  const visibleConnections = storageConnectionsForScope(connections.data?.connections ?? [], scope);
  const canAdd = scope === "local" || connections.data?.team?.canManage === true;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["storage-connections"] });
    void queryClient.invalidateQueries({ queryKey: ["storage-roots"] });
    void queryClient.invalidateQueries({ queryKey: ["storage-children"] });
    window.dispatchEvent(new Event(STORAGE_CHANGED_EVENT));
  };
  useEffect(() => {
    setEditor(null);
    setRemoving(null);
    setError("");
  }, [client, workspaceId, scope]);
  useEffect(() => {
    const listener = () => {
      void connections.refetch();
    };
    window.addEventListener(STORAGE_CHANGED_EVENT, listener);
    return () => window.removeEventListener(STORAGE_CHANGED_EVENT, listener);
  }, [connections.refetch]);
  if (!client || !workspaceId)
    return (
      <div className="rounded-2xl border border-border p-6 text-sm text-muted-foreground">
        {t("storage.connect_workspace")}
      </div>
    );
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl space-y-2">
          <h3 className="text-xl font-medium tracking-tight">{t("storage.heading")}</h3>
          <p className="text-sm leading-6 text-muted-foreground">
            {t(scope === "team" ? "storage.team_intro" : "storage.local_intro")}
          </p>
        </div>
        {canAdd && (
          <Button onClick={() => addSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            <Plus className="size-4" />
            {t("storage.add")}
          </Button>
        )}
      </div>
      {(error || connections.error) && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error || connections.error?.message}
        </p>
      )}
      {scope === "team" && connections.data?.team?.error ? (
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
      {visibleConnections.length ? (
        <section className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t(scope === "team" ? "storage.shared_count" : "storage.connected", { count: visibleConnections.length })}
          </h4>
          <div className="divide-y divide-border rounded-2xl border border-border bg-background">
            {visibleConnections.map((connection) => {
              const Icon = storageIcons[connection.config.kind];
              return (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="grid size-11 place-items-center rounded-xl border border-border/60 bg-muted/40">
                    <Icon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{connection.name}</p>
                    {connection.team ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(
                          connection.teamInstallation === "optional"
                            ? "storage.team_optional"
                            : "storage.team_automatic",
                        )}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connection.config.kind === "oauth" ? providers.data?.providers.find((p) => connection.config.kind === "oauth" && p.id === connection.config.provider)?.name ?? connection.config.provider : storageLabel(connection.config.kind)} <span className="mx-1">·</span>{" "}
                      {connection.readOnly ? t("storage.read_only") : t("storage.read_write")}
                    </p>
                  </div>
                  {connection.config.kind === "oauth" && connection.enabled && connection.team?.installed !== false && (
                    <StorageOAuthSignIn client={client} workspaceId={workspaceId} connectionId={connection.id} onChanged={refresh} />
                  )}
                  {!connection.team && connections.data?.team?.canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await client.saveTeamStorageConnection(workspaceId, {
                            localId: connection.id,
                            teamInstallation: "optional",
                          });
                          refresh();
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : t("storage.failed"));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <Users className="size-3.5" />
                      {t("storage.make_team")}
                    </Button>
                  ) : null}
                  {connection.team && connection.teamInstallation === "optional" && (
                    <Button
                      variant={connection.team.installed ? "outline" : "default"}
                      size="sm"
                      disabled={busy || (!connection.enabled && !connection.team.installed)}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await client.setTeamStorageInstalled(workspaceId, connection.id, !connection.team?.installed);
                          refresh();
                        } catch (cause) {
                          setError(cause instanceof Error ? cause.message : t("storage.failed"));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {!connection.team.installed && <Download className="size-3.5" />}
                      {t(connection.team.installed ? "storage.remove_local" : "storage.install")}
                    </Button>
                  )}
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px]",
                      connection.enabled ? "bg-green-3 text-green-11" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {t(
                      !connection.enabled
                        ? "storage.paused"
                        : connection.team?.installed === false
                          ? "storage.available"
                          : "storage.enabled",
                    )}
                  </span>
                  {(!connection.team || (scope === "team" && connections.data?.team?.canManage)) && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("storage.edit_connection", { name: connection.name })}
                        onClick={() => setEditor({ kind: connection.config.kind, connection })}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("storage.remove_connection", { name: connection.name })}
                        onClick={() => setRemoving(connection)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : !connections.isLoading && !connections.error ? (
        <div className="rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">
          {t(scope === "team" ? "storage.team_empty" : "storage.local_empty")}
        </div>
      ) : null}
      {canAdd && (
        <section ref={addSection} className="scroll-mt-6 space-y-3">
          <div className="flex items-center gap-2">
            <Plus className="size-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">{t("storage.add")}</h4>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.data?.providers.map((provider) => (
              <button key={provider.id} type="button" onClick={() => setEditor({ kind: "oauth", provider })}
                className="group flex flex-col rounded-2xl border border-border bg-background p-5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ArrowUpRight className="mb-4 size-5 text-muted-foreground" />
                <span className="text-sm font-medium">{provider.name}</span>
                <span className="mt-1.5 text-xs leading-5 text-muted-foreground">{t("storage.oauth_description")}</span>
              </button>
            ))}
            {storageKinds.map((kind) => {
              const Icon = storageIcons[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setEditor({ kind })}
                  className="group flex flex-col rounded-2xl border border-border bg-background p-5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="mb-4 flex w-full items-center justify-between">
                    <Icon className="size-5 text-muted-foreground" />
                    <ArrowUpRight className="size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                  </div>
                  <span className="text-sm font-medium">{storageLabel(kind)}</span>
                  <span className="mt-1.5 text-xs leading-5 text-muted-foreground">{storageDescription(kind)}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {editor && (
        <StorageConnectionDialog
          client={client}
          workspaceId={workspaceId}
          kind={editor.kind}
          provider={editor.provider ?? providers.data?.providers.find((p) => editor.connection?.config.kind === "oauth" && editor.connection.config.provider === p.id)}
          connection={editor.connection}
          forTeam={Boolean(editor.connection?.team) || scope === "team"}
          onClose={() => setEditor(null)}
          onSaved={refresh}
        />
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(removing?.team ? "storage.remove_team_title" : "storage.remove_title")}</DialogTitle>
            <DialogDescription>
              {t(removing?.team ? "storage.remove_team_body" : "storage.remove_body", { name: removing?.name ?? "" })}
            </DialogDescription>
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
                  await client.removeStorageConnection(workspaceId, removing.id, removing.team?.version);
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

function StorageConnectionDialog({
  client,
  workspaceId,
  kind,
  provider,
  connection,
  forTeam,
  onClose,
  onSaved,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  kind: StorageKind;
  provider?: StorageOAuthProvider;
  connection?: StorageConnection;
  forTeam: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [automatic, setAutomatic] = useState(connection ? connection.teamInstallation !== "optional" : false);
  const [name, setName] = useState(connection?.name ?? provider?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    connection
      ? Object.fromEntries(Object.entries(connection.config).map(([key, value]) => [key, String(value)]))
      : kind === "oauth" ? { provider: provider?.id ?? "", root: "" } : storageDefaults(kind),
  );
  const [secrets, setSecrets] = useState<Partial<Record<StorageSecretKey, string>>>({});
  const [readOnly, setReadOnly] = useState(connection?.readOnly ?? false);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const Icon = storageIcons[kind];
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
      ...(forTeam ? { teamInstallation: automatic ? "automatic" : "optional" } : {}),
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
        if (forTeam && !connection) await client.saveTeamStorageConnection(workspaceId, input.data);
        else await client.saveStorageConnection(workspaceId, input.data, connection?.id, connection?.team?.version);
        onSaved();
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("storage.failed"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border p-6 pr-12">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("storage.tab")}</span>
            <ChevronRight className="size-3" />
            <span>{t(forTeam ? "firm_hub.scope_team" : "firm_hub.scope_local")}</span>
            <ChevronRight className="size-3" />
            <span>{storageLabel(kind)}</span>
          </div>
          <DialogTitle className="flex items-center gap-3 text-xl">
            <Icon className="size-5 text-muted-foreground" />
            {connection ? t("storage.edit_title") : t("storage.connect_provider", { provider: storageLabel(kind) })}
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
            <FieldDescription>{t("storage.name_help")}</FieldDescription>
          </Field>
          {kind === "oauth" && <Field>
            <FieldLabel htmlFor="storage-oauth-root">{t("storage.oauth_root")}</FieldLabel>
            <Input id="storage-oauth-root" value={values.root ?? ""} onChange={(event) => change("root", event.target.value)} placeholder={provider?.rootHint} />
            <FieldDescription>{provider?.rootHint ?? t("storage.oauth_root_hint")} {t("storage.oauth_edit_root")}</FieldDescription>
          </Field>}
          <div className="grid gap-4 sm:grid-cols-2">
            {storageFields(kind).map((field) => (
              <Field
                key={field.key}
                className={
                  field.key === "endpoint" || field.key === "rootPath" || field.key === "hostFingerprint"
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
          {forTeam ? (
            <label className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
              <span>
                <span className="block text-sm font-medium">{t("storage.automatic_label")}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("storage.automatic_help")}</span>
              </span>
              <Switch checked={automatic} onCheckedChange={setAutomatic} disabled={Boolean(busy)} />
            </label>
          ) : null}
          {forTeam ? <p className="text-xs text-muted-foreground">{t("storage.team_save_description")}</p> : null}
          <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4">
            <label className="flex items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">{t("storage.read_only")}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("storage.read_only_help")}</span>
              </span>
              <Switch checked={readOnly} onCheckedChange={setReadOnly} disabled={Boolean(busy)} />
            </label>
            <label className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <span>
                <span className="block text-sm font-medium">
                  {t(forTeam ? "storage.available_team" : "storage.show_drive")}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{t("storage.show_drive_help")}</span>
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} disabled={Boolean(busy)} />
            </label>
          </div>
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
        <DialogFooter className="mx-0 mb-0 shrink-0 flex-wrap border-t border-border bg-muted/20 p-4">
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => void submit(true)} className="sm:mr-auto">
            {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {t("storage.test")}
          </Button>
          <Button variant="ghost" disabled={Boolean(busy)} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="storage-connection-form" disabled={Boolean(busy)}>
            {busy === "save" && <Loader2 className="size-4 animate-spin" />}
            {forTeam ? t("storage.save_team") : connection ? t("storage.save_connection") : t("storage.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
