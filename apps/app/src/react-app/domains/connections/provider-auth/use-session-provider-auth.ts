// Session-route wiring for the provider-auth store: a stable store instance
// fed by a latest-values ref, lifecycle (start/dispose), Zen-restriction sync,
// workspace-change resync, the post-onboarding auto-open latch, and cloud
// provider auto-sync. Extracted verbatim from session-route.tsx.
import { useEffect, useMemo, useRef } from "react";

import type { Client, ProviderListItem, WorkspaceDisplay } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { useReloadCoordinator } from "@/react-app/shell/reload-coordinator";
import { type RouteWorkspace, workspaceLabel } from "@/react-app/shell/route-workspaces";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "./store";

const emptyWorkspaceDisplay: WorkspaceDisplay = {
  id: "",
  name: "",
  path: "",
  preset: "default",
  workspaceType: "local",
};

export type UseSessionProviderAuthInput = {
  opencodeClient: Client | null;
  providers: ProviderListItem[];
  providerDefaults: Record<string, string>;
  providerConnectedIds: string[];
  disabledProviderIds: string[];
  selectedWorkspace: RouteWorkspace | null | undefined;
  selectedWorkspaceEndpoint: ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceRoot: string;
  selectedWorkspaceId: string;
  setProviders: (value: ProviderListItem[]) => void;
  setProviderDefaults: (value: Record<string, string>) => void;
  setProviderConnectedIds: (value: string[]) => void;
  setDisabledProviderIds: (value: string[]) => void;
  /**
   * While the onboarding "Your AI" cover is up: fires when the provider modal
   * closes AND a provider actually connected while it was open — the caller
   * advances the (persisted) onboarding stage.
   */
  onboardingConnectActive?: boolean;
  onOnboardingProviderConnected?: () => void;
};

export function useSessionProviderAuth(input: UseSessionProviderAuthInput) {
  const {
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
    selectedWorkspaceId,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  } = input;
  const reloadCoordinator = useReloadCoordinator();
  // The onboarding stage itself is PERSISTED preferences state owned by the
  // session route; this hook only detects "a provider connected while the
  // modal was open" for the BYO path of the "Your AI" cover.
  const connectedAtModalOpenRef = useRef<number | null>(null);

  const stateRef = useRef({
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  });
  stateRef.current = {
    opencodeClient,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
  };

  const store = useMemo(
    () =>
      createProviderAuthStore({
        client: () => stateRef.current.opencodeClient,
        providers: () => stateRef.current.providers,
        providerDefaults: () => stateRef.current.providerDefaults,
        providerConnectedIds: () => stateRef.current.providerConnectedIds,
        disabledProviders: () => stateRef.current.disabledProviderIds,
        selectedWorkspaceDisplay: () =>
          stateRef.current.selectedWorkspace
            ? ({
                ...stateRef.current.selectedWorkspace,
                name: workspaceLabel(stateRef.current.selectedWorkspace),
              } as WorkspaceDisplay)
            : emptyWorkspaceDisplay,
        selectedWorkspaceRoot: () => stateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => stateRef.current.selectedWorkspaceEndpoint?.workspaceId ?? null,
        legalworkServer: {
          getSnapshot: () => ({
            legalworkServerStatus: stateRef.current.selectedWorkspaceEndpoint ? "connected" : "disconnected",
            legalworkServerClient: stateRef.current.selectedWorkspaceEndpoint?.client ?? null,
            legalworkServerCapabilities: stateRef.current.selectedWorkspaceEndpoint
              ? {
                  config: { read: true, write: true },
                }
              : null,
          }),
        },
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders: setDisabledProviderIds,
        markOpencodeConfigReloadRequired: () => {
          reloadCoordinator.markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [reloadCoordinator],
  );

  useEffect(() => {
    store.start();
    return () => {
      store.dispose();
    };
  }, [store]);

  useEffect(() => {
    store.syncFromOptions();
  }, [
    opencodeClient,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceEndpoint?.workspaceId,
    selectedWorkspaceRoot,
    store,
  ]);

  // Legacy hash param from pre-persisted onboarding: strip it once.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
    window.location.hash = hash.replace(/[?&]onboarding=1/, "");
  }, []);

  const snapshot = useProviderAuthStoreSnapshot(store);

  // Advance onboarding only when a provider connects *during the connect
  // modal*. Baseline the connected count when the modal opens (not at mount):
  // the existing provider list streams in asynchronously after mount, and
  // counting that as a new connection would skip the "Your AI" cover.
  const { onboardingConnectActive, onOnboardingProviderConnected } = input;
  useEffect(() => {
    if (!onboardingConnectActive) return;
    if (snapshot.providerAuthModalOpen) {
      if (connectedAtModalOpenRef.current === null) {
        connectedAtModalOpenRef.current = providerConnectedIds.length;
      }
      return;
    }
    if (connectedAtModalOpenRef.current !== null) {
      const connectedSomething = providerConnectedIds.length > connectedAtModalOpenRef.current;
      connectedAtModalOpenRef.current = null;
      if (connectedSomething) onOnboardingProviderConnected?.();
    }
  }, [
    onboardingConnectActive,
    onOnboardingProviderConnected,
    providerConnectedIds.length,
    snapshot.providerAuthModalOpen,
  ]);

  return { store, snapshot };
}
