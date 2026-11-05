/** @jsxImportSource react */
/**
 * Meeting recording and Dictate Anywhere share device setup, while each
 * feature requests its own missing access in an in-app setup dialog.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { formatBytes } from "@/app/utils";
import { t } from "@/i18n";
import {
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";
import type { AudioDictationPermissionKind, AudioPermissionState } from "@legalwork/types/audio";

import { RecorderFlow, type RecorderSetupRequirement, type RecorderFeature } from "./recorder-flow";
import { dictationPermissionReady, dictationSetupPermissions, onboardingDictationPermissions, type DictationSetupPermission } from "./recorder-permissions";
import { MODEL_TIERS, tierName } from "../recorder/model-tiers";
import { cloudModelName } from "../recorder/cloud-model-list";
import { recommendedTier } from "../recorder/recorder-setup";
import { useRecorderStore, isTranscriptionReady } from "../recorder/recorder-store";
import { onboardingDemoActive } from "./onboarding-cover";
import { confirmTranscriptionChoice, TranscriptionChoices, type TranscriptionChoice, type TranscriptionOption } from "./transcription-choice";

/** How often the step re-probes the OS while something is still missing. */
const PERMISSION_POLL_MS = 4000;
/** Fallback size shown in demo mode when the real catalog is unavailable. */
const DEMO_MODEL_BYTES = 466 * 1024 * 1024;

type SimState = {
  mic: AudioPermissionState;
  micBusy: boolean;
  sys: AudioPermissionState;
  sysWaiting: boolean;
  model: "not-installed" | "downloading" | "installed";
  dictationPermissions: Record<DictationSetupPermission, boolean>;
  progress: number; // 0..1 while downloading
};

export function AudioStep(props: {
  feature: RecorderFeature;
  onDone: (result: "enabled" | "background" | "skipped") => void;
  onBack: () => void;
  /** For the entitlement check — a firm with premium models gets the premium
   *  transcription model offered instead of the free tier. */
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string | null;
}) {
  const store = useRecorderStore();
  const demo = onboardingDemoActive();
  const [sim, setSim] = useState<SimState>({
    mic: "not-determined",
    micBusy: false,
    sys: "not-determined",
    sysWaiting: false,
    model: "not-installed",
    dictationPermissions: { inputMonitoring: false, accessibility: false, automation: false },
    progress: 0,
  });
  const [micBusy, setMicBusy] = useState(false);
  const [sysWaiting, setSysWaiting] = useState(false);
  const [requestingDictation, setRequestingDictation] = useState<AudioDictationPermissionKind | null>(null);
  const [checkingReadiness, setCheckingReadiness] = useState(!demo);
  const [transcriptionChoice, setTranscriptionChoice] = useState<TranscriptionChoice | null>(null);
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
    captureAnalyticsEvent(props.feature === "meetings" ? "onboarding_audio_viewed" : "onboarding_dictation_viewed");
  }, [props.feature]);

  useEffect(() => {
    if (!demo) void Promise.all([store.init(), store.refreshDictationReadiness()]).finally(() => setCheckingReadiness(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const permissions = store.permissions;
  const bootstrap = store.bootstrap;

  const micState: AudioPermissionState = demo ? sim.mic : (permissions?.microphone ?? "unknown");
  const micDone = micState === "granted" || (!demo && permissions !== null && micState === "unknown");
  const micBlocked = micState === "denied" || micState === "restricted";

  const sysApplies = demo
    ? true
    : permissions?.platform === "darwin" && bootstrap?.capabilities.systemAudio !== false;
  const sysState: AudioPermissionState = demo ? sim.sys : (permissions?.systemAudio ?? "unknown");
  const sysGranted = sysState === "granted" || (!demo && sysState === "unknown");

  // A firm already entitled to premium models (an existing Eigenwelt
  // connection — the onboarding AI step now runs after this one) gets the
  // premium transcription model; everyone else the device recommendation /
  // best free tier. Live query, so the tier upgrades on this screen the
  // moment the platform reports an entitlement.
  const entitlementsQuery = useEigenweltEntitlements({
    client: props.legalworkClient,
    workspaceId: props.workspaceId,
  });
  const premiumEntitled = hasEigenweltFeature(
    entitlementsQuery.data?.entitlements ?? null,
    "premium_models",
  );
  const premiumTier = MODEL_TIERS.find((tier) => tier.key === "premium");
  const recommended =
    premiumEntitled && premiumTier ? premiumTier : recommendedTier(bootstrap);
  const recommendedModel = bootstrap?.models.find((model) => model.id === recommended.modelId);
  const modelInstalled = demo
    ? sim.model === "installed"
    : isTranscriptionReady(store);
  const localDownloading = demo
    ? sim.model === "downloading"
    : recommendedModel?.state === "downloading";
  const modelDownloading = transcriptionChoice?.source === "local" && localDownloading;
  const totalBytes = demo
    ? DEMO_MODEL_BYTES
    : recommendedModel?.totalBytes || recommendedModel?.approxSizeBytes || 0;
  const downloadedBytes = demo ? sim.progress * DEMO_MODEL_BYTES : (recommendedModel?.downloadedBytes ?? 0);
  const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

  const readiness = store.dictationReadiness;
  const extraPermissions = demo ? dictationSetupPermissions : onboardingDictationPermissions(readiness);
  const permissionViews: Record<DictationSetupPermission, { title: string; body: string }> = {
    inputMonitoring: { title: t("onboarding_audio.shortcut_access_title"), body: t("onboarding_audio.shortcut_access_description") },
    accessibility: { title: t("onboarding_audio.insert_access_title"), body: t("onboarding_audio.insert_access_description") },
    automation: { title: t("onboarding_audio.permission_automation_title"), body: t("onboarding_audio.paste_access_description") },
  };

  // Re-check OS permission state when the user returns from System Settings
  // (focus), plus a slow poll while anything is still missing.
  useEffect(() => {
    if (demo) return;
    const refresh = () => { void Promise.all([store.refreshPermissions(), store.refreshDictationReadiness(), store.refreshSystemDictation(), store.refreshMeeting()]).finally(() => setSysWaiting(false)); };
    const onFocus = refresh;
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(refresh, PERMISSION_POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

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

  useEffect(() => {
    if (!demo || sim.model !== "downloading") return;
    const timer = window.setInterval(() => setSim(state => {
      const progress = Math.min(1, state.progress + 0.08);
      return { ...state, progress, model: progress === 1 ? "installed" : "downloading" };
    }), 160);
    return () => window.clearInterval(timer);
  }, [demo, sim.model]);

  const cancelDownload = () => {
    if (demo) {
      setSim((state) => ({ ...state, model: "not-installed", progress: 0 }));
      return;
    }
    void store.cancelModelDownload(recommended.modelId);
  };

  const waitingForSettings = demo ? sim.sysWaiting : sysWaiting;
  const requestingMic = demo ? sim.micBusy : micBusy;
  const modelSize = formatBytes(
    recommendedModel?.installedSizeBytes ?? recommendedModel?.approxSizeBytes ?? DEMO_MODEL_BYTES,
  );

  const microphone: RecorderSetupRequirement = {
    id: "microphone",
    title: t("onboarding_audio.mic_access_title"),
    description: t("onboarding_audio.mic_access_description"),
    ready: micDone,
    readyLabel: micState === "granted" ? t("recorder.perm_status_granted") : undefined,
    hint: micBlocked ? t("recorder.perm_microphone_instructions") : null,
    action: <Button disabled={requestingMic} onClick={allowMicrophone}>
      {requestingMic ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {t(micBlocked ? "recorder.perm_open_settings" : "recorder.perm_allow")}
    </Button>,
  };
  const systemAudio: RecorderSetupRequirement = {
    id: "systemAudio",
    title: t("onboarding_audio.system_access_title"),
    description: t("onboarding_audio.system_access_description"),
    ready: sysGranted,
    readyLabel: sysState === "granted" ? t("recorder.perm_status_granted") : undefined,
    hint: waitingForSettings ? t("recorder.perm_recheck_hint") : null,
    action: <Button onClick={openSystemAudioSettings}>
      {waitingForSettings ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {t("recorder.perm_allow")}
    </Button>,
  };
  const localInstalled = demo ? sim.model === "installed" : recommendedModel?.state === "installed";
  const transcriptionOptions: TranscriptionOption[] = [
    ...(demo ? [] : bootstrap?.cloud?.models ?? []).filter(model => model.enabled && model.available).map<TranscriptionOption>(model => ({
      source: "cloud", modelId: model.model, title: cloudModelName(model.region),
      description: t("onboarding_audio.transcription_cloud_description"),
    })),
    {
      source: "local", modelId: recommended.modelId,
      title: t("onboarding_audio.transcription_device"),
      description: t("onboarding_audio.transcription_local_description"),
      disabled: !demo && (!recommendedModel || bootstrap?.engine.available === false),
    },
  ];
  const chosenOption = transcriptionOptions.find(option => option.source === transcriptionChoice?.source && option.modelId === transcriptionChoice.modelId && !option.disabled);
  const model: RecorderSetupRequirement = {
    id: "model",
    title: t("onboarding_audio.transcription_title"),
    description: t("onboarding_audio.transcription_description"),
    ready: modelInstalled,
    downloading: modelDownloading === true,
    hint: transcriptionChoice?.source === "local" && !demo && recommendedModel?.state === "error" ? recommendedModel.error : null,
    configure: {
      canContinue: !!chosenOption,
      label: transcriptionChoice?.source === "local" && !localInstalled ? t("recorder.model_download") : undefined,
      onContinue: async () => {
        if (!chosenOption || !transcriptionChoice) return false;
        if (demo) {
          if (sim.model === "installed") return true;
          setSim(state => ({ ...state, model: "downloading", progress: 0 }));
          return false;
        }
        return confirmTranscriptionChoice(transcriptionChoice);
      },
    },
    action: <div className="space-y-4">
      <TranscriptionChoices value={transcriptionChoice} options={transcriptionOptions} onChange={setTranscriptionChoice} />
      {transcriptionChoice?.source === "local" ? <p className="text-xs leading-relaxed text-subtext">{t(localInstalled ? "onboarding_audio.local_model_installed" : "onboarding_audio.local_model_download", { model: tierName(recommended.key), size: modelSize })}</p> : null}
      {!demo && !transcriptionOptions.some(option => option.source === "cloud") ? <p className="text-xs leading-relaxed text-subtext">{t("recorder.transcription_cloud_access")}</p> : null}
      {modelDownloading ? <div className="space-y-3" role="status">
        <div className="flex items-center gap-3">
          <Progress value={pct} className="h-1.5 flex-1" />
          <span className="text-xs tabular-nums text-subtext">{pct}%</span>
          <Button variant="ghost" size="icon-sm" aria-label={t("recorder.model_cancel")} onClick={cancelDownload}><X /></Button>
        </div>
        <p className="text-xs text-subtext">{t("onboarding_audio.background_note")}</p>
      </div> : null}
    </div>,
  };
  const dictationAccess: RecorderSetupRequirement[] = extraPermissions.map(kind => ({
    id: kind,
    title: permissionViews[kind].title,
    description: permissionViews[kind].body,
    ready: demo ? sim.dictationPermissions[kind] : dictationPermissionReady(readiness?.[kind] ?? "not-determined"),
    readyLabel: t("recorder.perm_status_granted"),
    hint: readiness?.[kind] === "broken" ? t("recorder.dictation_step_monitor_broken") : !demo ? t("recorder.perm_recheck_hint") : null,
    action: <Button disabled={requestingDictation !== null} onClick={() => {
      if (demo) { setSim(state => ({ ...state, dictationPermissions: { ...state.dictationPermissions, [kind]: true } })); return; }
      setRequestingDictation(kind);
      void store.requestDictationPermission(kind).finally(() => setRequestingDictation(null));
    }}>
      {requestingDictation === kind ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {t("recorder.perm_allow")}
    </Button>,
  }));

  return <RecorderFlow
    feature={props.feature}
    demo={demo}
    loading={checkingReadiness}
    onSetupStart={() => {
      const cloud = transcriptionOptions.find(option => option.source === "cloud" && option.modelId === store.cloudModelId)
        ?? transcriptionOptions.find(option => option.source === "cloud");
      setTranscriptionChoice(cloud ? { source: cloud.source, modelId: cloud.modelId } : null);
    }}
    meetingRequirements={[microphone, ...(sysApplies ? [systemAudio] : []), model]}
    dictationRequirements={[microphone, ...dictationAccess, model]}
    onBack={props.onBack}
    onDone={ready => props.onDone(modelDownloading ? "background" : ready ? "enabled" : "skipped")}
  />;
}
