/** @jsxImportSource react */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Loader2, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { t } from "@/i18n";
import type {
  AudioDictationPermissionKind,
  AudioDictationReadiness,
} from "@legalwork/types/audio";

import { formatBytes } from "../../../../app/utils";
import { tierName } from "../../recorder/model-tiers";
import { SetupStep, recommendedTier } from "../../recorder/recorder-setup";
import { useRecorderStore } from "../../recorder/recorder-store";

/** How often the page re-probes the OS while something is still missing. */
const READINESS_POLL_MS = 4000;

type ReadinessStep = {
  id: AudioDictationPermissionKind | "model";
  done: boolean;
};

/**
 * The steps this machine still needs, in the order a user should click
 * through them. "unavailable" and "not-required" never block: the first is
 * an environment without the native probe, the second a platform where the
 * permission does not exist.
 */
function readinessSteps(
  readiness: AudioDictationReadiness | null,
  modelInstalled: boolean,
): ReadinessStep[] {
  if (!readiness) return [];
  const steps: ReadinessStep[] = [
    {
      id: "microphone",
      done: readiness.microphone === "granted" || readiness.microphone === "unknown",
    },
  ];
  const permissionOk = (state: string) =>
    state !== "denied" && state !== "broken" && state !== "not-determined";

  if (readiness.platform === "darwin") {
    steps.push(
      { id: "inputMonitoring", done: permissionOk(readiness.inputMonitoring) },
      { id: "accessibility", done: permissionOk(readiness.accessibility) },
      { id: "automation", done: permissionOk(readiness.automation) },
    );
  }
  steps.push({ id: "model", done: modelInstalled });
  return steps;
}

/**
 * Replaces the Dictate Anywhere settings with guided setup while a required
 * permission or model is missing. This mirrors the Recorder's first-run gate:
 * users fix prerequisites in context before seeing the feature controls.
 */
export function DictationReadinessGate(props: { children: ReactNode }) {
  const store = useRecorderStore();
  const readiness = store.dictationReadiness;
  const [checking, setChecking] = useState(true);
  const [requesting, setRequesting] = useState<AudioDictationPermissionKind | null>(null);
  const [setupSkipped, setSetupSkipped] = useState(false);
  /** Keep the completed checklist visible until the user continues. */
  const [setupEngaged, setSetupEngaged] = useState(false);

  const modelInstalled = store.bootstrap?.models.some((model) => model.state === "installed") ?? false;
  const steps = useMemo(
    () => readinessSteps(readiness, modelInstalled),
    [readiness, modelInstalled],
  );
  const activeIndex = steps.findIndex((step) => !step.done);
  const setupNeeded = readiness !== null && activeIndex !== -1;
  const setupVisible = !setupSkipped && (setupNeeded || (setupEngaged && readiness !== null));

  // Read live OS state before showing the normal page, then keep it current
  // when the user returns from System Settings.
  useEffect(() => {
    let mounted = true;
    void Promise.all([store.refreshDictationReadiness(), store.refreshBootstrap()]).finally(() => {
      if (mounted) setChecking(false);
    });
    const onFocus = () => void store.refreshDictationReadiness();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted = false;
      window.removeEventListener("focus", onFocus);
    };
    // The recorder store is module-scoped and its actions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!setupNeeded || setupSkipped) return;
    setSetupEngaged(true);
    const timer = window.setInterval(
      () => void store.refreshDictationReadiness(),
      READINESS_POLL_MS,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupNeeded, setupSkipped]);

  const requestPermission = (kind: AudioDictationPermissionKind) => {
    setRequesting(kind);
    void store.requestDictationPermission(kind).finally(() => setRequesting(null));
  };
  const repairPermission = (kind: AudioDictationPermissionKind) => {
    setRequesting(kind);
    void store.repairDictationPermission(kind).finally(() => setRequesting(null));
  };

  if (checking) return null;
  if (!setupVisible) return <>{props.children}</>;

  const allDone = activeIndex === -1;
  return (
    <div className="mx-auto w-full max-w-xl py-6">
      <div className="flex flex-col items-start">
        <h1 className="text-2xl font-medium tracking-[-0.02em] text-ink">
          {allDone
            ? t("recorder.dictation_readiness_done_title")
            : t("recorder.dictation_readiness_title")}
        </h1>
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-subtext">
          {allDone
            ? t("recorder.dictation_readiness_done_subtitle")
            : t("recorder.dictation_readiness_subtitle")}
        </p>
      </div>

      <DictationReadinessSetup
        readiness={readiness}
        steps={steps}
        activeIndex={activeIndex}
        requesting={requesting}
        onRequest={requestPermission}
        onRepair={repairPermission}
        onSkip={() => setSetupSkipped(true)}
        onDone={() => setSetupEngaged(false)}
      />
    </div>
  );
}

/**
 * Click-through permission setup. Every step re-checks live: granting in
 * System Settings ticks steps off on focus/poll without manual confirmation.
 */
function DictationReadinessSetup(props: {
  readiness: AudioDictationReadiness;
  steps: ReadinessStep[];
  activeIndex: number;
  requesting: AudioDictationPermissionKind | null;
  onRequest: (kind: AudioDictationPermissionKind) => void;
  onRepair: (kind: AudioDictationPermissionKind) => void;
  onSkip: () => void;
  onDone: () => void;
}) {
  const store = useRecorderStore();
  const readiness = props.readiness;
  const allDone = props.activeIndex === -1;
  const mac = readiness.platform === "darwin";
  const showDevHint = mac && readiness.packaged === false;
  // tccutil-based repair resets entries for OUR bundle id; dev runs are
  // attributed to the launching terminal/IDE and must not offer it.
  const repairAvailable = mac && readiness.packaged === true;

  const recommended = recommendedTier(store.bootstrap);
  const recommendedModel = store.bootstrap?.models.find((model) => model.id === recommended.modelId);
  const downloading = recommendedModel?.state === "downloading";
  const totalBytes = recommendedModel?.totalBytes || recommendedModel?.approxSizeBytes || 0;
  const downloadedBytes = recommendedModel?.downloadedBytes ?? 0;
  const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

  const permissionStep = (
    step: ReadinessStep,
    index: number,
    kind: AudioDictationPermissionKind,
    view: {
      title: string;
      body: string;
      blockedHint: string | null;
      cta: string;
      /** Stale or declined grant: offer the tccutil reset + fresh prompt. */
      repairable?: boolean;
    },
  ) => {
    const repair = view.repairable === true && repairAvailable && kind !== "microphone";
    return (
      <SetupStep
        key={step.id}
        index={index}
        done={step.done}
        active={index === props.activeIndex}
        title={view.title}
        doneLabel={t("recorder.perm_status_granted")}
      >
        <p className="text-sm text-subtext">{view.blockedHint ?? view.body}</p>
        {showDevHint ? (
          <p className="mt-1.5 text-xs text-tertiary">{t("recorder.perm_dev_hint")}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            disabled={props.requesting !== null}
            onClick={() => (repair ? props.onRepair(kind) : props.onRequest(kind))}
          >
            {props.requesting === kind ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : null}
            {repair ? t("recorder.dictation_repair_cta") : view.cta}
          </Button>
          {repair ? (
            <button
              type="button"
              className="text-xs text-subtext underline-offset-2 hover:text-ink hover:underline"
              disabled={props.requesting !== null}
              onClick={() => props.onRequest(kind)}
            >
              {t("recorder.perm_open_settings")}
            </button>
          ) : null}
        </div>
        {props.requesting === kind ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-xs text-subtext animate-in fade-in-0">
            <Loader2 className="size-3 animate-spin text-brand" />
            {t("recorder.dictation_step_waiting_prompt")}
          </p>
        ) : null}
      </SetupStep>
    );
  };

  return (
    <>
      <div className="mt-7 divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
        {props.steps.map((step, index) => {
          if (step.id === "microphone") {
            return permissionStep(step, index, "microphone", {
              title: t("recorder.setup_mic_title"),
              body: t("recorder.setup_mic_body"),
              blockedHint:
                readiness.microphone === "denied" || readiness.microphone === "restricted"
                  ? t("recorder.perm_microphone_instructions")
                  : null,
              cta:
                readiness.microphone === "not-determined"
                  ? t("recorder.setup_mic_cta")
                  : t("recorder.perm_open_settings"),
            });
          }
          if (step.id === "inputMonitoring") {
            const state = readiness.inputMonitoring;
            return permissionStep(step, index, "inputMonitoring", {
              title: t("recorder.dictation_step_monitor_title"),
              body: t("recorder.dictation_step_monitor_body"),
              blockedHint:
                state === "broken"
                  ? t("recorder.dictation_step_monitor_broken")
                  : state === "denied"
                    ? t("recorder.dictation_step_monitor_denied")
                    : null,
              cta:
                state === "not-determined"
                  ? t("recorder.perm_allow")
                  : t("recorder.perm_open_settings"),
              repairable: state === "broken" || state === "denied",
            });
          }
          if (step.id === "accessibility") {
            return permissionStep(step, index, "accessibility", {
              title: t("recorder.dictation_step_a11y_title"),
              body: t("recorder.dictation_step_a11y_body"),
              blockedHint: null,
              cta: t("recorder.perm_open_settings"),
              repairable: readiness.accessibility === "denied",
            });
          }
          if (step.id === "automation") {
            return permissionStep(step, index, "automation", {
              title: t("recorder.dictation_step_automation_title"),
              body: t("recorder.dictation_step_automation_body"),
              blockedHint:
                readiness.automation === "denied"
                  ? t("recorder.dictation_step_automation_denied")
                  : null,
              cta:
                readiness.automation === "not-determined"
                  ? t("recorder.perm_allow")
                  : t("recorder.perm_open_settings"),
              repairable: readiness.automation === "denied",
            });
          }
          return (
            <SetupStep
              key={step.id}
              index={index}
              done={step.done}
              active={index === props.activeIndex}
              title={t("recorder.setup_model_title")}
              doneLabel={t("recorder.model_installed")}
            >
              <p className="text-sm text-subtext">{t("recorder.setup_model_body")}</p>
              <div className="mt-3 flex items-center gap-3">
                {downloading ? (
                  <>
                    <Progress value={pct} className="h-1.5 flex-1" />
                    <span className="text-2xs tabular-nums text-subtext">
                      {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("recorder.model_cancel")}
                      onClick={() => void store.cancelModelDownload(recommended.modelId)}
                    >
                      <X />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => {
                      store.setModelId(recommended.modelId);
                      void store.downloadModel(recommended.modelId);
                    }}
                  >
                    {t("recorder.model_download")} {tierName(recommended.key)}
                  </Button>
                )}
              </div>
              {recommendedModel?.state === "error" && recommendedModel.error ? (
                <div className="mt-1 text-xs text-danger">{recommendedModel.error}</div>
              ) : null}
            </SetupStep>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="flex items-center gap-1.5 text-xs text-subtext">
          <ShieldCheck className="size-3.5 shrink-0 text-success" />
          {t("recorder.perm_recheck_hint")}
        </p>
        {allDone ? (
          <Button onClick={props.onDone}>
            <Check data-icon="inline-start" />
            {t("recorder.setup_done_cta")}
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="shrink-0 text-subtext" onClick={props.onSkip}>
            {t("recorder.setup_skip_all")}
          </Button>
        )}
      </div>
    </>
  );
}
