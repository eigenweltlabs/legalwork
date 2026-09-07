/** @jsxImportSource react */
import { useCallback } from "react";

import type { McpDirectoryInfo } from "../../../app/constants";
import { evaluateEnablement, type EnablementContext } from "../../../app/enablement";
import type { LegalworkServerClient } from "../../../app/lib/legalwork-server";
import type { McpServerEntry } from "../../../app/types";
import { getExtensionConfigSlot, getExtensionConnected, type ExtensionConfigContext } from "./extension-registry";
import type { LocalProviderInstallInput } from "./openai-image-extension";

type ProviderLike = {
  id: string;
  source?: string | null;
};

type SettingsExtensionControllerInput = {
  legalworkServerClient: LegalworkServerClient | null;
  hostLegalworkServerClient: LegalworkServerClient | null;
  enablementContext: EnablementContext;
  mcpServers: McpServerEntry[];
  mcpConnectingName: string | null;
  onComputerUsePermissionsChange: (permissions: { accessibility: boolean; screenRecording: boolean }) => void;
  googleWorkspaceConnected: boolean;
  setGoogleWorkspaceConnected: (connected: boolean) => void;
  restartLocalServer?: () => Promise<boolean>;
  connectMcp: (entry: McpDirectoryInfo) => void | Promise<void>;
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
  const configContextForEntry = useCallback((entry: McpDirectoryInfo): ExtensionConfigContext => ({
    legalworkServerClient: input.legalworkServerClient,
    hostLegalworkServerClient: input.hostLegalworkServerClient,
    restartLocalServer: input.restartLocalServer,
    extensionConnections: {
      "google-workspace": input.googleWorkspaceConnected,
    },
    onExtensionConnectionChange: (extensionId, connected) => {
      if (extensionId === "google-workspace") input.setGoogleWorkspaceConnected(connected);
    },
    computerUse: {
      connected: input.mcpServers.some((server) => server.name === "computer-use"),
      connecting: input.mcpConnectingName === entry.name,
      onConnect: () => input.connectMcp(entry),
      onRefresh: input.refreshMcpServers,
      onPermissionsChange: input.onComputerUsePermissionsChange,
    },
    imageExtension: {
      ...input.imageExtension,
      envKeyDetected: hasOpenAiEnv(input),
    },
    localProvider: input.localProvider,
  }), [input]);

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
        "google-workspace": input.googleWorkspaceConnected,
      },
    });
    return runtimeConnected ?? false;
  }, [input]);

  return {
    configContextForEntry,
    configSlotForEntry,
    isConnected,
  };
}
