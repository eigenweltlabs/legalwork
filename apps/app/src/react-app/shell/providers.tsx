/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { MotionConfig } from "motion/react";

import { Toaster } from "@/components/ui/sonner";

import { isWebDeployment } from "@/app/lib/legalwork-deployment";
import { hydrateLegalworkServerSettingsFromEnv } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/utils";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ServerProvider } from "@/react-app/kernel/server-provider";
import { ArchitectureMismatchGate } from "./architecture-mismatch-gate";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { resolveLegalworkConnection } from "./legalwork-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";

function resolveDefaultServerUrl(): string {
  if (isDesktopRuntime()) return "http://127.0.0.1:4096";

  const legalworkUrl =
    typeof import.meta.env?.VITE_LEGALWORK_URL === "string"
      ? import.meta.env.VITE_LEGALWORK_URL.trim()
      : "";
  if (legalworkUrl) {
    return `${legalworkUrl.replace(/\/+$/, "")}/opencode`;
  }

  if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/opencode`;
  }

  const envUrl =
    typeof import.meta.env?.VITE_OPENCODE_URL === "string"
      ? import.meta.env.VITE_OPENCODE_URL.trim()
      : "";
  return envUrl || "http://127.0.0.1:4096";
}

type AppProvidersProps = {
  children: ReactNode;
};

export function AppProviders({ children }: AppProvidersProps) {
  hydrateLegalworkServerSettingsFromEnv();

  useEffect(() => {
    // Start the dev observability forwarder. Reads the current legalwork-server
    // URL on every flush so reconnects after port changes still work. In prod
    // builds `startDebugLogger` is a no-op.
    startDebugLogger({
      serverUrl: async () => (await resolveLegalworkConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  const defaultUrl = resolveDefaultServerUrl();
  return (
    <MotionConfig reducedMotion="user">
    <BootStateProvider>
      <ServerProvider defaultUrl={defaultUrl}>
        <ArchitectureMismatchGate>
          <DesktopRuntimeBoot />
          <LocalProvider>
            <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
            <Toaster />
          </LocalProvider>
        </ArchitectureMismatchGate>
      </ServerProvider>
    </BootStateProvider>
    </MotionConfig>
  );
}
