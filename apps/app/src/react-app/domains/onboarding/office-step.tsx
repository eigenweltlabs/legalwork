/** @jsxImportSource react */
/**
 * Onboarding: the Office step. One row per detected app (Word, Excel,
 * PowerPoint), each with its own install button — mirroring the settings
 * screen. The certificate prompt is a consequence of the click; the step
 * skips itself entirely when no Office app is installed. The panel SHOWS
 * the result: a document with tracked changes and the agent beside it.
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

/** A Word page with a redline and the LegalWork pane beside it — the panel
 * shows what the user GETS, not another abstract gradient. */
function DocumentMock() {
  const bar = "h-2 rounded-sm bg-[#e4e7ec]";
  return (
    <div className="relative mx-auto w-full max-w-[340px] pb-8 pr-12">
      {/* The document page — colors are fixed: a Word page is white in any theme */}
      <div className="rounded-lg bg-white p-7 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.55)]">
        <div className="h-3 w-32 rounded-sm bg-[#252a33]" />
        <div className="mt-2 h-2 w-20 rounded-sm bg-[#c9ced8]" />
        <div className="mt-6 space-y-2.5">
          <div className={`${bar} w-full`} />
          <div className={`${bar} w-[92%]`} />
          {/* the redline: deletion + insertion */}
          <div className="flex items-center gap-2">
            <div className="relative h-2 w-[28%] rounded-sm bg-[#fbd5d5]">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#e26d6d]" />
            </div>
            <div className="h-2 w-[40%] rounded-sm bg-[#b7e5c4]" />
            <div className={`${bar} w-[16%]`} />
          </div>
          <div className={`${bar} w-[88%]`} />
          <div className={`${bar} w-[55%]`} />
        </div>
        <div className="mt-6 space-y-2.5">
          <div className={`${bar} w-[95%]`} />
          <div className="flex items-center gap-2">
            <div className={`${bar} w-[22%]`} />
            <div className="h-2 w-[34%] rounded-sm bg-[#b7e5c4]" />
            <div className={`${bar} w-[24%]`} />
          </div>
          <div className={`${bar} w-full`} />
          <div className={`${bar} w-[70%]`} />
        </div>
        <div className="mt-6 space-y-2.5">
          <div className={`${bar} w-[90%]`} />
          <div className={`${bar} w-[42%]`} />
        </div>
      </div>
      {/* The agent pane, floating beside the page */}
      <div className="absolute -bottom-0 right-0 w-44 rounded-xl border border-white/15 bg-[#0b1322]/95 p-3.5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px] bg-[#0a58c2]" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/70">
            LegalWork
          </span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="ml-auto w-[85%] rounded-lg rounded-tr-sm bg-white/12 px-2.5 py-2">
            <div className="h-1.5 w-full rounded bg-white/45" />
            <div className="mt-1 h-1.5 w-2/3 rounded bg-white/45" />
          </div>
          <div className="w-[90%] rounded-lg rounded-tl-sm bg-[#0a58c2]/35 px-2.5 py-2">
            <div className="h-1.5 w-full rounded bg-white/60" />
            <div className="mt-1 h-1.5 w-[80%] rounded bg-white/60" />
            <div className="mt-1 h-1.5 w-1/2 rounded bg-white/60" />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 rounded-md bg-white/8 px-2 py-1.5">
          <span className="size-1 rounded-full bg-[#4ade80]" />
          <div className="h-1.5 w-16 rounded bg-white/35" />
        </div>
      </div>
    </div>
  );
}

export function OfficeStep(props: {
  onDone: (result: "installed" | "skipped" | "unavailable") => void;
  onBack: () => void;
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

  // Status still loading (or the step is about to self-skip): render nothing.
  if (!apps) return null;

  const anyInstalled = apps.some((app) => app.enabled);

  return (
    <OnboardingCover
      panel={
        <>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {t("onboarding_office.panel_eyebrow")}
            </span>
            <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
              {t("onboarding_office.panel_title")}
            </h2>
          </div>
          <DocumentMock />
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {t("onboarding_office.panel_footer")}
          </p>
        </>
      }
      footerLeft={<CoverBackButton label={t("onboarding.back")} onClick={props.onBack} />}
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
          <StepDots step={3} total={4} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
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
              {app.enabled ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-green-11">
                  <Check className="size-4" />
                  {t("onboarding_office.done")}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyApp !== null}
                  onClick={() => void install(app)}
                >
                  {busyApp === app.id ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : null}
                  {t("office_addins.install")}
                </Button>
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1.5">
          {error ? <p className="text-[12.5px] text-red-11">{error}</p> : null}
          {installedHere ? (
            <p className="text-[13px] text-dls-secondary">{t("onboarding_office.restart_note")}</p>
          ) : !certTrusted ? (
            <p className="text-[12.5px] leading-relaxed text-dls-secondary">
              {t("onboarding_office.cert_hint")}
            </p>
          ) : null}
        </div>
      </div>
    </OnboardingCover>
  );
}
