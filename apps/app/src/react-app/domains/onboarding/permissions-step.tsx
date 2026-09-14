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

/** The approval prompt the "ask first" settings produce — the panel shows
 * what the switches on the left actually buy the user. */
function PermissionPromptMock() {
  return (
    <div className="mx-auto w-full max-w-[340px] rounded-xl border border-white/10 bg-[#0b1322]/90 p-4 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
      <div className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-[#fbbf24]" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">
          {t("onboarding_permissions.mock_label")}
        </span>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-white/85">
        {t("onboarding_permissions.mock_body")}
      </p>
      <div className="mt-4 flex items-center gap-2">
        <span className="rounded-md bg-white/90 px-2.5 py-1 text-[11px] font-medium text-[#0b1322]">
          {t("onboarding_permissions.mock_allow")}
        </span>
        <span className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-white/60">
          {t("onboarding_permissions.mock_deny")}
        </span>
      </div>
    </div>
  );
}

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
      panelColors={["#0a1633", "#1f3a8a", "#0a58c2", "#05080f"]}
      panel={
        <>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {t("onboarding_permissions.panel_eyebrow")}
            </span>
            <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
              {t("onboarding_permissions.panel_title")}
            </h2>
          </div>
          <PermissionPromptMock />
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {t("onboarding_permissions.panel_footer")}
          </p>
        </>
      }
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
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
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
