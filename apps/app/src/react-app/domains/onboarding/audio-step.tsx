/** @jsxImportSource react */
/**
 * Onboarding: transcription & dictation. One action — "Turn on
 * transcription" — and everything it needs follows from the click: the
 * microphone prompt, the on-device model download, the dictation hotkey.
 * When it's ready the flow advances by itself.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { t } from "@/i18n";

import { formatDictationShortcut } from "../recorder/dictation-shortcut";
import { useRecorderStore } from "../recorder/recorder-store";
import { OnboardingCover, StepDots, onboardingDemoActive } from "./onboarding-cover";

/** The panel shows the result: a live transcript with labeled speakers. */
function TranscriptMock() {
  const bars = [6, 11, 18, 10, 22, 14, 8, 17, 26, 12, 6, 15, 21, 9, 13, 20, 8, 12, 17, 10, 15, 23, 9, 14];
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <div className="flex h-8 items-end justify-center gap-[3px]">
        {bars.map((height, index) => (
          <span
            key={index}
            className="w-[3px] rounded-full bg-white/70"
            style={{ height: `${height}px` }}
          />
        ))}
      </div>
      <div className="mt-5 space-y-3.5 rounded-xl border border-white/10 bg-[#0b1322]/90 p-5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.8)] backdrop-blur">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8ab4ff]">
            {t("onboarding_audio.sample_speaker1")}
          </span>
          <p className="mt-1 text-[13px] leading-snug text-white/80">
            {t("onboarding_audio.sample_line1")}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#6ee7b7]">
            {t("onboarding_audio.sample_speaker2")}
          </span>
          <p className="mt-1 text-[13px] leading-snug text-white/80">
            {t("onboarding_audio.sample_line2")}
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 pt-3">
          <span className="size-1.5 animate-pulse rounded-full bg-[#f87171]" />
          <span className="text-[11px] text-white/50">{t("onboarding_audio.sample_status")}</span>
        </div>
      </div>
    </div>
  );
}

export function AudioStep(props: { onDone: (result: "enabled" | "skipped") => void }) {
  const store = useRecorderStore();
  const demo = onboardingDemoActive();
  const [wanted, setWanted] = useState(false);
  const [sim, setSim] = useState({ mic: false, progress: 0, ready: false });
  const dictationEnableAttempted = useRef(false);
  const advanceTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
  }, []);

  useEffect(() => {
    captureAnalyticsEvent("onboarding_audio_viewed");
    if (!demo) void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const micState = demo ? (sim.mic ? "granted" : "not-determined") : (store.permissions?.microphone ?? "unknown");
  const micGranted = micState === "granted";
  const recommendedId = store.bootstrap?.device?.recommendedModelId ?? "whisper-small";
  const model = store.bootstrap?.models.find((entry) => entry.id === recommendedId);
  const modelInstalled = demo ? sim.ready : model?.state === "installed";
  const modelDownloading = demo ? wanted && !sim.ready : model?.state === "downloading";
  const progress = demo
    ? sim.progress
    : model && model.totalBytes > 0
      ? Math.round((model.downloadedBytes / model.totalBytes) * 100)
      : 0;
  const ready = micGranted && Boolean(modelInstalled);

  const turnOn = () => {
    setWanted(true);
    captureAnalyticsEvent("onboarding_audio_enabled");
    if (demo) {
      window.setTimeout(() => setSim((s) => ({ ...s, mic: true })), 900);
      let pct = 0;
      const tick = window.setInterval(() => {
        pct += 9;
        if (pct >= 100) {
          window.clearInterval(tick);
          setSim({ mic: true, progress: 100, ready: true });
        } else {
          setSim((s) => ({ ...s, progress: pct }));
        }
      }, 220);
      return;
    }
    // The click is the consent — NOW ask for what the feature needs.
    if (!micGranted) {
      if (micState === "not-determined" || micState === "unknown") {
        void store.requestPermission("microphone");
      } else {
        void store.openPermissionSettings("microphone");
      }
    }
    if (!modelInstalled && !modelDownloading && model) {
      void store.downloadModel(recommendedId);
    }
  };

  // Ready: enable the dictation hotkey once, then move on by itself.
  useEffect(() => {
    if (!wanted || !ready || dictationEnableAttempted.current) return;
    dictationEnableAttempted.current = true;
    if (!demo) void store.setSystemDictationEnabled(true).catch(() => undefined);
    advanceTimer.current = window.setTimeout(() => props.onDone("enabled"), 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, ready]);

  const shortcut = store.systemDictation
    ? formatDictationShortcut(store.systemDictation.accelerator, store.systemDictation.platform)
    : null;

  return (
    <OnboardingCover
      panelColors={["#0a1633", "#18498B", "#2352DE", "#05080f"]}
      panel={
        <>
          <div>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {t("onboarding_audio.panel_eyebrow")}
            </span>
            <h2 className="mt-4 max-w-[16ch] text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-white">
              {t("onboarding_audio.panel_title")}
            </h2>
          </div>
          <TranscriptMock />
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {t("onboarding_audio.panel_footer")}
          </p>
        </>
      }
    >
      <div className="flex w-full max-w-md flex-col gap-8">
        <div>
          <StepDots step={3} total={3} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("onboarding_audio.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_audio.subtitle")}
          </p>
        </div>

        {!wanted ? (
          <Button size="lg" className="w-full justify-center" onClick={turnOn}>
            {t("onboarding_audio.enable")}
          </Button>
        ) : ready ? (
          <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-green-11">
            <Check className="size-4" />
            {shortcut
              ? t("onboarding_audio.ready", { shortcut })
              : t("onboarding_audio.ready_generic")}
          </span>
        ) : (
          <div className="flex flex-col gap-3">
            {!micGranted ? (
              micState === "denied" || micState === "restricted" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-dls-secondary">
                    {t("onboarding_audio.mic_denied")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void store.openPermissionSettings("microphone")}
                  >
                    {t("onboarding_audio.mic_open_settings")}
                  </Button>
                </div>
              ) : (
                <span className="inline-flex items-center gap-2 text-[13px] text-dls-secondary">
                  <Loader2 className="size-4 animate-spin" />
                  {t("onboarding_audio.mic_waiting")}
                </span>
              )
            ) : null}
            {!modelInstalled ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-dls-secondary">
                    {t("onboarding_audio.preparing")}
                  </span>
                  {modelDownloading ? (
                    <span className="text-[12px] tabular-nums text-dls-secondary">{progress}%</span>
                  ) : null}
                </div>
                <Progress value={progress} className="h-1.5 w-full" />
              </div>
            ) : null}
          </div>
        )}

        {ready ? null : (
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
