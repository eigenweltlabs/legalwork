/** @jsxImportSource react */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { RefreshCcw } from "lucide-react";

import { readDevLogs } from "../../../../app/lib/dev-log";
import { readPerfLogs } from "../../../../app/lib/perf-log";
import {
  buildLegalworkWorkspaceBaseUrl,
  parseLegalworkWorkspaceIdFromUrl,
  type LegalworkServerSettings,
  type LegalworkServerStatus,
} from "../../../../app/lib/legalwork-server";
import type { LegalworkServerInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import {
  ConfigDiagnosticsSection,
  ConfigEngineReloadSection,
  ConfigServerConnectionSection,
  ConfigWorkspaceSummary,
} from "./config-view-sections";
import { configLocalReducer, initialConfigLocalState } from "./config-view-state";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  legalworkServerStatus: LegalworkServerStatus;
  legalworkServerUrl: string;
  legalworkServerSettings: LegalworkServerSettings;
  legalworkServerHostInfo: LegalworkServerInfo | null;
  runtimeWorkspaceId: string | null;

  updateLegalworkServerSettings: (next: LegalworkServerSettings) => void;
  resetLegalworkServerSettings: () => void;
  testLegalworkServerConnection: (
    next: LegalworkServerSettings,
  ) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;

  developerMode: boolean;
};

function buildDiagnosticsBundleJson(input: {
  anyActiveRuns: boolean;
  canReloadWorkspace: boolean;
  clientConnected: boolean;
  developerMode: boolean;
  hostInfo: LegalworkServerInfo | null;
  legalworkServerSettings: LegalworkServerSettings;
  legalworkServerStatus: LegalworkServerStatus;
  legalworkServerUrl: string;
  runtimeWorkspaceId: string | null;
}) {
  const urlOverride = input.legalworkServerSettings.urlOverride?.trim() ?? "";
  const token = input.legalworkServerSettings.token?.trim() ?? "";
  const developerLogs = input.developerMode ? readDevLogs(80) : [];
  const perfLogs = input.developerMode ? readPerfLogs(80) : [];
  const bundle = {
    capturedAt: new Date().toISOString(),
    runtime: {
      tauri: isDesktopRuntime(),
      developerMode: input.developerMode,
    },
    workspace: {
      runtimeWorkspaceId: input.runtimeWorkspaceId ?? null,
      clientConnected: input.clientConnected,
      anyActiveRuns: input.anyActiveRuns,
    },
    legalworkServer: {
      status: input.legalworkServerStatus,
      url: input.legalworkServerUrl,
      settings: {
        urlOverride: urlOverride || null,
        tokenPresent: Boolean(token),
      },
      host: input.hostInfo
        ? {
            running: Boolean(input.hostInfo.running),
            remoteAccessEnabled: input.hostInfo.remoteAccessEnabled,
            baseUrl: input.hostInfo.baseUrl ?? null,
            connectUrl: input.hostInfo.connectUrl ?? null,
            mdnsUrl: input.hostInfo.mdnsUrl ?? null,
            lanUrl: input.hostInfo.lanUrl ?? null,
          }
        : null,
    },
    reload: {
      canReloadWorkspace: input.canReloadWorkspace,
    },
    performance: {
      retainedEntries: perfLogs.length,
      recent: perfLogs,
    },
    developerLogs: {
      retainedEntries: developerLogs.length,
      recent: developerLogs,
    },
  };
  return JSON.stringify(bundle, null, 2);
}

export function ConfigView(props: ConfigViewProps) {
  const [localState, dispatchLocal] = useReducer(
    configLocalReducer,
    initialConfigLocalState,
  );
  const { legalworkConnection, tokenVisible, copyingField } = localState;
  const legalworkUrl = legalworkConnection.url;
  const legalworkToken = legalworkConnection.token;
  const legalworkTestState = legalworkConnection.testState;
  const legalworkTestMessage = legalworkConnection.testMessage;
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    dispatchLocal({
      type: "serverSettings",
      connection: {
        url: props.legalworkServerSettings.urlOverride ?? "",
        token: props.legalworkServerSettings.token ?? "",
        testState: "idle",
        testMessage: null,
      },
    });
  }, [props.legalworkServerSettings]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const legalworkStatusLabel = (() => {
    switch (props.legalworkServerStatus) {
      case "connected":
        return t("config.status_connected");
      case "limited":
        return t("config.status_limited");
      default:
        return t("config.status_not_connected");
    }
  })();

  const legalworkStatusStyle = (() => {
    switch (props.legalworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  })();

  const reloadAvailabilityReason = (() => {
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) return t("config.reload_availability_hint");
    return null;
  })();

  const reloadButtonLabel = props.reloadBusy
    ? t("config.reloading")
    : t("config.reload_engine");
  const reloadButtonTone: "destructive" | "secondary" = props.anyActiveRuns
    ? "destructive"
    : "secondary";
  const reloadButtonDisabled =
    props.reloadBusy || Boolean(reloadAvailabilityReason);

  const buildLegalworkSettings = (): LegalworkServerSettings => ({
    ...props.legalworkServerSettings,
    urlOverride: legalworkUrl.trim() || undefined,
    token: legalworkToken.trim() || undefined,
  });

  const hasLegalworkChanges = (() => {
    const currentUrl = props.legalworkServerSettings.urlOverride ?? "";
    const currentToken = props.legalworkServerSettings.token ?? "";
    return (
      legalworkUrl.trim() !== currentUrl || legalworkToken.trim() !== currentToken
    );
  })();

  const resolvedWorkspaceId = (() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseLegalworkWorkspaceIdFromUrl(legalworkUrl) ?? "";
  })();

  const resolvedWorkspaceUrl = (() => {
    const baseUrl = legalworkUrl.trim();
    if (!baseUrl) return "";
    return buildLegalworkWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId) ?? baseUrl;
  })();

  const hostInfo = props.legalworkServerHostInfo;
  const diagnosticsBundleJson = useMemo(() => {
    return buildDiagnosticsBundleJson({
      anyActiveRuns: props.anyActiveRuns,
      canReloadWorkspace: props.canReloadWorkspace,
      clientConnected: props.clientConnected,
      developerMode: props.developerMode,
      hostInfo,
      legalworkServerSettings: props.legalworkServerSettings,
      legalworkServerStatus: props.legalworkServerStatus,
      legalworkServerUrl: props.legalworkServerUrl,
      runtimeWorkspaceId: props.runtimeWorkspaceId,
    });
  }, [
    hostInfo,
    props.anyActiveRuns,
    props.canReloadWorkspace,
    props.clientConnected,
    props.developerMode,
    props.legalworkServerSettings.token,
    props.legalworkServerSettings.urlOverride,
    props.legalworkServerStatus,
    props.legalworkServerUrl,
    props.runtimeWorkspaceId,
  ]);

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      dispatchLocal({ type: "copyingField", field });
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        dispatchLocal({ type: "copyingField", field: null });
        copyTimeoutRef.current = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleTestConnection = async () => {
    if (legalworkTestState === "testing") return;
    const next = buildLegalworkSettings();
    props.updateLegalworkServerSettings(next);
    dispatchLocal({
      type: "testState",
      testState: "testing",
      testMessage: null,
    });
    try {
      const ok = await props.testLegalworkServerConnection(next);
      dispatchLocal({
        type: "testState",
        testState: ok ? "success" : "error",
        testMessage: ok
          ? t("config.connection_successful")
          : t("config.connection_failed"),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("config.connection_failed_check");
      dispatchLocal({
        type: "testState",
        testState: "error",
        testMessage: message,
      });
    }
  };

  return (
    <section className="space-y-6 max-w-3xl w-full">
      <ConfigWorkspaceSummary runtimeWorkspaceId={props.runtimeWorkspaceId} />
      <ConfigEngineReloadSection
        anyActiveRuns={props.anyActiveRuns}
        reloadBusy={props.reloadBusy}
        reloadAvailabilityReason={reloadAvailabilityReason}
        reloadButtonTone={reloadButtonTone}
        reloadButtonDisabled={reloadButtonDisabled}
        reloadButtonLabel={reloadButtonLabel}
        onReload={props.reloadWorkspaceEngine}
      />
      {props.developerMode ? (
        <ConfigDiagnosticsSection
          busy={props.busy}
          diagnosticsBundleJson={diagnosticsBundleJson}
          copyingField={copyingField}
          onCopy={handleCopy}
        />
      ) : null}
      <ConfigServerConnectionSection
        busy={props.busy}
        legalworkUrl={legalworkUrl}
        legalworkToken={legalworkToken}
        tokenVisible={tokenVisible.legalwork}
        legalworkStatusLabel={legalworkStatusLabel}
        legalworkStatusStyle={legalworkStatusStyle}
        resolvedWorkspaceUrl={resolvedWorkspaceUrl}
        resolvedWorkspaceId={resolvedWorkspaceId}
        legalworkTestState={legalworkTestState}
        legalworkTestMessage={legalworkTestMessage}
        hasLegalworkChanges={hasLegalworkChanges}
        onUrlChange={(url) => dispatchLocal({ type: "url", url })}
        onTokenChange={(token) => dispatchLocal({ type: "token", token })}
        onToggleToken={() => dispatchLocal({ type: "toggleToken", key: "legalwork" })}
        onTestConnection={handleTestConnection}
        onSave={() => props.updateLegalworkServerSettings(buildLegalworkSettings())}
        onReset={props.resetLegalworkServerSettings}
      />
      {!isDesktopRuntime() ? <div className="text-xs text-gray-9">{t("config.desktop_only_hint")}</div> : null}
    </section>
  );
}
