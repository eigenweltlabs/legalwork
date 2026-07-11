/** @jsxImportSource react */
/**
 * First-run onboarding for the benchmark screen. Shown once (per browser
 * profile) the first time the benchmark main view is opened, using the shared
 * FeatureAnnouncementModal shell.
 *
 * QA hook: localStorage.setItem("legalwork.benchmarkOnboardingPreview", "1")
 * force-shows it and never marks it seen.
 */
import { useEffect, useState } from "react";

import { FeatureAnnouncementModal } from "@/react-app/design-system/modals/feature-announcement-modal";
import { t } from "@/i18n";

const SEEN_KEY = "legalwork.benchmarkOnboardingSeen";
const PREVIEW_KEY = "legalwork.benchmarkOnboardingPreview";

export function BenchmarkOnboardingModal(props: { onImport: () => void }) {
  const [open, setOpen] = useState(false);
  const [isPreview, setIsPreview] = useState(false);

  useEffect(() => {
    let preview = false;
    try {
      preview = window.localStorage.getItem(PREVIEW_KEY) === "1";
    } catch {
      // ignore
    }
    if (preview) {
      setIsPreview(true);
      setOpen(true);
      return;
    }

    let seen = false;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      // Storage unavailable: treat as seen so we never nag on every open.
      seen = true;
    }
    if (seen) return;

    // Short delay so it doesn't compete with the screen settling in.
    const timer = window.setTimeout(() => setOpen(true), 400);
    return () => window.clearTimeout(timer);
  }, []);

  const dismiss = () => {
    if (!isPreview) {
      try {
        window.localStorage.setItem(SEEN_KEY, "1");
      } catch {
        // ignore
      }
    }
    setOpen(false);
  };

  if (!open) return null;

  return (
    <FeatureAnnouncementModal
      open
      eyebrow={t("benchmark.onboarding_eyebrow")}
      headline={t("benchmark.onboarding_headline")}
      intro={t("benchmark.onboarding_intro")}
      entries={[
        { title: t("benchmark.onboarding_step1_title"), body: t("benchmark.onboarding_step1_body") },
        { title: t("benchmark.onboarding_step2_title"), body: t("benchmark.onboarding_step2_body") },
        { title: t("benchmark.onboarding_step3_title"), body: t("benchmark.onboarding_step3_body") },
      ]}
      primaryAction={{
        label: t("benchmark.onboarding_cta"),
        onClick: () => {
          dismiss();
          props.onImport();
        },
      }}
      dismissLabel={t("benchmark.onboarding_dismiss")}
      onDismiss={dismiss}
    />
  );
}
