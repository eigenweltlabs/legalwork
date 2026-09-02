/** @jsxImportSource react */
/**
 * One-time migration dialog for installs whose selected model pointed at the
 * retired free tier. Session-route clears the dead selection and calls
 * markFreeRetiredNoticePending(); this dialog then explains the change and
 * offers the trial, on the same hero shell as "What's new". It outranks the
 * other announcements (they defer while it is pending) and never shows in
 * the narrow Office pane — the marker survives, so the main window catches up.
 */
import { useEffect, useState } from "react";
import { PaperGrainGradient } from "@legalwork/ui/react";

import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { isOfficeAddinRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { FeatureAnnouncementModal } from "@/react-app/design-system/modals/feature-announcement-modal";

const NOTICE_KEY = "legalwork.freeRetiredNotice";

/**
 * Remember that a retired free-model selection was just cleared, so the
 * migration dialog shows on this (or the next) launch. Called before the
 * pref is cleared: if the app dies in between, the selection is still
 * retired next boot and we simply mark again. Never downgrades "seen".
 */
export function markFreeRetiredNoticePending(): void {
  try {
    if (window.localStorage.getItem(NOTICE_KEY) !== "seen") {
      window.localStorage.setItem(NOTICE_KEY, "pending");
    }
  } catch {
    // Storage unavailable — the composer's connect-AI bar still explains.
  }
}

/** Whether the migration dialog is still due (other announcements defer). */
export function hasPendingFreeRetiredNotice(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === "pending";
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, "seen");
  } catch {
    // ignore
  }
}

/** The onboarding covers' grained deep-navy blue, dialog-sized. */
function Hero() {
  return (
    <PaperGrainGradient
      className="size-full"
      speed={0}
      scale={1.1}
      rotation={0}
      offsetX={0}
      offsetY={0}
      softness={0.75}
      intensity={0.55}
      noise={0.16}
      shape="corners"
      frame={37706.748}
      colors={["#0a1633", "#0a67c6", "#0a58c2", "#05080f"]}
      colorBack="#05080f"
    />
  );
}

export function FreeRetiredDialog(props: {
  workspacesReady: boolean;
  /** Starts the Eigenwelt sign-in directly in the browser (the platform
   *  funnel continues to the trial) — never the provider picker. */
  onStartTrial: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPreview, setIsPreview] = useState(false);

  useEffect(() => {
    if (isOfficeAddinRuntime()) return;

    // QA hook: localStorage.setItem("legalwork.freeRetiredPreview", "1")
    // force-shows the dialog, ignoring pending state, and never marks seen.
    let preview = false;
    try {
      preview = window.localStorage.getItem("legalwork.freeRetiredPreview") === "1";
    } catch {
      // ignore
    }
    if (preview) {
      setIsPreview(true);
      setOpen(true);
      return;
    }

    if (!props.workspacesReady) return;
    if (!hasPendingFreeRetiredNotice()) return;
    const timer = window.setTimeout(() => {
      setOpen(true);
      captureAnalyticsEvent("free_retired_notice_shown");
    }, 600);
    return () => window.clearTimeout(timer);
  }, [props.workspacesReady]);

  if (!open) return null;

  const dismiss = () => {
    if (!isPreview) {
      markSeen();
      captureAnalyticsEvent("free_retired_notice_dismissed");
    }
    setOpen(false);
  };

  const startTrial = () => {
    if (!isPreview) {
      markSeen();
      captureAnalyticsEvent("free_retired_notice_trial_clicked");
    }
    setOpen(false);
    props.onStartTrial();
  };

  return (
    <FeatureAnnouncementModal
      open
      eyebrow={t("free_retired.eyebrow")}
      headline={t("free_retired.headline")}
      intro={t("free_retired.intro")}
      heroOverlay={<Hero />}
      entries={[
        { title: t("free_retired.keep_title"), body: t("free_retired.keep_body") },
        { title: t("free_retired.trial_title"), body: t("free_retired.trial_body") },
        { title: t("free_retired.byo_title"), body: t("free_retired.byo_body") },
      ]}
      primaryAction={{ label: t("free_retired.cta"), onClick: startTrial }}
      dismissLabel={t("free_retired.dismiss")}
      onDismiss={dismiss}
    />
  );
}
