/** @jsxImportSource react */
/**
 * Onboarding: the Word/Office step. One action — install the add-in — then
 * the next page. The certificate prompt is a consequence of the click; the
 * step skips itself entirely when no Office app is installed. The panel
 * SHOWS the result: a document with tracked changes and the agent beside it.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { desktopBridge } from "@/app/lib/desktop";
import type { OfficeAddinAppId } from "@legalwork/types/desktop-ipc";
import { t } from "@/i18n";

import { OnboardingCover, StepDots, onboardingDemoActive } from "./onboarding-cover";

type OfficeApp = { id: OfficeAddinAppId; label: string; enabled: boolean; installed: boolean };

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

export function OfficeStep(props: { onDone: (result: "installed" | "skipped" | "unavailable") => void }) {
  const demo = onboardingDemoActive();
  const [apps, setApps] = useState<OfficeApp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const advanceTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
  }, []);

  useEffect(() => {
    captureAnalyticsEvent("onboarding_office_viewed");
    if (demo) {
      setApps([
        { id: "word" as OfficeAddinAppId, label: "Word", enabled: false, installed: true },
        { id: "excel" as OfficeAddinAppId, label: "Excel", enabled: false, installed: true },
      ]);
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
        if (detected.every((app) => app.enabled)) {
          props.onDone("installed");
          return;
        }
        setApps(detected);
      } catch {
        props.onDone("unavailable");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = (apps ?? []).filter((app) => !app.enabled);
  const wordOnly = pending.length === 1;

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      if (demo) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
      } else {
        for (const app of pending) {
          await desktopBridge.officeAddinInstall(app.id);
          captureAnalyticsEvent("office_addin_installed", { app: app.id, surface: "onboarding" });
        }
      }
      setInstalled(true);
      // One action, next page.
      advanceTimer.current = window.setTimeout(() => props.onDone("installed"), 2000);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setBusy(false);
    }
  };

  // Status still loading (or the step is about to self-skip): render nothing.
  if (!apps) return null;

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
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <StepDots step={2} total={3} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("onboarding_office.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_office.subtitle")}
          </p>
        </div>

        {installed ? (
          <div className="flex flex-col gap-2">
            <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-green-11">
              <Check className="size-4" />
              {t("onboarding_office.done")}
            </span>
            <p className="text-[13px] text-dls-secondary">{t("onboarding_office.restart_note")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Button size="lg" className="w-full justify-center" disabled={busy} onClick={() => void install()}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {wordOnly
                ? t("onboarding_office.install_one", { app: pending[0]?.label ?? "Word" })
                : t("onboarding_office.install_all")}
            </Button>
            {error ? <p className="text-[12.5px] text-red-11">{error}</p> : null}
          </div>
        )}

        {installed ? null : (
          <div className="border-t border-dls-border pt-5">
            <button
              type="button"
              className="text-[13px] text-dls-secondary transition-colors hover:text-dls-text"
              onClick={() => props.onDone("skipped")}
            >
              {t("onboarding.skip")}
            </button>
          </div>
        )}
      </div>
    </OnboardingCover>
  );
}
