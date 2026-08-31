/** @jsxImportSource react */
/**
 * First-run explainer for the on-device transcription feature. Shown once,
 * the first time a desktop user reaches the app after installing/updating,
 * using the same hero modal as "What's new". It defers a launch if a What's
 * new announcement is still pending so the two never stack.
 */
import { useEffect, useState } from "react";

import { FeatureAnnouncementModal } from "@/react-app/design-system/modals/feature-announcement-modal";
import { isDesktopRuntime, isOfficeAddinRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { useLocal } from "@/react-app/kernel/local-provider";

import { hasPendingWhatsNew } from "./whats-new";

const SEEN_KEY = "legalwork.transcriptionIntroSeen";

function alreadySeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // storage unavailable — it may show again next launch, which is fine
  }
}

export function TranscriptionIntroDialog(props: { workspacesReady: boolean; onOpenRecorder: () => void }) {
  const local = useLocal();
  const [open, setOpen] = useState(false);
  const onboardingStage = local.prefs.onboardingStage;

  useEffect(() => {
    if (!isDesktopRuntime() || isOfficeAddinRuntime()) return;
    if (!props.workspacesReady || alreadySeen()) return;
    // A profile inside (or fresh out of) the onboarding covers never needs
    // this announcement: the onboarding setup step covers transcription.
    // Absorb it silently instead of stacking a modal on the covers.
    if (onboardingStage !== "done") {
      markSeen();
      return;
    }
    // Let "What's new" go first; this shows on a later launch instead.
    if (hasPendingWhatsNew()) return;
    const timer = window.setTimeout(() => setOpen(true), 1600);
    return () => window.clearTimeout(timer);
  }, [onboardingStage, props.workspacesReady]);

  if (!open) return null;

  const dismiss = () => {
    markSeen();
    setOpen(false);
  };

  const setUp = () => {
    dismiss();
    // Open the Recorder pane itself (not Settings) so the user lands where they
    // record; the pane guides model download + permissions from there.
    props.onOpenRecorder();
  };

  return (
    <FeatureAnnouncementModal
      open
      eyebrow={t("transcription_intro.eyebrow")}
      headline={t("transcription_intro.headline")}
      intro={t("transcription_intro.intro")}
      entries={[
        { title: t("transcription_intro.record_title"), body: t("transcription_intro.record_body") },
        { title: t("transcription_intro.dictate_title"), body: t("transcription_intro.dictate_body") },
        { title: t("transcription_intro.private_title"), body: t("transcription_intro.private_body") },
      ]}
      primaryAction={{ label: t("transcription_intro.cta"), onClick: setUp }}
      dismissLabel={t("transcription_intro.dismiss")}
      onDismiss={dismiss}
    />
  );
}
