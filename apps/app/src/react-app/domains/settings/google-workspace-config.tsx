/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { CalendarDays, CheckCircle2, FileText, Loader2, ShieldCheck, XCircle } from "lucide-react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { GoogleWorkspaceAuthStatus, LegalworkServerClient } from "../../../app/lib/legalwork-server";
import { usePlatform } from "../../kernel/platform";
import type { ExtensionConfigContext } from "./extension-registry";
import { registerExtensionRuntime } from "./extension-registry";
import { t } from "@/i18n";

type BusyAction = "status" | "connect" | "disconnect" | "set-active" | "test" | "smoke-test" | "save-secret";
type OptionalFeature = "driveFull" | "calendarWrite" | "chat";

const OPTIONAL_FEATURES: { id: OptionalFeature; labelKey: string; descriptionKey: string }[] = [
  { id: "driveFull", labelKey: "google_workspace.feature_drive_full", descriptionKey: "google_workspace.feature_drive_full_desc" },
  { id: "calendarWrite", labelKey: "google_workspace.feature_calendar_write", descriptionKey: "google_workspace.feature_calendar_write_desc" },
  { id: "chat", labelKey: "google_workspace.feature_chat", descriptionKey: "google_workspace.feature_chat_desc" },
];
type GoogleWorkspaceCommand = () => Promise<unknown>;
const DESKTOP_ACTION_TIMEOUT_MS = 6 * 60 * 1000;
const CONNECT_POLL_INTERVAL_MS = 1_000;
// Must match GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID in apps/server/src/extensions/google-workspace.ts.
const LEGALWORK_BUILTIN_GOOGLE_CLIENT_ID = "584062143741-6g2a465c5beuhdtemsc5avabs6i732q9.apps.googleusercontent.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeGoogleWorkspaceAccount(value: unknown): GoogleWorkspaceAuthStatus["account"] {
  if (!isRecord(value)) return null;
  return {
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    email: typeof value.email === "string" ? value.email : null,
    name: typeof value.name === "string" ? value.name : null,
    picture: typeof value.picture === "string" ? value.picture : null,
    sub: typeof value.sub === "string" ? value.sub : null,
    scopes: normalizeStringList(value.scopes),
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
  };
}

function normalizeGoogleWorkspaceAccounts(value: unknown): GoogleWorkspaceAuthStatus["accounts"] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeGoogleWorkspaceAccount).filter((item): item is NonNullable<GoogleWorkspaceAuthStatus["account"]> => item !== null);
}

function normalizeGoogleWorkspaceSmokeTest(value: unknown): GoogleWorkspaceAuthStatus["smokeTest"] {
  if (!isRecord(value)) return null;
  return {
    driveFileId: typeof value.driveFileId === "string" ? value.driveFileId : null,
    driveFileName: typeof value.driveFileName === "string" ? value.driveFileName : null,
    gmailDraftId: typeof value.gmailDraftId === "string" ? value.gmailDraftId : null,
  };
}

function normalizeGoogleWorkspaceAuthStatus(value: unknown): GoogleWorkspaceAuthStatus {
  const record = isRecord(value) ? value : {};
  const vault = record.vault === "encrypted" || record.vault === "plaintext-dev" ? record.vault : "unavailable";
  return {
    configured: record.configured === true,
    missing: normalizeStringList(record.missing),
    customClient: record.customClient === true,
    vault,
    connected: record.connected === true,
    account: normalizeGoogleWorkspaceAccount(record.account),
    accounts: normalizeGoogleWorkspaceAccounts(record.accounts),
    activeAccountId: typeof record.activeAccountId === "string" ? record.activeAccountId : null,
    scopes: normalizeStringList(record.scopes),
    connectedAt: typeof record.connectedAt === "string" ? record.connectedAt : null,
    error: typeof record.error === "string" ? record.error : null,
    testStatus: typeof record.testStatus === "string" ? record.testStatus : null,
    smokeTest: normalizeGoogleWorkspaceSmokeTest(record.smokeTest),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForGoogleWorkspaceConnection(client: LegalworkServerClient, flowId: string, expiresAt: number) {
  while (Date.now() < expiresAt + 5_000) {
    const result = await client.googleWorkspaceConnectStatus(flowId);
    if (result.status === "connected" && result.googleWorkspace) return result.googleWorkspace;
    if (result.status === "failed" || result.status === "expired") {
      throw new Error(result.error ?? t("google.connection_incomplete"));
    }
    await sleep(CONNECT_POLL_INTERVAL_MS);
  }
  throw new Error(t("google_workspace.oauth_timed_out"));
}

function GoogleWorkspaceConfig({ legalworkServerClient, hostLegalworkServerClient, onExtensionConnectionChange, restartLocalServer }: ExtensionConfigContext) {
  const platform = usePlatform();
  const [status, setStatus] = useState<GoogleWorkspaceAuthStatus | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [customClientId, setCustomClientId] = useState("");
  const [customClientSecret, setCustomClientSecret] = useState("");
  const [optionalFeatures, setOptionalFeatures] = useState<Record<OptionalFeature, boolean>>({ driveFull: false, calendarWrite: false, chat: false });
  const serverAvailable = Boolean(legalworkServerClient);
  const hostServerAvailable = Boolean(hostLegalworkServerClient);
  const canConnect = serverAvailable && status?.configured === true && status.vault !== "unavailable";
  const canTest = serverAvailable && status?.connected === true;

  const loadStatus = async (options: { clearError?: boolean } = {}) => {
    if (!legalworkServerClient) return;
    setBusyAction("status");
    if (options.clearError !== false) setError(null);
    try {
      const result = normalizeGoogleWorkspaceAuthStatus(await legalworkServerClient.googleWorkspaceStatus());
      setStatus(result);
      onExtensionConnectionChange?.("google-workspace", result.connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("google_workspace.status_read_failed"));
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [legalworkServerClient]);

  const runDesktopAction = async (action: Exclude<BusyAction, "status">, command: GoogleWorkspaceCommand) => {
    if (!legalworkServerClient) return;
    setBusyAction(action);
    setError(null);
    try {
      const result = await Promise.race([
        command(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error(t("google_workspace.connect_slow"))), DESKTOP_ACTION_TIMEOUT_MS);
        }),
      ]);
      const next = normalizeGoogleWorkspaceAuthStatus(result);
      setStatus(next);
      onExtensionConnectionChange?.("google-workspace", next.connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("google_workspace.action_failed", { action }));
      await loadStatus({ clearError: false });
    } finally {
      setBusyAction(null);
    }
  };

  const connectGoogleWorkspace = async () => {
    if (!legalworkServerClient) return null;
    const features = status?.customClient === true ? OPTIONAL_FEATURES.filter((feature) => optionalFeatures[feature.id]).map((feature) => feature.id) : [];
    const flow = await legalworkServerClient.googleWorkspaceConnectStart({ features });
    platform.openLink(flow.authUrl);
    return waitForGoogleWorkspaceConnection(legalworkServerClient, flow.flowId, flow.expiresAt);
  };

  const saveOauthEnv = async (entries: { key: string; value: string }[], onSaved: () => void) => {
    if (!hostLegalworkServerClient) {
      setError(t("google_workspace.desktop_only_save"));
      return;
    }
    setBusyAction("save-secret");
    setError(null);
    try {
      await hostLegalworkServerClient.upsertUserEnv(entries);
      await hostLegalworkServerClient.setUserEnvPendingChanges(true);
      onSaved();
      if (restartLocalServer) {
        const restarted = await restartLocalServer();
        if (!restarted) setError(t("google_workspace.oauth_saved"));
      } else {
        setError(t("google_workspace.oauth_saved"));
      }
      await loadStatus({ clearError: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("google_workspace.oauth_save_failed"));
    } finally {
      setBusyAction(null);
    }
  };

  const saveGoogleClientSecret = async () => {
    const value = clientSecret.trim();
    if (!value) {
      setError(t("google_workspace.enter_secret"));
      return;
    }
    await saveOauthEnv([{ key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", value }], () => setClientSecret(""));
  };

  const saveCustomOauthClient = async () => {
    const id = customClientId.trim();
    const secret = customClientSecret.trim();
    if (!id || !secret) {
      setError(t("google_workspace.enter_id_and_secret"));
      return;
    }
    if (id === LEGALWORK_BUILTIN_GOOGLE_CLIENT_ID) {
      setError("That is the built-in LegalWork client ID, which cannot unlock extra permissions. Create your own OAuth client in Google Cloud Console (APIs & Services > Credentials > Create OAuth client ID > Desktop app) and paste its client ID here.");
      return;
    }
    await saveOauthEnv(
      [
        { key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", value: id },
        { key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", value: secret },
      ],
      () => {
        setCustomClientId("");
        setCustomClientSecret("");
      },
    );
  };

  const connectedAccounts = status?.accounts.length ? status.accounts : status?.account ? [status.account] : [];

  return (
    <div className="space-y-4">
      {!serverAvailable ? (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>{t("google_workspace.server_required_title")}</AlertTitle>
          <AlertDescription>{t("google_workspace.server_required_body")}</AlertDescription>
        </Alert>
      ) : null}

      {status?.connected ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>{t("google_workspace.connected_title")}</AlertTitle>
          <AlertDescription>
            {connectedAccounts.length === 1 && connectedAccounts[0]?.email
              ? t("google_workspace.signed_in_as", { email: connectedAccounts[0].email })
              : t("google_workspace.accounts_connected", { count: connectedAccounts.length })}
            {status.testStatus ? ` ${status.testStatus}` : ""}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>{t("google.connect_workspace")}</AlertTitle>
          <AlertDescription>
            {t("google_workspace.readonly_intro")}
          </AlertDescription>
        </Alert>
      )}

      {status && !status.configured ? (
        <Alert variant="warning">
          <XCircle />
          <AlertTitle>{t("google_workspace.not_configured_title")}</AlertTitle>
          <AlertDescription>{t("google_workspace.not_configured_body")}</AlertDescription>
        </Alert>
      ) : null}

      {status && !status.configured ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>{t("google_workspace.setup_title")}</CardTitle>
            <CardDescription>
              {t("google_workspace.oauth_setup_hint")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder={t("google_workspace.secret_placeholder")}
              autoComplete="off"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("google_workspace.secret_saved_locally")}
            </p>
          </CardContent>
          <CardFooter>
            <Button disabled={busyAction === "save-secret" || !clientSecret.trim() || !hostServerAvailable} onClick={() => void saveGoogleClientSecret()}>
              {busyAction === "save-secret" ? <Loader2 className="size-4 animate-spin" /> : null}
              Save and apply
            </Button>
          </CardFooter>
        </Card>
      ) : null}

      {status?.vault === "unavailable" ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{t("google_workspace.vault_unavailable_title")}</AlertTitle>
          <AlertDescription>{t("google_workspace.vault_unavailable_body")}</AlertDescription>
        </Alert>
      ) : null}

      {error || status?.error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{t("google_workspace.error_title")}</AlertTitle>
          <AlertDescription>{error ?? status?.error}</AlertDescription>
        </Alert>
      ) : null}

      {status?.smokeTest ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>{t("google_workspace.smoke_test_title")}</AlertTitle>
          <AlertDescription>{t("google_workspace.smoke_test_body")}</AlertDescription>
        </Alert>
      ) : null}

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>{t("google_workspace.capabilities_title")}</CardTitle>
          <CardDescription>{t("google_workspace.capabilities_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-3">
            <CalendarDays className="mb-2 size-4 text-blue-11" />
            <div className="text-sm font-medium text-card-foreground">{t("google_workspace.calendar_read")}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("google_workspace.calendar_read_desc")}</div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3">
            <FileText className="mb-2 size-4 text-green-11" />
            <div className="text-sm font-medium text-card-foreground">{t("google_workspace.drive_read")}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("google_workspace.drive_read_desc")}</div>
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        {connectedAccounts.length > 0 ? (
          <CardContent className="space-y-2 pt-6">
            {connectedAccounts.map((account) => (
              <div key={account.accountId ?? account.email ?? account.sub ?? "google-account"} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-card-foreground">{account.email ?? account.name ?? t("google.account")}</div>
                  <div className="text-xs text-muted-foreground">{account.accountId === status?.activeAccountId ? t("google.default_for_actions") : "Connected"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {account.accountId && account.accountId !== status?.activeAccountId ? (
                    <Button variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => {
                      const accountId = account.accountId;
                      if (!accountId) return;
                      void runDesktopAction("set-active", () => legalworkServerClient?.googleWorkspaceSetActiveAccount(accountId) ?? Promise.resolve(null));
                    }}>
                      {busyAction === "set-active" ? <Loader2 className="size-4 animate-spin" /> : null}
                      Make default
                    </Button>
                  ) : null}
                  <Button variant="destructive" size="sm" disabled={Boolean(busyAction)} onClick={() => void runDesktopAction("disconnect", () => legalworkServerClient?.googleWorkspaceDisconnect(account.accountId) ?? Promise.resolve(null))}>
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        ) : null}
        <CardFooter className="flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            <Button disabled={Boolean(busyAction) || !canConnect} onClick={() => void runDesktopAction("connect", connectGoogleWorkspace)}>
              {busyAction === "connect" ? <Loader2 className="size-4 animate-spin" /> : null}
              {status?.connected ? t("google.add_another_account") : t("google.connect_with_google")}
            </Button>
            {connectedAccounts.length > 1 ? (
              <Button variant="destructive" disabled={Boolean(busyAction)} onClick={() => void runDesktopAction("disconnect", () => legalworkServerClient?.googleWorkspaceDisconnect() ?? Promise.resolve(null))}>
                {busyAction === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Disconnect all
              </Button>
            ) : null}
            <Button variant="outline" disabled={Boolean(busyAction) || !canTest} onClick={() => void runDesktopAction("test", () => legalworkServerClient?.googleWorkspaceTestConnection() ?? Promise.resolve(null))}>
              {busyAction === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Test connection
            </Button>
            <Button variant="outline" disabled={Boolean(busyAction) || !canTest} onClick={() => void runDesktopAction("smoke-test", () => legalworkServerClient?.googleWorkspaceRunScopeSmokeTest() ?? Promise.resolve(null))}>
              {busyAction === "smoke-test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Run diagnostic
            </Button>
          </div>
        </CardFooter>
      </Card>

      <Accordion>
        <AccordionItem value="advanced">
          <AccordionTrigger>{t("google_workspace.advanced")}</AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("google_workspace.advanced_desc")}
            </p>
            {status?.customClient ? (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>{t("google_workspace.custom_client_title")}</AlertTitle>
                <AlertDescription>{t("google_workspace.custom_client_body")}</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                <Input
                  value={customClientId}
                  onChange={(event) => setCustomClientId(event.target.value)}
                  placeholder={t("google_workspace.custom_client_id_placeholder")}
                  autoComplete="off"
                />
                <Input
                  type="password"
                  value={customClientSecret}
                  onChange={(event) => setCustomClientSecret(event.target.value)}
                  placeholder={t("google_workspace.custom_client_secret_placeholder")}
                  autoComplete="off"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("google_workspace.custom_client_hint")}
                </p>
                <Button disabled={busyAction === "save-secret" || !customClientId.trim() || !customClientSecret.trim() || !hostServerAvailable} onClick={() => void saveCustomOauthClient()}>
                  {busyAction === "save-secret" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save and apply
                </Button>
              </div>
            )}
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {status?.customClient
                  ? t("google.scopes_hint")
                  : t("google.own_client_hint")}
              </p>
              {OPTIONAL_FEATURES.map((feature) => (
                <label key={feature.id} className="flex items-start gap-2.5">
                  <Checkbox
                    checked={optionalFeatures[feature.id]}
                    onCheckedChange={(checked) => setOptionalFeatures((current) => ({ ...current, [feature.id]: checked === true }))}
                    disabled={Boolean(busyAction) || status?.customClient !== true}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-card-foreground">{t(feature.labelKey)}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{t(feature.descriptionKey)}</span>
                  </span>
                </label>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

registerExtensionRuntime({
  id: "google-workspace",
  settingsPanelRefs: ["legalwork.googleWorkspace.settings"],
  settingsPanel: (ctx) => <GoogleWorkspaceConfig {...ctx} />,
  isConnected: (_entry, ctx) => ctx.extensionConnections?.["google-workspace"] === true,
});
