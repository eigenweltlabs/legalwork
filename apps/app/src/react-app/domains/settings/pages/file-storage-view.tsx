/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  storageInputSchema,
  type StorageConnection,
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

export function FileStorageView({
  client,
  workspaceId,
}: {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ kind: StorageKind; connection?: StorageConnection } | null>(null);
  const [removing, setRemoving] = useState<StorageConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addSection = useRef<HTMLElement>(null);
  const connections = useQuery({
    queryKey: ["storage-connections", workspaceId],
    queryFn: () => client!.storageConnections(workspaceId!),
    enabled: Boolean(client && workspaceId),
    retry: false,
  });
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
  }, [client, workspaceId]);
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
          <p className="text-sm leading-6 text-muted-foreground">{t("storage.intro")}</p>
        </div>
        <Button onClick={() => addSection.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
          <Plus className="size-4" />
          {t("storage.add")}
        </Button>
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
      {connections.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("storage.loading")}
        </div>
      ) : null}
      {connections.data?.connections.length ? (
        <section className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("storage.connected", { count: connections.data.connections.length })}
          </h4>
          <div className="divide-y divide-border rounded-2xl border border-border bg-background">
            {connections.data.connections.map((connection) => {
              const Icon = storageIcons[connection.config.kind];
              return (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="grid size-11 place-items-center rounded-xl border border-border/60 bg-muted/40">
                    <Icon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{connection.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {storageLabel(connection.config.kind)} <span className="mx-1">·</span>{" "}
                      {connection.readOnly ? t("storage.read_only") : t("storage.read_write")}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px]",
                      connection.enabled ? "bg-green-3 text-green-11" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {connection.enabled ? t("storage.enabled") : t("storage.paused")}
                  </span>
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
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      <section ref={addSection} className="scroll-mt-6 space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-medium">{t("storage.add")}</h4>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
      {editor && (
        <StorageConnectionDialog
          client={client}
          workspaceId={workspaceId}
          kind={editor.kind}
          connection={editor.connection}
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

function StorageConnectionDialog({
  client,
  workspaceId,
  kind,
  connection,
  onClose,
  onSaved,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  kind: StorageKind;
  connection?: StorageConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() =>
    connection
      ? Object.fromEntries(Object.entries(connection.config).map(([key, value]) => [key, String(value)]))
      : storageDefaults(kind),
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
    if (kind === "sftp" || kind === "ftp") config.port = Number(values.port);
    if (kind === "s3") config.forcePathStyle = values.forcePathStyle === "true";
    const input = storageInputSchema.safeParse({
      name: testing && !name.trim() ? storageLabel(kind) : name,
      config,
      secrets,
      readOnly,
      enabled,
    });
    if (!input.success) {
      setError(t("storage.check_fields") + " " + input.error.issues.map((issue) => issue.path.join(".")).join(", "));
      return;
    }
    setBusy(testing ? "test" : "save");
    try {
      if (testing) {
        await client.testStorageConnection(workspaceId, input.data, connection?.id);
        setTested(true);
      } else {
        await client.saveStorageConnection(workspaceId, input.data, connection?.id);
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
            <label className="flex items-center justify-between gap-4 border-t border-border pt-4">
              <span>
                <span className="block text-sm font-medium">{t("storage.show_drive")}</span>
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
            {connection ? t("storage.save_connection") : t("storage.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
