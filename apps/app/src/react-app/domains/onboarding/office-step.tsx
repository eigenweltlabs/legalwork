/** @jsxImportSource react */
/**
 * Onboarding: the Office step. One row per detected app (Word, Excel,
 * PowerPoint), each with its own install button — mirroring the settings
 * screen. The certificate prompt is a consequence of the click; the step
 * skips itself entirely when no Office app is installed.
 */
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { desktopBridge } from "@/app/lib/desktop";
import excelIcon from "@/assets/office/excel.png";
import powerpointIcon from "@/assets/office/powerpoint.png";
import wordIcon from "@/assets/office/word.png";
import type { OfficeAddinAppId } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

import {
  CoverBackButton,
  CoverSkipButton,
  OnboardingCover,
  StepDots,
  onboardingDemoActive,
} from "./onboarding-cover";

type OfficeApp = { id: OfficeAddinAppId; label: string; enabled: boolean; installed: boolean };

/** The real app icons, extracted from the Office apps themselves. */
const OFFICE_APP_ICONS: Record<string, string> = {
  word: wordIcon,
  excel: excelIcon,
  powerpoint: powerpointIcon,
};

function OfficeAppIcon(props: { appId: OfficeAddinAppId }) {
  const icon = OFFICE_APP_ICONS[props.appId];
  if (!icon) return null;
  return <img src={icon} alt="" className="size-7 shrink-0" aria-hidden />;
}

export function OfficeStep(props: {
  onDone: (result: "installed" | "skipped" | "unavailable") => void;
  /** Absent on the first in-session step — the welcome screen is gone by then. */
  onBack?: () => void;
  /** False when the user navigated back here: show the rows (all installed)
   * instead of skipping forward again. Self-skip on missing Office stays. */
  autoAdvance?: boolean;
}) {
  const demo = onboardingDemoActive();
  const [apps, setApps] = useState<OfficeApp[] | null>(null);
  const [certTrusted, setCertTrusted] = useState(true);
  const [busyApp, setBusyApp] = useState<OfficeAddinAppId | null>(null);
  /** An app was enabled by a click on THIS screen — drives the restart note. */
  const [installedHere, setInstalledHere] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    captureAnalyticsEvent("onboarding_office_viewed");
    if (demo) {
      setApps([
        { id: "word" as OfficeAddinAppId, label: "Word", enabled: false, installed: true },
        { id: "excel" as OfficeAddinAppId, label: "Excel", enabled: false, installed: true },
        { id: "powerpoint" as OfficeAddinAppId, label: "PowerPoint", enabled: false, installed: true },
      ]);
      setCertTrusted(false);
      return;
    }
    void (async () => {
      try {
        const status = await desktopBridge.officeAddinStatus();
        if (!status.supported) {
          props.onDone("unavailable");
          return;
        }
        const detected = status.apps.filter((app) => app.installed);
        if (detected.length === 0) {
          props.onDone("unavailable");
          return;
        }
        if ((props.autoAdvance ?? true) && detected.every((app) => app.enabled)) {
          props.onDone("installed");
          return;
        }
        setApps(detected);
        setCertTrusted(status.certTrusted);
      } catch {
        props.onDone("unavailable");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = async (app: OfficeApp) => {
    setBusyApp(app.id);
    setError(null);
    try {
      if (demo) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      } else {
        const result = await desktopBridge.officeAddinInstall(app.id);
        if (!result.ok) {
          setError(result.error ?? t("office_addins.install_failed"));
          return;
        }
        setCertTrusted(result.status.certTrusted);
      }
      captureAnalyticsEvent("office_addin_installed", { app: app.id, surface: "onboarding" });
      setApps(
        (current) =>
          current?.map((entry) => (entry.id === app.id ? { ...entry, enabled: true } : entry)) ??
          current,
      );
      setInstalledHere(true);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusyApp(null);
    }
  };

  // Status still loading (or the step is about to self-skip): an empty
  // cover, so the app never shows between the welcome screen and the next
  // step.
  if (!apps) return <OnboardingCover>{null}</OnboardingCover>;

  const anyInstalled = apps.some((app) => app.enabled);

  return (
    <OnboardingCover
      footerLeft={
        props.onBack ? (
          <CoverBackButton label={t("onboarding.back")} onClick={props.onBack} />
        ) : null
      }
      footerRight={
        anyInstalled ? (
          <Button size="sm" onClick={() => props.onDone("installed")}>
            {t("onboarding.continue")}
          </Button>
        ) : (
          <CoverSkipButton label={t("onboarding.skip")} onClick={() => props.onDone("skipped")} />
        )
      }
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <StepDots step={2} total={5} />
          <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.04em] text-foreground">
            {t("onboarding_office.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_office.subtitle")}
          </p>
        </div>

        {/* One row per detected Office app, like the settings screen. */}
        <div className="flex flex-col">
          {apps.map((app, index) => (
            <div
              key={app.id}
              className={
                "flex items-center justify-between gap-4 py-3" +
                (index > 0 ? " border-t border-dls-border" : "")
              }
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <OfficeAppIcon appId={app.id} />
                <span className="truncate text-[14px] font-medium text-dls-text">
                  Microsoft {app.label} Add-in
                </span>
              </span>
              <div className="flex h-8 w-24 shrink-0 items-center justify-end">
                {app.enabled ? (
                  <span className="inline-flex h-full items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-green-11">
                    <Check className="size-4 shrink-0" />
                    {t("onboarding_office.done")}
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-full"
                    aria-busy={busyApp === app.id}
                    disabled={busyApp !== null}
                    onClick={() => void install(app)}
                  >
                    {busyApp === app.id ? <Loader2 aria-hidden className="absolute animate-spin" /> : null}
                    <span className={busyApp === app.id ? "opacity-0" : ""}>
                      {t("office_addins.install")}
                    </span>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          {error ? <p className="text-[12.5px] text-red-11">{error}</p> : null}
          {/* Keep both messages in the same grid cell so changing the hint
              never changes the centered content's height, even when translated. */}
          <div className="grid text-[13px] leading-5 text-dls-secondary" aria-live="polite">
            <p aria-hidden={installedHere || certTrusted} className={`col-start-1 row-start-1 ${installedHere || certTrusted ? "invisible" : ""}`}>
              {t("onboarding_office.cert_hint")}
            </p>
            <p aria-hidden={!installedHere} className={`col-start-1 row-start-1 ${installedHere ? "" : "invisible"}`}>
              {t("onboarding_office.restart_note")}
            </p>
          </div>
        </div>
      </div>
    </OnboardingCover>
  );
}
