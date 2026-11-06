import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, Keyboard, Loader2, Mic, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { useRecorderStore } from "../recorder/recorder-store";
import { formatDictationShortcut } from "../recorder/dictation-shortcut";
import { DictationShortcutControl } from "../settings/pages/dictation-setup-dialog";
import { ComposerDictationBar } from "../session/surface/composer/composer-dictation";
import { appendDictatedText, useComposerDictation } from "../session/surface/composer/use-composer-dictation";
import { CoverBackButton, CoverSkipButton, OnboardingCover, StepDots } from "./onboarding-cover";

export type RecorderSetupRequirement = {
  id: string;
  title: string;
  description: string;
  ready: boolean;
  readyLabel?: string;
  downloading?: boolean;
  action: ReactNode;
  hint?: string | null;
  /** Configuration always asks for a fresh choice, even if already usable. */
  configure?: { canContinue: boolean; onContinue: () => boolean | Promise<boolean>; label?: string };
};

export type RecorderFeature = "meetings" | "dictation";

/** A separate onboarding step for each feature; setup stays in a local dialog. */
export function RecorderFlow(props: {
  feature: RecorderFeature;
  demo: boolean;
  loading: boolean;
  meetingRequirements: RecorderSetupRequirement[];
  dictationRequirements: RecorderSetupRequirement[];
  onBack: () => void;
  onDone: (ready: boolean) => void;
  onSetupStart?: () => void;
}) {
  const store = useRecorderStore();
  const section = props.feature;
  const [open, setOpen] = useState(false);
  const [demoEnabled, setDemoEnabled] = useState(false);
  const setupButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const requirements = section === "meetings" ? props.meetingRequirements : props.dictationRequirements;
  const enabled = props.demo ? demoEnabled : store.systemDictation?.enabled === true && store.systemDictation.registered;
  const downloading = requirements.some(item => item.downloading);
  const captureBusy = !props.demo && Boolean(store.recording || store.starting || store.finalizing || store.dictationRecordingId || store.dictationState === "starting");
  const ready = !props.loading && requirements.every(item => item.ready) && (section === "meetings" || enabled);
  const title = t(section === "meetings" ? "onboarding_audio.meetings_title" : "recorder.dictation_title");
  const setDialogOpen = (next: boolean) => {
    if (!next && section === "dictation" && !props.demo) {
      const recorder = useRecorderStore.getState();
      // The inline test owns its own cleanup. Also cancel a shortcut-started
      // test, including pending startup/transcription, before leaving setup.
      if (!recorder.composerDictation && (recorder.dictationRecordingId || recorder.dictationState === "starting")) void recorder.cancelRecording();
    }
    setOpen(next);
  };

  return <>
    <OnboardingCover compact
      footerLeft={<CoverBackButton label={t("onboarding.back")} disabled={captureBusy} onClick={props.onBack} />}
      footerRight={ready || downloading
        ? <Button ref={continueButton} size="sm" disabled={captureBusy} onClick={() => props.onDone(ready)}>{t("onboarding.continue")}</Button>
        : <CoverSkipButton label={t("onboarding.skip")} disabled={props.loading || captureBusy} onClick={() => props.onDone(ready)} />}
    >
      <div className="flex w-full flex-col items-start gap-7" data-testid={`onboarding-recorder-${section}`}>
        <div>
          <StepDots step={section === "meetings" ? 3 : 4} total={7} />
          <div className="mb-6 grid size-14 place-items-center rounded-2xl border border-dls-border bg-muted/40" aria-hidden="true">
            {section === "meetings" ? <AudioLines className="size-6" strokeWidth={1.5} /> : <Mic className="size-6" strokeWidth={1.5} />}
          </div>
          <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.04em] text-foreground">{title}</h1>
          <p className="mt-3 text-[14px] leading-[1.6] text-dls-secondary">{t(section === "meetings" ? "onboarding_audio.meeting_intro" : "onboarding_audio.dictation_description")}</p>
        </div>
        <div className="space-y-3">
          {ready ? <p className="flex items-center gap-2 text-sm text-foreground" role="status"><Check className="size-4 text-success" />{t("onboarding_audio.setup_ready")}</p> : null}
          {downloading && !ready ? <p className="flex items-start gap-2 text-xs leading-relaxed text-subtext" role="status"><Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />{t("onboarding_audio.background_note")}</p> : null}
          <Button ref={setupButton} size="lg" variant={ready ? "outline" : "default"} disabled={props.loading || captureBusy} onClick={() => { props.onSetupStart?.(); setDialogOpen(true); }}>
            {props.loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {t(ready ? "onboarding_audio.review_setup" : section === "meetings" ? "onboarding_audio.setup_meetings" : "onboarding_audio.setup_dictation")}
          </Button>
        </div>
      </div>
    </OnboardingCover>
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <DialogContent finalFocus={setupButton} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[480px]">
        {open ? <RecorderSetup
          key={section} feature={section} demo={props.demo} requirements={requirements} enabled={enabled}
          onDemoEnabled={() => setDemoEnabled(true)} onClose={() => setDialogOpen(false)}
        /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

/** Keep OS access truthful; configuration requires the user's explicit choice. */
function RecorderSetup(props: {
  feature: RecorderFeature;
  demo: boolean;
  requirements: RecorderSetupRequirement[];
  enabled: boolean;
  onDemoEnabled: () => void;
  onClose: () => void;
}) {
  const store = useRecorderStore();
  const [practice, setPractice] = useState(false);
  const [changing, setChanging] = useState(false);
  const [text, setText] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [meetingDetection, setMeetingDetection] = useState(true);
  const [meetingNotes, setMeetingNotes] = useState<boolean | null>(null);
  const cloudTranscription = !props.demo && store.transcriptionSource === "cloud";
  const summarisationEnabled = cloudTranscription && (meetingNotes ?? true);
  const heading = useRef<HTMLHeadingElement>(null);
  const [stepIds] = useState(() => props.requirements.filter(item => item.configure || !item.ready).map(item => item.id));
  const steps = stepIds.map(id => props.requirements.find(item => item.id === id)).filter(item => item !== undefined);
  const requirement = steps[currentStep];
  const previousConfiguration = steps.slice(0, currentStep).findLastIndex(item => item.configure);
  const isPractice = !requirement && props.feature === "dictation" && practice;
  const dictation = useComposerDictation("onboarding-test", spoken => setText(current => appendDictatedText(current, spoken)), isPractice);
  const capturingShortcut = !props.demo && store.systemDictation?.shortcutCaptureActive === true;
  const busy = changing || dictation.active || capturingShortcut || (!props.demo && (store.starting || store.finalizing || Boolean(store.dictationRecordingId)));
  const detectionSupported = props.demo || store.meeting?.detectionSupported === true;
  const title = requirement?.title ?? t(props.feature === "meetings" ? "onboarding_audio.meeting_ready_title" : isPractice ? "onboarding_audio.practice_title" : "onboarding_audio.shortcut_title");
  const description = requirement?.description ?? t(props.feature === "meetings" ? "onboarding_audio.meeting_ready_description" : isPractice ? "onboarding_audio.practice_description" : !props.demo && store.systemDictation?.supportsHold === false ? "recorder.dictation_gestures_fallback" : "onboarding_audio.shortcut_gestures");
  const step = requirement ? steps.findIndex(item => item.id === requirement.id) : steps.length + (isPractice ? 1 : 0);
  const total = steps.length + (props.feature === "dictation" ? 2 : 1);
  const Icon = requirement?.id === "model" ? AudioLines : requirement?.id === "systemAudio" ? Volume2 : requirement?.id === "microphone" ? Mic : Keyboard;
  useEffect(() => {
    if (requirement?.ready && !requirement.configure) setCurrentStep(step => step + 1);
  }, [requirement?.id, requirement?.ready, requirement?.configure]);
  useEffect(() => {
    if (!isPractice) heading.current?.focus();
  }, [requirement?.id, isPractice]);

  const enableAndTry = async () => {
    setChanging(true);
    try {
      if (props.demo) props.onDemoEnabled();
      else if (!props.enabled) await store.setSystemDictationEnabled(true);
      const status = useRecorderStore.getState().systemDictation;
      if (props.demo || (status?.enabled && status.registered)) setPractice(true);
    } finally { setChanging(false); }
  };

  const continueConfiguration = async () => {
    if (!requirement?.configure) return;
    setChanging(true);
    try {
      if (await requirement.configure.onContinue()) setCurrentStep(step => step + 1);
    } finally { setChanging(false); }
  };
  const finishMeetingSetup = async () => {
    setChanging(true);
    try {
      if (!props.demo) {
        if (detectionSupported) {
          await store.setMeetingDetection(meetingDetection);
          const meeting = useRecorderStore.getState().meeting;
          if (meeting?.error || meeting?.detectionEnabled !== meetingDetection) return;
        }
        store.setMeetingNotes({ enabled: summarisationEnabled });
      }
      props.onClose();
    } finally { setChanging(false); }
  };

  return <div data-testid={`onboarding-${props.feature}-setup`}>
    <div className="px-7 pb-6 pt-7 sm:px-8 sm:pt-8">
      <p className="pr-8 text-xs text-subtext">{t(props.feature === "meetings" ? "onboarding_audio.setup_meetings" : "onboarding_audio.setup_dictation")}</p>
      <div className="mt-4 flex gap-1.5" role="progressbar" aria-label={t("onboarding_audio.setup_progress")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={step + 1}>
        {Array.from({ length: total }, (_, index) => <span key={index} className={`h-1 flex-1 rounded-full ${index <= step ? "bg-foreground" : "bg-muted"}`} />)}
      </div>
      <DialogHeader className="mt-7">
        {requirement ? <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-muted/60" aria-hidden="true"><Icon className="size-5" strokeWidth={1.5} /></div> : null}
        <DialogTitle ref={heading} tabIndex={-1} className="text-[25px] leading-tight tracking-[-0.03em] outline-none">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="mt-6 min-h-28">
        {requirement ? <div className="space-y-4" key={requirement.id}>
          {requirement.ready && !requirement.configure ? <p className="flex items-center gap-2 text-sm" role="status"><Check className="size-4 text-success" />{requirement.readyLabel ?? t("onboarding_audio.setup_ready")}</p> : requirement.action}
          {requirement.hint ? <p className="text-xs leading-relaxed text-subtext" role="status">{requirement.hint}</p> : null}
        </div> : props.feature === "meetings" ? <div className="space-y-4">
          <div className="rounded-xl border border-dls-border p-4">
            <label className="flex cursor-pointer items-center justify-between gap-4 text-sm font-medium">
              {t("recorder.meeting_notes_title")}
              <Switch aria-label={t("recorder.meeting_notes_title")} checked={summarisationEnabled} disabled={!cloudTranscription || changing} onCheckedChange={setMeetingNotes} />
            </label>
            <p className="mt-2 text-xs leading-relaxed text-subtext">{t(cloudTranscription ? "recorder.meeting_notes_description" : "onboarding_audio.summarisation_requires_cloud")}</p>
          </div>
          <div className="rounded-xl border border-dls-border p-4">
            <label className="flex cursor-pointer items-center justify-between gap-4 text-sm font-medium">
              {t("recorder.meeting_detection_title")}
              <Switch aria-label={t("recorder.meeting_detection_title")} checked={detectionSupported && meetingDetection} disabled={!detectionSupported || changing} onCheckedChange={setMeetingDetection} />
            </label>
            <p className="mt-2 text-xs leading-relaxed text-subtext">{t(detectionSupported ? "onboarding_audio.meeting_detection_description" : "onboarding_audio.detection_unavailable")}</p>
          </div>
        </div> : !isPractice ? <DictationShortcutControl compact demo={props.demo} disabled={changing} /> : <div>
          {!props.demo && store.systemDictation ? <p className="mb-3 text-xs text-subtext">{t("recorder.dictation_test_shortcut", { shortcut: formatDictationShortcut(store.systemDictation.accelerator, store.systemDictation.platform) })}</p> : null}
          <Textarea autoFocus id="onboarding-dictation-test" aria-label={t("recorder.dictation_test_label")} value={text} onChange={event => setText(event.currentTarget.value)} disabled={dictation.active} placeholder={t("recorder.dictation_test_placeholder")} className="min-h-32 resize-none text-sm" />
          {dictation.active ? <ComposerDictationBar dictation={dictation} /> : <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-xs text-subtext" aria-live="polite">{text.trim() ? <Check className="size-3.5 text-success" /> : null}{t(text.trim() ? "onboarding_audio.test_result" : "onboarding_audio.test_private")}</p>
            <Button size="sm" variant="outline" disabled={!props.demo && (dictation.blocked || !dictation.supported)} onClick={() => {
              if (props.demo) setText(current => appendDictatedText(current, t("onboarding_audio.test_sample")));
              else void dictation.start();
            }}><Mic className="size-3.5" />{t("onboarding_audio.try_dictation")}</Button>
          </div>}
          {dictation.error ? <p role="alert" className="mt-3 text-xs text-destructive">{dictation.error}</p> : null}
        </div>}
        {!props.demo && (props.feature === "meetings" ? store.meeting?.error || store.error : store.systemDictation?.error || store.error) ? <p role="alert" className="mt-3 text-xs text-destructive">{props.feature === "meetings" ? store.meeting?.error || store.error : store.systemDictation?.error || store.error}</p> : null}
      </div>
    </div>
    <div className="flex items-center justify-between gap-3 border-t border-dls-border px-7 py-4 sm:px-8">
      <Button variant="ghost" size="sm" disabled={busy} onClick={isPractice ? () => setPractice(false) : previousConfiguration >= 0 ? () => setCurrentStep(previousConfiguration) : props.onClose}>{t(isPractice || previousConfiguration >= 0 ? "onboarding.back" : "onboarding_audio.finish_later")}</Button>
      {requirement?.configure && !requirement.downloading ? <Button size="sm" disabled={busy || !requirement.configure.canContinue} onClick={() => void continueConfiguration()}>
        {changing ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {requirement.configure.label ?? t("onboarding.continue")}
      </Button> : null}
      {requirement?.downloading ? <Button size="sm" disabled={busy} onClick={props.onClose}>{t("onboarding_audio.continue_background")}</Button> : null}
      {!requirement ? <Button size="sm" disabled={busy || (!props.demo && props.feature === "dictation" && !store.systemDictation)} onClick={props.feature === "meetings" ? () => void finishMeetingSetup() : !isPractice ? () => void enableAndTry() : props.onClose}>
        {changing ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t(props.feature === "dictation" && !isPractice ? props.enabled ? "onboarding_audio.try_dictation" : "onboarding_audio.enable_and_try" : "recorder.setup_done_cta")}
      </Button> : null}
    </div>
  </div>;
}
