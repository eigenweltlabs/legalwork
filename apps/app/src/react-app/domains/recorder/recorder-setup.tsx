/** @jsxImportSource react */
/**
 * First-run guided setup for the Recorder tab.
 *
 * Shown instead of the recorder UI the first time someone opens the tab and
 * anything the recorder depends on is still missing. Walks through the three
 * one-time steps in the order they make sense:
 *
 *   1. Microphone access (native prompt)
 *   2. System-audio capture (macOS Screen & System Audio Recording, no
 *      runtime prompt exists, so we deep-link the pane and confirm on focus)
 *   3. Download a local transcription model (recommended tier for the device)
 *
 * Completing or skipping the flow persists a dismissal flag; afterwards any
 * regressions are handled inline by PermissionsPanel / the model hint, never
 * by this full-pane experience again.
 *
 * Demo mode: `localStorage.setItem("legalwork.recorder.setupDemo", "1")`
 * forces the flow with simulated permission/model state so the whole journey
 * can be exercised on a machine that is already fully set up. Finishing or
 * skipping clears the flag.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Cpu, Download, ExternalLink, Loader2, Lock, Mic, ShieldCheck, Sparkles, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import type {
  AudioCapturePermissions,
  AudioPermissionState,
  AudioRecorderBootstrap,
} from "@legalwork/types/audio";

import { formatBytes } from "../../../app/utils";
import { PremiumUpgradeDialog } from "./model-tier-select";
import { MODEL_TIERS, isPremiumEntitled, tierForModelId, tierName, tierTagline, type ModelTier } from "./model-tiers";
import { usePremiumUpsell } from "./premium-upsell-context";
import { useRecorderStore } from "./recorder-store";

/** Persisted: the first-run flow was completed or explicitly skipped. */
const SETUP_DISMISSED_KEY = "legalwork.recorder.setupDismissed";
/** Dev/demo: force the flow with simulated state (cleared on exit). */
const SETUP_DEMO_KEY = "legalwork.recorder.setupDemo";

/** Fallback size shown in demo mode when the real catalog is unavailable. */
const DEMO_MODEL_BYTES = 466 * 1024 * 1024;

export function recorderSetupDismissed(): boolean {
  try {
    return localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
  } catch {
    return true;
  }
}

export function markRecorderSetupDismissed() {
  try {
    localStorage.setItem(SETUP_DISMISSED_KEY, "1");
  } catch {
    // storage unavailable, dismiss for this session only
  }
}

export function recorderSetupDemoEnabled(): boolean {
  try {
    return localStorage.getItem(SETUP_DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

function clearRecorderSetupDemo() {
  try {
    localStorage.removeItem(SETUP_DEMO_KEY);
  } catch {
    // nothing to clean up
  }
}

export type RecorderSetupStatus = "loading" | "needed" | "done";

/**
 * Whether the first-run flow still has work to do. "unknown" permission
 * states never count as missing (the bridge could not read them, and the
 * recorder itself does not block on unknown either).
 */
export function recorderSetupStatus(
  permissions: AudioCapturePermissions | null,
  bootstrap: AudioRecorderBootstrap | null,
): RecorderSetupStatus {
  if (!permissions || !bootstrap) return "loading";
  const micOk = permissions.microphone === "granted" || permissions.microphone === "unknown";
  const sysApplies = permissions.platform === "darwin" && bootstrap.capabilities.systemAudio !== false;
  const sysOk = !sysApplies || permissions.systemAudio === "granted" || permissions.systemAudio === "unknown";
  const modelOk = bootstrap.models.some((model) => model.state === "installed");
  return micOk && sysOk && modelOk ? "done" : "needed";
}

/**
 * The tier step 3 offers: the device recommendation when it is free (or the
 * firm is entitled to it), otherwise the best free tier.
 */
function recommendedTier(bootstrap: AudioRecorderBootstrap | null) {
  const recommendedId = bootstrap?.device?.recommendedModelId;
  const tier = recommendedId ? tierForModelId(recommendedId) : null;
  if (tier && (!tier.premium || isPremiumEntitled())) return tier;
  return MODEL_TIERS.find((entry) => entry.key === "standard") ?? MODEL_TIERS[0];
}

type SimState = {
  mic: AudioPermissionState;
  sys: AudioPermissionState;
  micBusy: boolean;
  sysWaiting: boolean;
  model: "not-installed" | "downloading" | "installed";
  /** Which tier the simulated download/install applies to. */
  modelId: string | null;
  progress: number; // 0..1 while downloading
};

type StepView = {
  id: "microphone" | "systemAudio" | "model";
  done: boolean;
  doneLabel: string;
};

function StepStatusBubble(props: { done: boolean; active: boolean; index: number }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-medium transition-colors duration-200",
        props.done
          ? "bg-success text-white"
          : props.active
            ? "bg-brand text-brand-fg"
            : "bg-sunken text-tertiary",
      )}
      aria-hidden
    >
      {props.done ? <Check className="size-4" /> : props.index + 1}
    </span>
  );
}

function SetupStep(props: {
  index: number;
  done: boolean;
  active: boolean;
  title: string;
  doneLabel: string;
  /** Body + actions, rendered only while the step is the active one. */
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3.5 px-5 py-4 transition-opacity duration-200",
        !props.done && !props.active && "opacity-50",
      )}
    >
      <StepStatusBubble done={props.done} active={props.active} index={props.index} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-ink">{props.title}</h3>
          {props.done ? (
            <span className="shrink-0 text-xs font-medium text-success">{props.doneLabel}</span>
          ) : null}
        </div>
        {props.active && props.children ? (
          <div className="mt-1 animate-in fade-in-0 duration-200">{props.children}</div>
        ) : null}
      </div>
    </div>
  );
}

export function RecorderSetup(props: { demo: boolean; onFinished: () => void }) {
  const store = useRecorderStore();
  const upsell = usePremiumUpsell();
  const [sim, setSim] = useState<SimState>({
    mic: "not-determined",
    sys: "not-determined",
    micBusy: false,
    sysWaiting: false,
    model: "not-installed",
    modelId: null,
    progress: 0,
  });
  const [deviceDialogTier, setDeviceDialogTier] = useState<ModelTier | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  const [sysWaiting, setSysWaiting] = useState(false);
  const [sysSkipped, setSysSkipped] = useState(false);
  const autoSelectedRef = useRef(false);
  const simTimers = useRef<number[]>([]);

  // Re-check OS permission status whenever the user comes back from System
  // Settings (window focus), so granted steps tick off without any clicking.
  useEffect(() => {
    if (props.demo) return;
    const onFocus = () => void store.refreshPermissions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.demo]);

  useEffect(
    () => () => {
      for (const timer of simTimers.current) window.clearTimeout(timer);
    },
    [],
  );

  const later = (ms: number, fn: () => void) => {
    simTimers.current.push(window.setTimeout(fn, ms));
  };

  const demo = props.demo;
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
  const showDevHint = !demo && permissions?.platform === "darwin" && permissions.packaged === false;

  const recommended = recommendedTier(bootstrap);
  const fastDevice = bootstrap?.device?.fastDevice ?? false;
  const modelInstalled = demo
    ? sim.model === "installed"
    : (bootstrap?.models.some((model) => model.state === "installed") ?? false);

  // Once a model lands, make it the selected one (recording needs an explicit
  // installed selection, and first-run users should not have to know that).
  useEffect(() => {
    if (demo || !bootstrap) return;
    const installed = bootstrap.models.filter((model) => model.state === "installed");
    if (!installed.length || autoSelectedRef.current) return;
    const selected = installed.some((model) => model.id === store.modelId);
    if (!selected) {
      autoSelectedRef.current = true;
      store.setModelId(installed.find((model) => model.id === recommended.modelId)?.id ?? installed[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, bootstrap, store.modelId, recommended.modelId]);

  const steps: StepView[] = [
    { id: "microphone", done: micDone, doneLabel: t("recorder.perm_status_granted") },
    ...(sysApplies
      ? [
          {
            id: "systemAudio" as const,
            done: sysDone,
            doneLabel: sysGranted ? t("recorder.perm_status_granted") : t("recorder.setup_skipped"),
          },
        ]
      : []),
    { id: "model", done: modelInstalled, doneLabel: t("recorder.model_installed") },
  ];
  const activeIndex = steps.findIndex((step) => !step.done);
  const allDone = activeIndex === -1;

  const finish = () => {
    markRecorderSetupDismissed();
    if (demo) clearRecorderSetupDemo();
    // The proactive panel was primed on init; setup owns that job now.
    store.dismissPermissionsPanel();
    props.onFinished();
  };

  const allowMicrophone = () => {
    if (demo) {
      setSim((state) => ({ ...state, micBusy: true }));
      later(900, () => setSim((state) => ({ ...state, micBusy: false, mic: "granted" })));
      return;
    }
    if (micState === "not-determined") {
      setMicBusy(true);
      void store.requestPermission("microphone").finally(() => setMicBusy(false));
    } else {
      void store.openPermissionSettings("microphone");
    }
  };

  const openSystemAudioSettings = () => {
    if (demo) {
      setSim((state) => ({ ...state, sysWaiting: true }));
      later(2200, () => setSim((state) => ({ ...state, sysWaiting: false, sys: "granted" })));
      return;
    }
    setSysWaiting(true);
    void store.openPermissionSettings("systemAudio");
  };

  const skipSystemAudio = () => {
    setSysSkipped(true);
    if (!demo && store.sources.includes("system")) store.toggleSource("system");
  };

  const startDownload = (tier: ModelTier) => {
    if (demo) {
      setSim((state) => ({ ...state, model: "downloading", modelId: tier.modelId, progress: 0 }));
      const tick = () => {
        setSim((state) => {
          if (state.model !== "downloading") return state;
          const progress = Math.min(1, state.progress + 0.02 + Math.random() * 0.05);
          if (progress >= 1) return { ...state, model: "installed", progress: 1 };
          return { ...state, progress };
        });
        later(140, tick);
      };
      later(140, tick);
      return;
    }
    store.setModelId(tier.modelId);
    void store.downloadModel(tier.modelId);
  };

  /** Same gates as the Settings model list: premium → upsell, device → dialog. */
  const tierLocks = (tier: ModelTier) => {
    const model = bootstrap?.models.find((entry) => entry.id === tier.modelId);
    // Demo always shows the locked premium state so the upsell is demoable
    // even on an entitled machine.
    const unlocked = !demo && (isPremiumEntitled() || store.unlockedModels.includes(tier.modelId));
    const premiumLocked = tier.premium && !unlocked;
    const deviceLocked = Boolean(model?.requiresFastDevice ?? tier.requiresFastDevice) && !fastDevice && !unlocked;
    return { premiumLocked, deviceLocked };
  };

  const pickTier = (tier: ModelTier) => {
    const model = bootstrap?.models.find((entry) => entry.id === tier.modelId);
    const { premiumLocked, deviceLocked } = tierLocks(tier);
    if (premiumLocked) {
      upsell.open();
      return;
    }
    if (deviceLocked) {
      setDeviceDialogTier(tier);
      return;
    }
    if (!demo && model?.state === "installed") {
      store.setModelId(tier.modelId);
      return;
    }
    startDownload(tier);
  };

  const cancelDownload = (tier: ModelTier) => {
    if (demo) {
      setSim((state) => ({ ...state, model: "not-installed", modelId: null, progress: 0 }));
      return;
    }
    void store.cancelModelDownload(tier.modelId);
  };

  const waitingForSettings = demo ? sim.sysWaiting : sysWaiting;
  const requestingMic = demo ? sim.micBusy : micBusy;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-12">
      {/* Header */}
      <div className="flex flex-col items-start">
        <span
          className={cn(
            "flex size-11 items-center justify-center rounded-2xl transition-colors duration-300",
            allDone ? "bg-success-soft text-success" : "bg-brand-soft text-brand",
          )}
        >
          {allDone ? <Check className="size-5" /> : <Mic className="size-5" />}
        </span>
        <h1 className="mt-4 text-2xl font-medium tracking-[-0.02em] text-ink">
          {allDone ? t("recorder.setup_done_title") : t("recorder.setup_title_flow")}
        </h1>
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-subtext">
          {allDone ? t("recorder.setup_done_subtitle") : t("recorder.setup_subtitle_flow")}
        </p>
      </div>

      {/* Steps */}
      <div className="mt-7 divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
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
                  {micBlocked ? t("recorder.perm_microphone_instructions") : t("recorder.setup_mic_body")}
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
                {showDevHint ? (
                  <p className="mt-1.5 text-xs text-tertiary">{t("recorder.perm_dev_hint")}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Button size="sm" onClick={openSystemAudioSettings}>
                    <ExternalLink data-icon="inline-start" />
                    {t("recorder.perm_open_settings")}
                  </Button>
                  <button
                    type="button"
                    className="text-xs text-subtext underline-offset-2 hover:text-ink hover:underline"
                    onClick={skipSystemAudio}
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
              <div className="mt-3 divide-y divide-subtle overflow-hidden rounded-xl border border-subtle bg-surface">
                {MODEL_TIERS.map((tier) => {
                  const model = bootstrap?.models.find((entry) => entry.id === tier.modelId);
                  const { premiumLocked, deviceLocked } = tierLocks(tier);
                  const locked = premiumLocked || deviceLocked;
                  const installed = demo
                    ? sim.model === "installed" && sim.modelId === tier.modelId
                    : model?.state === "installed";
                  const downloading = demo
                    ? sim.model === "downloading" && sim.modelId === tier.modelId
                    : model?.state === "downloading";
                  const totalBytes = model?.totalBytes || model?.approxSizeBytes || DEMO_MODEL_BYTES;
                  const downloadedBytes = demo
                    ? Math.round(sim.progress * totalBytes)
                    : (model?.downloadedBytes ?? 0);
                  const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
                  const size = formatBytes(model?.installedSizeBytes ?? model?.approxSizeBytes ?? DEMO_MODEL_BYTES);
                  const actionable = !downloading && !installed;
                  return (
                    <div
                      key={tier.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        if (actionable) pickTier(tier);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          if (actionable) pickTier(tier);
                        }
                      }}
                      className={cn(
                        "flex items-center gap-3 px-3.5 py-2.5 transition-colors",
                        actionable && "cursor-pointer hover:bg-hover",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-sm font-medium text-ink">{tierName(tier.key)}</span>
                          {tier.key === recommended.key ? (
                            <Badge variant="outline" className="text-2xs text-brand">
                              {t("recorder.model_recommended")}
                            </Badge>
                          ) : null}
                          {tier.premium ? (
                            <Badge className="gap-1 text-2xs">
                              <Sparkles className="size-2.5" />
                              {t("recorder.tier_premium_locked")}
                            </Badge>
                          ) : null}
                          {(model?.requiresFastDevice ?? tier.requiresFastDevice) ? (
                            <Badge variant="outline" className="gap-1 text-2xs">
                              <Cpu className="size-2.5" />
                              {t("recorder.tier_device_badge")}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-subtext">{tierTagline(tier.key)}</div>
                        {downloading ? (
                          <div className="mt-2 flex items-center gap-2">
                            <Progress value={pct} className="h-1.5 flex-1" />
                            <span className="text-2xs tabular-nums text-subtext">
                              {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                            </span>
                          </div>
                        ) : null}
                        {!demo && model?.state === "error" && model.error ? (
                          <div className="mt-1 text-xs text-danger">{model.error}</div>
                        ) : null}
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {downloading ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("recorder.model_cancel")}
                            onClick={(event) => {
                              event.stopPropagation();
                              cancelDownload(tier);
                            }}
                          >
                            <X />
                          </Button>
                        ) : installed ? (
                          <span className="inline-flex items-center gap-1 text-xs text-success">
                            <Check className="size-3" />
                            {t("recorder.model_installed")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-2xs text-subtext">
                            {locked ? <Lock className="size-3" /> : <Download className="size-3" />}
                            {size}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </SetupStep>
          );
        })}
      </div>

      {/* Hardware gate for the heaviest tier — the premium gate opens the
          shared upsell challenge instead (see pickTier). */}
      <PremiumUpgradeDialog
        open={Boolean(deviceDialogTier)}
        onOpenChange={(open) => {
          if (!open) setDeviceDialogTier(null);
        }}
        reason="device"
        onConfirm={() => {
          const tier = deviceDialogTier;
          setDeviceDialogTier(null);
          if (!tier) return;
          if (!demo) store.unlockModelForTesting(tier.modelId);
          startDownload(tier);
        }}
      />

      {/* Footer: privacy assurance + exit */}
      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="flex items-center gap-1.5 text-xs text-subtext">
          <ShieldCheck className="size-3.5 shrink-0 text-success" />
          {t("recorder.setup_privacy_note")}
        </p>
        {allDone ? (
          <Button onClick={finish}>{t("recorder.setup_done_cta")}</Button>
        ) : (
          <Button variant="ghost" size="sm" className="shrink-0 text-subtext" onClick={finish}>
            {t("recorder.setup_skip_all")}
          </Button>
        )}
      </div>
    </div>
  );
}
