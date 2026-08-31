/** @jsxImportSource react */
/**
 * Onboarding: transcription & meeting recording. The same three steps as the
 * settings first-run setup — microphone, system audio (the other side of
 * calls), on-device speech model — as a click-through checklist. The model
 * can keep downloading in the background while the user starts working.
 */
import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { formatBytes } from "@/app/utils";
import { t } from "@/i18n";
import type { AudioPermissionState } from "@legalwork/types/audio";

import { formatDictationShortcut } from "../recorder/dictation-shortcut";
import { tierName } from "../recorder/model-tiers";
import { SetupStep, recommendedTier } from "../recorder/recorder-setup";
import { useRecorderStore } from "../recorder/recorder-store";
import {
  CoverBackButton,
  CoverSkipButton,
  OnboardingCover,
  StepDots,
  onboardingDemoActive,
} from "./onboarding-cover";

/** How often the step re-probes the OS while something is still missing. */
const PERMISSION_POLL_MS = 4000;
/** Fallback size shown in demo mode when the real catalog is unavailable. */
const DEMO_MODEL_BYTES = 466 * 1024 * 1024;

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

type SimState = {
  mic: AudioPermissionState;
  micBusy: boolean;
  sys: AudioPermissionState;
  sysWaiting: boolean;
  model: "not-installed" | "downloading" | "installed";
  progress: number; // 0..1 while downloading
};

export function AudioStep(props: {
  onDone: (result: "enabled" | "background" | "skipped") => void;
  onBack: () => void;
}) {
  const store = useRecorderStore();
  const demo = onboardingDemoActive();
  const [sim, setSim] = useState<SimState>({
    mic: "not-determined",
    micBusy: false,
    sys: "not-determined",
    sysWaiting: false,
    model: "not-installed",
    progress: 0,
  });
  const [micBusy, setMicBusy] = useState(false);
  const [sysWaiting, setSysWaiting] = useState(false);
  const [sysSkipped, setSysSkipped] = useState(false);
  const dictationEnableAttempted = useRef(false);
  const simTimers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const timer of simTimers.current) window.clearTimeout(timer);
    },
    [],
  );
  const later = (ms: number, fn: () => void) => {
    simTimers.current.push(window.setTimeout(fn, ms));
  };

  useEffect(() => {
    captureAnalyticsEvent("onboarding_audio_viewed");
    if (!demo) void store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permissions = store.permissions;
  const bootstrap = store.bootstrap;

  const micState: AudioPermissionState = demo ? sim.mic : (permissions?.microphone ?? "unknown");
  const micDone = micState === "granted" || (!demo && micState === "unknown");
  const micBlocked = micState === "denied" || micState === "restricted";

  const sysApplies = demo
    ? true
    : permissions?.platform === "darwin" && bootstrap?.capabilities.systemAudio !== false;
  const sysState: AudioPermissionState = demo ? sim.sys : (permissions?.systemAudio ?? "unknown");
  const sysGranted = sysState === "granted" || (!demo && sysState === "unknown");
  const sysDone = sysGranted || sysSkipped;

  const recommended = recommendedTier(bootstrap);
  const recommendedModel = bootstrap?.models.find((model) => model.id === recommended.modelId);
  const modelInstalled = demo
    ? sim.model === "installed"
    : (bootstrap?.models.some((model) => model.state === "installed") ?? false);
  const modelDownloading = demo
    ? sim.model === "downloading"
    : recommendedModel?.state === "downloading";
  const totalBytes = demo
    ? DEMO_MODEL_BYTES
    : recommendedModel?.totalBytes || recommendedModel?.approxSizeBytes || 0;
  const downloadedBytes = demo
    ? Math.round(sim.progress * DEMO_MODEL_BYTES)
    : (recommendedModel?.downloadedBytes ?? 0);
  const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

  const steps = [
    { id: "microphone" as const, done: micDone, doneLabel: t("recorder.perm_status_granted") },
    ...(sysApplies
      ? [
          {
            id: "systemAudio" as const,
            done: sysDone,
            doneLabel: sysGranted ? t("recorder.perm_status_granted") : t("recorder.setup_skipped"),
          },
        ]
      : []),
    { id: "model" as const, done: modelInstalled, doneLabel: t("recorder.model_installed") },
  ];
  const activeIndex = steps.findIndex((step) => !step.done);
  const allDone = activeIndex === -1;

  // Re-check OS permission state when the user returns from System Settings
  // (focus), plus a slow poll while anything is still missing.
  useEffect(() => {
    if (demo || allDone) return;
    const onFocus = () => void store.refreshPermissions();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void store.refreshPermissions(), PERMISSION_POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, allDone]);

  // Mic + model ready: enable the dictation hotkey once, in the background.
  useEffect(() => {
    if (demo || !micDone || !modelInstalled || dictationEnableAttempted.current) return;
    dictationEnableAttempted.current = true;
    void store.setSystemDictationEnabled(true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, micDone, modelInstalled]);

  const allowMicrophone = () => {
    captureAnalyticsEvent("onboarding_audio_mic_requested");
    if (demo) {
      setSim((state) => ({ ...state, micBusy: true }));
      later(900, () => setSim((state) => ({ ...state, micBusy: false, mic: "granted" })));
      return;
    }
    if (micState === "not-determined" || micState === "unknown") {
      setMicBusy(true);
      void store.requestPermission("microphone").finally(() => setMicBusy(false));
    } else {
      void store.openPermissionSettings("microphone");
    }
  };

  const openSystemAudioSettings = () => {
    captureAnalyticsEvent("onboarding_audio_sys_requested");
    if (demo) {
      setSim((state) => ({ ...state, sysWaiting: true }));
      later(2200, () => setSim((state) => ({ ...state, sysWaiting: false, sys: "granted" })));
      return;
    }
    setSysWaiting(true);
    void store.openPermissionSettings("systemAudio");
  };

  const startDownload = () => {
    captureAnalyticsEvent("onboarding_audio_model_download");
    if (demo) {
      setSim((state) => ({ ...state, model: "downloading", progress: 0 }));
      const tick = () => {
        setSim((state) => {
          if (state.model !== "downloading") return state;
          const progress = Math.min(1, state.progress + 0.03 + Math.random() * 0.05);
          if (progress >= 1) return { ...state, model: "installed", progress: 1 };
          return { ...state, progress };
        });
        later(160, tick);
      };
      later(160, tick);
      return;
    }
    store.setModelId(recommended.modelId);
    void store.downloadModel(recommended.modelId);
  };

  const cancelDownload = () => {
    if (demo) {
      setSim((state) => ({ ...state, model: "not-installed", progress: 0 }));
      return;
    }
    void store.cancelModelDownload(recommended.modelId);
  };

  const finish = (result: "enabled" | "background" | "skipped") => {
    if (!demo && result !== "skipped" && micDone) {
      void store.setSystemDictationEnabled(true).catch(() => undefined);
    }
    props.onDone(result);
  };

  const waitingForSettings = demo ? sim.sysWaiting : sysWaiting;
  const requestingMic = demo ? sim.micBusy : micBusy;
  const modelSize = formatBytes(
    recommendedModel?.installedSizeBytes ?? recommendedModel?.approxSizeBytes ?? DEMO_MODEL_BYTES,
  );

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
      footerLeft={<CoverBackButton label={t("onboarding.back")} onClick={props.onBack} />}
      footerRight={
        allDone ? (
          <Button size="sm" onClick={() => finish("enabled")}>
            {t("onboarding.continue")}
          </Button>
        ) : modelDownloading ? (
          <Button size="sm" onClick={() => finish("background")}>
            {t("onboarding_audio.continue_background")}
          </Button>
        ) : (
          <CoverSkipButton label={t("onboarding.skip")} onClick={() => finish("skipped")} />
        )
      }
    >
      <div className="flex w-full max-w-md flex-col gap-7">
        <div>
          <StepDots step={4} total={4} />
          <h1 className="text-[36px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text">
            {t("onboarding_audio.title")}
          </h1>
          <p className="mt-3 max-w-sm text-[14px] leading-[1.6] text-dls-secondary">
            {t("onboarding_audio.subtitle")}
          </p>
        </div>

        {/* The same steps as the settings first-run setup. */}
        <div className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
          {steps.map((step, index) => {
            const active = index === activeIndex;
            if (step.id === "microphone") {
              return (
                <SetupStep
                  key={step.id}
                  index={index}
                  done={step.done}
                  active={active}
                  title={t("recorder.setup_mic_title")}
                  doneLabel={step.doneLabel}
                >
                  <p className="text-sm text-subtext">
                    {micBlocked
                      ? t("recorder.perm_microphone_instructions")
                      : t("recorder.setup_mic_body")}
                  </p>
                  <div className="mt-3">
                    {micBlocked ? (
                      <Button size="sm" variant="outline" onClick={allowMicrophone}>
                        <ExternalLink data-icon="inline-start" />
                        {t("recorder.perm_open_settings")}
                      </Button>
                    ) : (
                      <Button size="sm" disabled={requestingMic} onClick={allowMicrophone}>
                        {requestingMic ? (
                          <Loader2 data-icon="inline-start" className="animate-spin" />
                        ) : null}
                        {t("recorder.setup_mic_cta")}
                      </Button>
                    )}
                  </div>
                </SetupStep>
              );
            }
            if (step.id === "systemAudio") {
              return (
                <SetupStep
                  key={step.id}
                  index={index}
                  done={step.done}
                  active={active}
                  title={t("recorder.setup_sys_title")}
                  doneLabel={step.doneLabel}
                >
                  <p className="text-sm text-subtext">{t("recorder.setup_sys_body")}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Button size="sm" onClick={openSystemAudioSettings}>
                      <ExternalLink data-icon="inline-start" />
                      {t("recorder.perm_open_settings")}
                    </Button>
                    <button
                      type="button"
                      className="text-xs text-subtext underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => setSysSkipped(true)}
                    >
                      {t("recorder.setup_sys_skip")}
                    </button>
                  </div>
                  {waitingForSettings ? (
                    <p className="mt-2.5 flex items-center gap-1.5 text-xs text-subtext animate-in fade-in-0">
                      <Loader2 className="size-3 animate-spin text-brand" />
                      {t("recorder.setup_sys_waiting")}
                    </p>
                  ) : null}
                </SetupStep>
              );
            }
            return (
              <SetupStep
                key={step.id}
                index={index}
                done={step.done}
                active={active}
                title={t("recorder.setup_model_title")}
                doneLabel={step.doneLabel}
              >
                <p className="text-sm text-subtext">{t("recorder.setup_model_body")}</p>
                <div className="mt-3 flex items-center gap-3">
                  {modelDownloading ? (
                    <>
                      <Progress value={pct} className="h-1.5 flex-1" />
                      <span className="text-2xs tabular-nums text-subtext">
                        {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("recorder.model_cancel")}
                        onClick={cancelDownload}
                      >
                        <X />
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={startDownload}>
                      {t("recorder.model_download")} {tierName(recommended.key)} · {modelSize}
                    </Button>
                  )}
                </div>
                {!demo && recommendedModel?.state === "error" && recommendedModel.error ? (
                  <div className="mt-1 text-xs text-red-11">{recommendedModel.error}</div>
                ) : null}
              </SetupStep>
            );
          })}
        </div>

        {allDone ? (
          <span className="inline-flex items-center gap-1.5 text-[14px] font-medium text-green-11">
            <Check className="size-4" />
            {shortcut
              ? t("onboarding_audio.ready", { shortcut })
              : t("onboarding_audio.ready_generic")}
          </span>
        ) : modelDownloading ? (
          <p className="text-[13px] text-dls-secondary">{t("onboarding_audio.background_note")}</p>
        ) : null}
      </div>
    </OnboardingCover>
  );
}
