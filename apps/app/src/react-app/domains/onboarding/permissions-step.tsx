/** @jsxImportSource react */
/**
 * Onboarding: tool permissions. Renders the SAME panel as Settings -> Tool
 * Permissions, so whatever is chosen here is exactly what settings shows
 * later — one component, one source of truth. In its "quick" variant: the
 * three safety switches, no per-tool or pattern rules, because those push
 * the step's one action below the fold and belong in Settings anyway.
 */
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { ToolPermissionsPanel } from "../settings/panels/tool-permissions-panel";
import { ROUTE_LEGALWORK_CAPABILITIES } from "../../shell/legalwork-capabilities";

import { CoverBackButton, OnboardingCover, StepDots } from "./onboarding-cover";

export type PermissionsStepProps = {
  legalworkClient: LegalworkServerClient | null;
  /** Server-side workspace id — the transport for the shared config. */
  runtimeWorkspaceId: string | null;
  /** Permissions only bite once the engine rebuilds its config. */
  onConfigUpdated: () => void;
  onDone: () => void;
  /** Absent on non-desktop, where this is the first in-session step. */
  onBack?: () => void;
};

export function PermissionsStep(props: PermissionsStepProps) {
  useEffect(() => {
    captureAnalyticsEvent("onboarding_permissions_viewed");
  }, []);

  return (
    <OnboardingCover
      footerLeft={
        props.onBack ? (
          <CoverBackButton label={t("onboarding.back")} onClick={props.onBack} />
        ) : null
      }
      footerRight={
        <Button size="sm" onClick={props.onDone}>
          {t("onboarding.continue")}
        </Button>
      }
    >
      <div className="flex w-full max-w-md flex-col gap-7">
        <div>
          <StepDots step={4} total={5} />
          <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.04em] text-foreground">
            {t("onboarding_permissions.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_permissions.subtitle")}
          </p>
        </div>

        <ToolPermissionsPanel
          variant="quick"
          className="p-0"
          legalworkServerClient={props.legalworkClient}
          legalworkServerStatus={props.legalworkClient ? "connected" : "disconnected"}
          legalworkServerCapabilities={props.legalworkClient ? ROUTE_LEGALWORK_CAPABILITIES : null}
          runtimeWorkspaceId={props.runtimeWorkspaceId}
          onConfigUpdated={props.onConfigUpdated}
        />
      </div>
    </OnboardingCover>
  );
}
