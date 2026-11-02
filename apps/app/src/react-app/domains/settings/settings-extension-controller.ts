/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { connectorIsConnected } from "@legalwork/types/connectors";

import type { McpDirectoryInfo } from "../../../app/constants";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { LegalworkServerClient } from "../../../app/lib/legalwork-server";
import type { McpServerEntry } from "../../../app/types";
import { getExtensionConfigSlot, getExtensionConnected, type ExtensionConfigContext } from "./extension-registry";
import type { LocalProviderInstallInput } from "./openai-image-extension";
import { connectorStatusQuery } from "./connector-status-query";

type ProviderLike = {
  id: string;
  source?: string | null;
};

type SettingsExtensionControllerInput = {
  isRemoteWorkspace: boolean;
  legalworkServerClient: LegalworkServerClient | null;
  hostLegalworkServerClient: LegalworkServerClient | null;
  enablementContext: EnablementContext;
  mcpServers: McpServerEntry[];
  mcpConnectingName: string | null;
  googleWorkspaceConnected: boolean;
  setGoogleWorkspaceConnected: (connected: boolean) => void;
  restartLocalServer?: () => Promise<boolean>;
  connectMcp: (entry: McpDirectoryInfo) => Promise<boolean>;
  removeMcp: (name: string) => void | Promise<void | false>;
  refreshMcpServers: () => void | Promise<void>;
  providers: ProviderLike[];
  providerConnectedIds: string[];
  userEnvKeys: string[];
  imageExtension: {
    busy: boolean;
    status: string | null;
    error: string | null;
    onInstall: (apiKey: string) => void | Promise<void>;
    onTestGenerate: (input: { apiKey: string; prompt: string }) => void | Promise<void>;
  };
  localProvider: {
    busy: boolean;
    status: string | null;
    error: string | null;
    onInstall: (input: LocalProviderInstallInput) => void | Promise<void>;
  };
};

function hasOpenAiEnv(input: Pick<SettingsExtensionControllerInput, "providers" | "providerConnectedIds" | "userEnvKeys">) {
  return input.userEnvKeys.includes("OPENAI_API_KEY") ||
    input.userEnvKeys.includes("LEGALWORK_OPENAI_IMAGE_API_KEY") ||
    input.providers.some((provider) => provider.id === "openai" && provider.source === "env") ||
    input.providerConnectedIds.includes("openai");
}

export function useSettingsExtensionController(input: SettingsExtensionControllerInput) {
  const [connectorConnections, setConnectorConnections] = useState<Record<string, boolean>>({});
  const savedStatus = useQuery(connectorStatusQuery(input.legalworkServerClient));
  useEffect(() => {
    setConnectorConnections(Object.fromEntries((savedStatus.data?.connectors ?? []).map(connector => [connector.id, connectorIsConnected(connector)])));
  }, [savedStatus.data]);
  const configContextForEntry = useCallback((entry: McpDirectoryInfo): ExtensionConfigContext => ({
    legalworkServerClient: input.legalworkServerClient,
    hostLegalworkServerClient: input.hostLegalworkServerClient,
    restartLocalServer: input.restartLocalServer,
    extensionConnections: {
      ...connectorConnections,
      "google-workspace": input.googleWorkspaceConnected,
    },
    onExtensionConnectionChange: (extensionId, connected) => {
      if (extensionId === "google-workspace") input.setGoogleWorkspaceConnected(connected);
      else setConnectorConnections((previous) => previous[extensionId] === connected ? previous : { ...previous, [extensionId]: connected });
    },
    actaport: {
      connected: input.mcpServers.some((server) => server.name === "actaport" && server.config.enabled !== false),
      onConnect: () => input.connectMcp(entry),
      onDisconnect: async () => { await input.removeMcp("actaport"); },
      onRefresh: input.refreshMcpServers,
    },
    imageExtension: {
      ...input.imageExtension,
      envKeyDetected: hasOpenAiEnv(input),
    },
    openComputerUse: {
      localDesktop: !input.isRemoteWorkspace,
      connected: input.enablementContext.mcpStatuses?.["open-computer-use"]?.status === "connected",
      connecting: input.mcpConnectingName === entry.name,
      onConnect: () => input.connectMcp(entry),
      onRefresh: input.refreshMcpServers,
    },
    localProvider: input.localProvider,
  }), [input, connectorConnections]);

  const configSlotForEntry = useCallback(
    (entry: McpDirectoryInfo) => getExtensionConfigSlot(entry, configContextForEntry(entry)),
    [configContextForEntry],
  );

  const isConnected = useCallback((entry: McpDirectoryInfo) => {
    if (entry.extensionManifest?.enablement) {
      return evaluateEnablement(entry.extensionManifest.enablement, input.enablementContext).active;
    }
    const runtimeConnected = getExtensionConnected(entry, {
      legalworkServerClient: input.legalworkServerClient,
      extensionConnections: {
        ...connectorConnections,
        "google-workspace": input.googleWorkspaceConnected,
      },
    });
    return runtimeConnected ?? false;
  }, [input, connectorConnections]);

  return {
    configContextForEntry,
    configSlotForEntry,
    isConnected,
    refreshConnections: savedStatus.refetch,
    connectionError: savedStatus.error?.message ?? null,
  };
}
