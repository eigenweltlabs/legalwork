// Session-route wiring for the provider-auth store: a stable store instance
// fed by a latest-values ref, lifecycle (start/dispose), Zen-restriction sync,
// workspace-change resync, the post-onboarding auto-open latch, and cloud
// provider auto-sync. Extracted verbatim from session-route.tsx.
import { useEffect, useMemo, useRef, useState } from "react";

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
  // Onboarding runs through the session as a full-screen "connect" cover (the provider
  // selection step with the searchable modal on top). Usage-analytics consent is a toggle
  // on the welcome step, so there is no longer a separate analytics cover.
  // null = not onboarding. The welcome route lands here with ?onboarding=1.
  const [onboardingStep, setOnboardingStep] = useState<"connect" | null>(() =>
    typeof window !== "undefined" && window.location.hash.includes("onboarding=1") ? "connect" : null,
  );
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

  // Strip the onboarding param so a reload doesn't re-enter the onboarding covers.
  // The covers themselves are driven by the `onboardingStep` state captured at mount.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("onboarding=1")) return;
    window.location.hash = hash.replace(/[?&]onboarding=1/, "");
  }, []);

  const snapshot = useProviderAuthStoreSnapshot(store);

  // Finish onboarding only when a provider connects *during the connect modal*.
  // Baseline the connected count when the modal opens (not at mount): the existing
  // provider list streams in asynchronously after mount, and counting that as a new
  // connection is what made onboarding dismiss itself immediately.
  useEffect(() => {
    if (onboardingStep !== "connect") return;
    if (snapshot.providerAuthModalOpen) {
      if (connectedAtModalOpenRef.current === null) {
        connectedAtModalOpenRef.current = providerConnectedIds.length;
      }
      return;
    }
    if (connectedAtModalOpenRef.current !== null) {
      const connectedSomething = providerConnectedIds.length > connectedAtModalOpenRef.current;
      connectedAtModalOpenRef.current = null;
      if (connectedSomething) setOnboardingStep(null);
    }
  }, [onboardingStep, providerConnectedIds.length, snapshot.providerAuthModalOpen]);

  return {
    store,
    snapshot,
    onboardingStep,
    finishOnboarding: () => setOnboardingStep(null),
  };
}
