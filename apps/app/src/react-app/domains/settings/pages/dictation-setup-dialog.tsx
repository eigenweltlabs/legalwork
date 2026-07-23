/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AudioLines, Check, Keyboard, Loader2, MousePointerClick, ShieldCheck, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  AudioDictationPermissionKind,
  AudioDictationReadiness,
  AudioSystemDictationPlatform,
} from "@legalwork/types/audio";
import { t } from "@/i18n";

import { audioSystemDictationPaste } from "@/app/lib/desktop";

import { formatBytes } from "../../../../app/utils";
import { formatDictationShortcut } from "../../recorder/dictation-shortcut";
import { SetupStep, recommendedTier } from "../../recorder/recorder-setup";
import { tierName } from "../../recorder/model-tiers";
import { useRecorderStore } from "../../recorder/recorder-store";

/** How often the wizard re-probes the OS while something is still missing. */
const READINESS_POLL_MS = 4000;

type ReadinessStepId = AudioDictationPermissionKind | "model";

type ReadinessStep = { id: ReadinessStepId; done: boolean };

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
  const mac = readiness.platform === "darwin";
  const permissionOk = (state: string) => state !== "denied" && state !== "broken" && state !== "not-determined";
  return [
    {
      id: "microphone" as const,
      done: readiness.microphone === "granted" || readiness.microphone === "unknown",
    },
    ...(mac
      ? [
          { id: "inputMonitoring" as const, done: permissionOk(readiness.inputMonitoring) },
          { id: "accessibility" as const, done: permissionOk(readiness.accessibility) },
          { id: "automation" as const, done: permissionOk(readiness.automation) },
        ]
      : []),
    { id: "model" as const, done: modelInstalled },
  ];
}

function acceleratorFromEvent(
  event: KeyboardEvent<HTMLButtonElement>,
  platform: AudioSystemDictationPlatform,
): string | null {
  event.preventDefault();
  event.stopPropagation();
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push(platform === "darwin" ? "Command" : "Super");

  let key = "";
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)) key = event.key.toUpperCase();
  else {
    const namedKeys: Record<string, string> = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Backspace: "Backspace",
      Delete: "Delete",
      Enter: "Enter",
      Tab: "Tab",
    };
    key = namedKeys[event.key] ?? "";
  }
  if (!key || (modifiers.length === 0 && !key.startsWith("F"))) return null;
  return [...modifiers, key].join("+");
}

export function DictationSetupDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const store = useRecorderStore();
  const dictation = store.systemDictation;
  const readiness = store.dictationReadiness;
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState<AudioDictationPermissionKind | null>(null);
  const [setupSkipped, setSetupSkipped] = useState(false);
  /** The wizard was shown this open; keeps the done screen up for its CTA. */
  const [wizardEngaged, setWizardEngaged] = useState(false);
  const capturing = dictation?.shortcutCaptureActive === true;

  const modelInstalled = store.bootstrap?.models.some((model) => model.state === "installed") ?? false;
  const steps = useMemo(
    () => readinessSteps(readiness, modelInstalled),
    [readiness, modelInstalled],
  );
  const activeIndex = steps.findIndex((step) => !step.done);
  const setupNeeded = readiness !== null && activeIndex !== -1;
  const wizardVisible = !setupSkipped && (setupNeeded || (wizardEngaged && readiness !== null));

  const stopCapture = async () => {
    await store.setSystemDictationShortcutCapture(false);
  };

  useEffect(() => {
    if (props.open) return;
    if (capturing) void stopCapture();
    // Capture cleanup follows the dialog boundary, not store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  // Probe the OS every time the dialog opens: permissions rot behind the
  // app's back (updates invalidate macOS grants, users decline one-time
  // prompts), so the wizard has to re-derive what is missing, never trust a
  // stored "was fine once". Re-probe on focus (returning from System
  // Settings) and on a slow poll while something is still missing.
  useEffect(() => {
    if (!props.open) return;
    setSetupSkipped(false);
    setWizardEngaged(false);
    void store.refreshDictationReadiness();
    void store.refreshBootstrap();
    const onFocus = () => void store.refreshDictationReadiness();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // Probing follows the dialog boundary, not store identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !setupNeeded || setupSkipped) return;
    setWizardEngaged(true);
    const timer = window.setInterval(
      () => void store.refreshDictationReadiness(),
      READINESS_POLL_MS,
    );
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, setupNeeded, setupSkipped]);

  const requestPermission = (kind: AudioDictationPermissionKind) => {
    setRequesting(kind);
    void store.requestDictationPermission(kind).finally(() => setRequesting(null));
  };

  const repairPermission = (kind: AudioDictationPermissionKind) => {
    setRequesting(kind);
    void store.repairDictationPermission(kind).finally(() => setRequesting(null));
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && capturing) void stopCapture();
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-[760px] gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-[760px]">
        <DialogHeader className="items-center px-8 pb-6 pt-8 text-center">
          <DialogTitle className="text-2xl">
            {wizardVisible && !setupNeeded
              ? t("recorder.dictation_readiness_done_title")
              : wizardVisible
                ? t("recorder.dictation_readiness_title")
                : t("recorder.dictation_setup_title")}
          </DialogTitle>
          <DialogDescription className="text-base">
            {wizardVisible && !setupNeeded
              ? t("recorder.dictation_readiness_done_subtitle")
              : wizardVisible
                ? t("recorder.dictation_readiness_subtitle")
                : t("recorder.dictation_setup_description")}
          </DialogDescription>
        </DialogHeader>

        {wizardVisible ? (
          <ReadinessWizard
            readiness={readiness}
            steps={steps}
            activeIndex={activeIndex}
            requesting={requesting}
            onRequest={requestPermission}
            onRepair={repairPermission}
            onSkip={() => setSetupSkipped(true)}
            onDone={() => setWizardEngaged(false)}
          />
        ) : (
          <>
        <section className="border-y border-subtle px-8 py-6">
          <div className="text-xs font-semibold uppercase text-subtext">
            {t("recorder.dictation_hotkey_label")}
          </div>
          <button
            type="button"
            disabled={!dictation || saving}
            className={cn(
              "mt-4 flex min-h-40 w-full flex-col items-center justify-center gap-3 rounded-lg border border-subtle bg-surface px-6 outline-none transition-colors",
              "hover:bg-sunken focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20",
              capturing && "border-brand bg-brand/5",
            )}
            onClick={() => {
              if (capturing) return;
              void store.setSystemDictationShortcutCapture(true);
            }}
            onKeyDown={(event) => {
              if (!capturing || !dictation) return;
              if (event.key === "Escape") {
                event.preventDefault();
                void stopCapture();
                return;
              }
              if (dictation.supportsHold) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              const accelerator = acceleratorFromEvent(event, dictation.platform);
              if (!accelerator) return;
              setSaving(true);
              void store
                .setSystemDictationShortcut(accelerator)
                .finally(() => stopCapture())
                .finally(() => setSaving(false));
            }}
          >
            <span className="grid min-h-14 min-w-14 place-items-center rounded-md border border-subtle bg-sunken px-3 font-mono text-lg font-medium text-ink shadow-sm">
              {dictation ? formatDictationShortcut(dictation.accelerator, dictation.platform) : <Keyboard />}
            </span>
            <span className="text-sm text-subtext">
              {saving
                ? t("recorder.dictation_hotkey_saving")
                : capturing
                  ? t("recorder.dictation_hotkey_listening")
                  : t("recorder.dictation_hotkey_change")}
            </span>
          </button>

          <div className="mt-6 flex items-center justify-between gap-4 border-t border-subtle pt-5">
            <div>
              <div className="text-xs font-semibold uppercase text-subtext">
                {t("recorder.dictation_mode_label")}
              </div>
              <div className="mt-1 text-sm text-subtext">
                {dictation?.mode === "hold"
                  ? t("recorder.dictation_mode_hold_description")
                  : dictation && !dictation.supportsHold
                    ? t("recorder.dictation_mode_hold_permission")
                    : t("recorder.dictation_mode_tap_description")}
              </div>
            </div>
            <div className="flex rounded-xl bg-sunken p-0.5">
              <button
                type="button"
                aria-pressed={dictation?.mode === "tap"}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                  dictation?.mode === "tap" ? "bg-surface text-ink shadow-xs" : "text-subtext",
                )}
                onClick={() => void store.setSystemDictationMode("tap")}
              >
                <MousePointerClick className="size-4" />
                {t("recorder.dictation_mode_tap")}
              </button>
              <button
                type="button"
                aria-pressed={dictation?.mode === "hold"}
                title={dictation?.supportsHold ? undefined : t("recorder.dictation_mode_hold_unavailable")}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
                  dictation?.mode === "hold" ? "bg-surface text-ink shadow-xs" : "text-subtext",
                )}
                onClick={() => {
                  if (dictation?.supportsHold) void store.setSystemDictationMode("hold");
                  else void store.openSystemDictationSettings();
                }}
              >
                <AudioLines className="size-4" />
                {t("recorder.dictation_mode_hold")}
              </button>
            </div>
          </div>
        </section>

        <section className="px-8 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-xs font-semibold uppercase text-subtext">
              {t("recorder.dictation_test_label")}
            </span>
            <span className="text-sm text-subtext">
              {dictation
                ? t("recorder.dictation_test_shortcut", {
                    shortcut: formatDictationShortcut(dictation.accelerator, dictation.platform),
                  })
                : ""}
            </span>
          </div>
          <Textarea
            className="mt-3 min-h-32 resize-none text-base"
            placeholder={t("recorder.dictation_test_placeholder")}
          />
        </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Click-through permission setup, mirroring the Recorder first-run flow.
 * Every step re-checks live: granting in System Settings ticks steps off on
 * focus/poll without any manual confirm.
 */
function ReadinessWizard(props: {
  readiness: AudioDictationReadiness | null;
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
  const mac = readiness?.platform === "darwin";
  const showDevHint = mac && readiness?.packaged === false;
  // tccutil-based repair resets entries for OUR bundle id; dev runs are
  // attributed to the launching terminal/IDE and must not offer it.
  const repairAvailable = mac && readiness?.packaged === true;

  const recommended = recommendedTier(store.bootstrap);
  const recommendedModel = store.bootstrap?.models.find((model) => model.id === recommended.modelId);
  const downloading = recommendedModel?.state === "downloading";
  const totalBytes = recommendedModel?.totalBytes || recommendedModel?.approxSizeBytes || 0;
  const downloadedBytes = recommendedModel?.downloadedBytes ?? 0;
  const pct = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;

  // End-to-end paste self-test: runs the REAL pipeline (clipboard, the
  // Accessibility-gated keystroke, System Events) into this dialog's own
  // input, so "everything green" is proven by execution, not by reading
  // permission state. A failure re-probes readiness to resurface the step
  // that actually broke.
  const [pasteTest, setPasteTest] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const pasteInputRef = useRef<HTMLInputElement | null>(null);

  const runPasteTest = () => {
    const input = pasteInputRef.current;
    if (!input) return;
    input.value = "";
    input.focus();
    setPasteTest("running");
    setPasteError(null);
    void audioSystemDictationPaste(t("recorder.dictation_paste_test_sample"))
      .then((result) => {
        if (result.error) {
          setPasteTest("failed");
          setPasteError(result.error);
          void store.refreshDictationReadiness();
          return;
        }
        // The keystroke already landed (paste resolves after its restore
        // delay); the input's content is the end-to-end proof.
        window.setTimeout(() => {
          setPasteTest(input.value.trim().length > 0 ? "ok" : "failed");
        }, 350);
      })
      .catch(() => setPasteTest("failed"));
  };

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
    <div className="px-8 pb-8">
      <div className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
        {props.steps.map((step, index) => {
          if (step.id === "microphone") {
            return permissionStep(step, index, "microphone", {
              title: t("recorder.setup_mic_title"),
              body: t("recorder.setup_mic_body"),
              blockedHint:
                readiness?.microphone === "denied" || readiness?.microphone === "restricted"
                  ? t("recorder.perm_microphone_instructions")
                  : null,
              cta:
                readiness?.microphone === "not-determined"
                  ? t("recorder.setup_mic_cta")
                  : t("recorder.perm_open_settings"),
            });
          }
          if (step.id === "inputMonitoring") {
            const state = readiness?.inputMonitoring;
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
              // A grant that looks on but is dead, or one declined earlier,
              // is fixed by wiping our stale entries and prompting fresh.
              repairable: state === "broken" || state === "denied",
            });
          }
          if (step.id === "accessibility") {
            return permissionStep(step, index, "accessibility", {
              title: t("recorder.dictation_step_a11y_title"),
              body: t("recorder.dictation_step_a11y_body"),
              blockedHint: null,
              cta: t("recorder.perm_open_settings"),
              // "denied" cannot distinguish never-granted from a stale row
              // bound to an older build; the reset covers both.
              repairable: readiness?.accessibility === "denied",
            });
          }
          if (step.id === "automation") {
            return permissionStep(step, index, "automation", {
              title: t("recorder.dictation_step_automation_title"),
              body: t("recorder.dictation_step_automation_body"),
              blockedHint:
                readiness?.automation === "denied"
                  ? t("recorder.dictation_step_automation_denied")
                  : null,
              cta:
                readiness?.automation === "not-determined"
                  ? t("recorder.perm_allow")
                  : t("recorder.perm_open_settings"),
              repairable: readiness?.automation === "denied",
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

      {allDone ? (
        <div className="mt-4 rounded-xl border border-subtle bg-surface px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={pasteInputRef}
              className="h-9 min-w-0 flex-1 rounded-md border border-subtle bg-sunken px-3 text-sm text-ink outline-none focus:border-brand"
              placeholder={t("recorder.dictation_paste_test_placeholder")}
            />
            <Button size="sm" variant="outline" disabled={pasteTest === "running"} onClick={runPasteTest}>
              {pasteTest === "running" ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              {t("recorder.dictation_paste_test_cta")}
            </Button>
          </div>
          {pasteTest === "ok" ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-success animate-in fade-in-0">
              <Check className="size-3" />
              {t("recorder.dictation_paste_test_ok")}
            </p>
          ) : pasteTest === "failed" ? (
            <p className="mt-2 text-xs text-danger">
              {pasteError ?? t("recorder.dictation_paste_test_failed")}
            </p>
          ) : null}
        </div>
      ) : null}

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
    </div>
  );
}
