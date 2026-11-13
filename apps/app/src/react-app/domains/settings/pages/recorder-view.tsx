/** @jsxImportSource react */
/**
 * Settings → Recorder: local speech-to-text models (download, detect on
 * disk, import) and transcription defaults. The Recorder tab itself stays
 * lean — just record.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HardDrive, Keyboard, Languages, Mic, ShieldCheck, Video } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { desktopLoginItemGet, desktopLoginItemSet } from "@/app/lib/desktop";
import type { HideAppMode } from "@/react-app/kernel/local-provider";
import { t } from "../../../../i18n";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";
import { ModelManagerList } from "../../recorder/model-manager";
import { formatDictationShortcut } from "../../recorder/dictation-shortcut";
import { useRecorderStore, isTranscriptionReady } from "../../recorder/recorder-store";
import { HubTabs } from "../segmented-tabs";
import { DictationReadinessGate } from "./dictation-readiness";
import { DictationSetupDialog } from "./dictation-setup-dialog";
import { DictationMicrophoneSetting } from "./dictation-microphone-setting";

export function RecorderSettingsView(props: {
  busy: boolean;
  hideAppMode: HideAppMode;
  onChangeHideAppMode: (mode: HideAppMode) => void;
}) {
  const store = useRecorderStore();
  const [searchParams] = useSearchParams();
  // Callers deep-link the tab: "Dictate anywhere" opens ?tab=dictation, model
  // entries default to the models tab.
  const [tab, setTab] = useState<"models" | "dictation" | "meetings">(
    searchParams.get("tab") === "dictation" ? "dictation" : searchParams.get("tab") === "meetings" ? "meetings" : "models",
  );
  useEffect(() => {
    const requested = searchParams.get("tab");
    if (requested === "dictation" || requested === "models" || requested === "meetings") setTab(requested);
  }, [searchParams]);
  const [changingAppearance, setChangingAppearance] = useState(false);
  const [changingDictation, setChangingDictation] = useState(false);
  const [changingMeetingDetection, setChangingMeetingDetection] = useState(false);
  const [dictationSetupOpen, setDictationSetupOpen] = useState(false);
  const [loginItem, setLoginItem] = useState<{ openAtLogin: boolean; requiresApproval: boolean } | null>(null);
  const [changingLoginItem, setChangingLoginItem] = useState(false);
  const engine = store.bootstrap?.engine;
  const selectedModelInstalled = isTranscriptionReady(store);
  const dictation = store.systemDictation;
  const cloudRegion = store.bootstrap?.cloud?.models.find(model => model.model === store.cloudModelId)?.region;
  const notesModels = (store.bootstrap?.cloud?.summaryModels ?? []).filter(model => model.region === cloudRegion);
  const defaultNotesModel = notesModels.find(model => model.model === (cloudRegion ? store.bootstrap?.cloud?.defaultSummaryModels?.[cloudRegion] : undefined));
  const defaultNotesLabel = defaultNotesModel ? t("recorder.meeting_notes_model_default_named", { model: defaultNotesModel.name }) : t("recorder.meeting_notes_model_auto");

  useEffect(() => {
    void store.init();
    void desktopLoginItemGet()
      .then(setLoginItem)
      .catch(() => setLoginItem(null));
    const onFocus = () => {
      void store.refreshBootstrap();
      void store.refreshSystemDictation();
      void store.refreshPermissions();
      void store.refreshDictationMicrophones();
      void store.refreshMeeting();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // The recorder store is module-scoped and init is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setOpenAtLogin = (openAtLogin: boolean) => {
    setChangingLoginItem(true);
    void desktopLoginItemSet(openAtLogin)
      .then(setLoginItem)
      .catch(() => {})
      .finally(() => setChangingLoginItem(false));
  };

  return (
    <LayoutStack>
      <HubTabs
        value={tab}
        onChange={setTab}
        items={[
          { id: "models", label: t("recorder.models_tab"), icon: HardDrive },
          { id: "dictation", label: t("recorder.dictation_tab"), icon: Keyboard },
          { id: "meetings", label: t("recorder.meetings_tab"), icon: Video },
        ]}
      />

      {tab === "models" ? (
        <>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <div>
                <LayoutSectionItemTitle>{t("recorder.models_title")}</LayoutSectionItemTitle>
                <LayoutSectionItemDescription>{t("recorder.models_subtitle")}</LayoutSectionItemDescription>
              </div>
              <LayoutSectionItemHeaderActions>
                <div className="flex items-center gap-2">
                  <Languages className="size-4 text-subtext" />
                  <Select
                    value={store.language}
                    items={[
                      { value: "auto", label: t("recorder.language_auto") },
                      { value: "en", label: "English" },
                      { value: "de", label: "Deutsch" },
                    ]}
                    onValueChange={(value) => {
                      if (value === "auto" || value === "en" || value === "de") store.setLanguage(value);
                    }}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start" className="w-auto min-w-(--anchor-width)">
                      <SelectItem value="auto">{t("recorder.language_auto")}</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="de">Deutsch</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
            {engine && !engine.available ? (
              <div className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
                {t("recorder.engine_unavailable")} {engine.error ?? ""}
              </div>
            ) : null}
            <ModelManagerList />
          </LayoutSectionItem>
        </>
      ) : tab === "meetings" ? (
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <div>
              <LayoutSectionItemTitle>{t("recorder.meetings_title")}</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>{t("recorder.meetings_description")}</LayoutSectionItemDescription>
            </div>
            <LayoutSectionItemHeaderActions>
              <Button
                variant="outline"
                size="sm"
                disabled={!selectedModelInstalled || store.finalizing || store.meeting?.state === "starting" || Boolean(store.dictationRecordingId)}
                onClick={() => { void (store.recording ? store.stopRecording() : store.startMeetingRecording()); }}
              >
                {store.recording ? t("recorder.meeting_stop") : t("recorder.meeting_start")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
          <div className="flex items-center justify-between gap-4 border-t border-subtle pt-4">
            <div>
              <div className="text-xs font-medium text-ink">{t("recorder.meeting_detection_title")}</div>
              <div className="mt-1 text-sm text-subtext">{t("recorder.meeting_detection_description")}</div>
            </div>
            <Switch
              aria-label={t("recorder.meeting_detection_title")}
              checked={store.meeting?.detectionEnabled === true}
              disabled={!store.meeting || changingMeetingDetection}
              onCheckedChange={(enabled) => {
                setChangingMeetingDetection(true);
                void store.setMeetingDetection(enabled).finally(() => setChangingMeetingDetection(false));
              }}
            />
          </div>
          <p className="text-xs text-subtext">{t("recorder.meeting_detection_support")}</p>
          <p className="text-xs text-subtext">{t("recorder.meeting_recording_location")}</p>
          {store.transcriptionSource === "cloud" ? <div className="space-y-4 border-t border-subtle pt-4">
            <div>
              <label className="flex items-center justify-between gap-4 text-sm">
                {t("recorder.meeting_notes_title")}
                <Switch checked={store.meetingNotes.enabled} onCheckedChange={enabled => store.setMeetingNotes({ enabled })}
                  aria-label={t("recorder.meeting_notes_title")} />
              </label>
              <p className="mt-1 text-sm text-subtext">{t("recorder.meeting_notes_description")}</p>
            </div>
            {store.meetingNotes.enabled ? <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">{t("recorder.meeting_notes_model")}</span>
                <Select value={store.meetingNotes.model || "auto"}
                  items={[{ value: "auto", label: defaultNotesLabel }, ...notesModels.map(model => ({ value: model.model, label: model.name }))]}
                  onValueChange={model => { if (model) store.setMeetingNotes({ model: model === "auto" ? "" : model }); }}>
                  <SelectTrigger size="sm" aria-label={t("recorder.meeting_notes_model")}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="auto">{defaultNotesLabel}</SelectItem>
                    {notesModels.map(model => <SelectItem key={model.model} value={model.model}>{model.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {notesModels.length === 0 ? <p className="text-xs text-subtext">{t("recorder.meeting_notes_no_model")}</p> : null}
              {notesModels.length > 0 && !store.meetingNotes.model && !defaultNotesModel ? <p className="text-xs text-subtext">{t("recorder.meeting_notes_default_unavailable")}</p> : null}
              <label className="block space-y-2 text-sm">
                <span>{t("recorder.meeting_notes_instructions")}</span>
                <Textarea value={store.meetingNotes.instructions} maxLength={1000} rows={3}
                  placeholder={t("recorder.meeting_notes_placeholder")}
                  onChange={event => store.setMeetingNotes({ instructions: event.target.value })} />
              </label>
            </> : null}
          </div> : null}
          <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-ink">{t("settings.hide_app_title")}</div>
              <div className="mt-1 text-sm text-subtext">{t("settings.hide_app_desc")}</div>
            </div>
            <Select
              value={props.hideAppMode}
              items={[
                { value: "never", label: t("settings.hide_app_never") },
                { value: "recording", label: t("settings.hide_app_recording") },
                { value: "always", label: t("settings.hide_app_always") },
              ]}
              onValueChange={(value) => {
                if (value === "never" || value === "recording" || value === "always") props.onChangeHideAppMode(value);
              }}
              disabled={props.busy}
            >
              <SelectTrigger size="sm" className="w-[200px] shrink-0" aria-label={t("settings.hide_app_title")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">{t("settings.hide_app_never")}</SelectItem>
                <SelectItem value="recording">{t("settings.hide_app_recording")}</SelectItem>
                <SelectItem value="always">{t("settings.hide_app_always")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </LayoutSectionItem>
      ) : (
        <DictationReadinessGate>
          <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <div>
            <LayoutSectionItemTitle>{t("recorder.dictation_title")}</LayoutSectionItemTitle>
            {store.transcriptionSource === "cloud" ? <p className="mt-1 text-sm text-subtext">{t("recorder.dictation_smart")}</p> : null}
            <LayoutSectionItemDescription>
              {t("recorder.dictation_description")}
            </LayoutSectionItemDescription>
          </div>
          <LayoutSectionItemHeaderActions>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-subtext">
                {dictation?.enabled ? t("recorder.dictation_on") : t("recorder.dictation_off")}
              </span>
              <Switch
                aria-label={t("recorder.dictation_title")}
                checked={dictation?.enabled === true}
                disabled={!dictation || changingDictation || !selectedModelInstalled}
                onCheckedChange={(checked) => {
                  setChangingDictation(true);
                  void store.setSystemDictationEnabled(checked).finally(() => setChangingDictation(false));
                }}
              />
            </div>
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>

        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-medium text-ink">
              {t("recorder.dictation_shortcut_setting")}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-subtext">
              <Keyboard className="size-4" />
              {dictation ? formatDictationShortcut(dictation.accelerator, dictation.platform) : ""}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!dictation}
            onClick={() => setDictationSetupOpen(true)}
          >
            {t("recorder.dictation_configure")}
          </Button>
        </div>

        <DictationSetupDialog open={dictationSetupOpen} onOpenChange={setDictationSetupOpen} />
        <DictationMicrophoneSetting />

        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-medium text-ink">{t("recorder.overlay_color")}</div>
            <div className="mt-1 text-sm text-subtext">{t("recorder.overlay_color_description")}</div>
          </div>
          <Select
            value={dictation?.appearance ?? "app"}
            items={[
              { value: "app", label: t("recorder.overlay_color_app") },
              { value: "white", label: t("recorder.overlay_color_white") },
              { value: "black", label: t("recorder.overlay_color_black") },
            ]}
            disabled={!dictation || changingAppearance}
            onValueChange={(value) => {
              if (value !== "app" && value !== "white" && value !== "black") return;
              setChangingAppearance(true);
              void store.setDictationAppearance(value).finally(() => setChangingAppearance(false));
            }}
          >
            <SelectTrigger size="sm" className="w-[200px] shrink-0" aria-label={t("recorder.overlay_color")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="app">{t("recorder.overlay_color_app")}</SelectItem>
              <SelectItem value="white">{t("recorder.overlay_color_white")}</SelectItem>
              <SelectItem value="black">{t("recorder.overlay_color_black")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loginItem !== null ? (
          <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-medium text-ink">
                {t("recorder.dictation_login_title")}
              </div>
              <div className="mt-1 text-sm text-subtext">
                {loginItem.requiresApproval
                  ? t("recorder.dictation_login_requires_approval")
                  : t("recorder.dictation_login_description")}
              </div>
            </div>
            <Switch
              aria-label={t("recorder.dictation_login_title")}
              checked={loginItem.openAtLogin}
              disabled={changingLoginItem}
              onCheckedChange={setOpenAtLogin}
            />
          </div>
        ) : null}

        <div className="grid gap-4 border-t border-subtle pt-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <ol className="space-y-3 text-sm text-ink">
            <li className="flex gap-3">
              <Languages className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_model_title")}</strong>{" "}
                <span className="text-subtext">{t("recorder.dictation_step_model_body")}</span>
              </span>
            </li>
            <li className="flex gap-3">
              <Mic className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_permission_title")}</strong>{" "}
                <span className="text-subtext">
                  {dictation?.platform === "darwin"
                    ? t("recorder.dictation_step_permission_mac")
                    : t("recorder.dictation_step_permission_windows")}
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Keyboard className="mt-0.5 size-4 shrink-0 text-subtext" />
              <span>
                <strong className="font-medium">{t("recorder.dictation_step_use_title")}</strong>{" "}
                <span className="text-subtext">{t("recorder.dictation_step_use_body")}</span>{" "}
                {dictation?.accelerator ? (
                  <kbd className="whitespace-nowrap rounded border border-subtle bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink">
                    {formatDictationShortcut(dictation.accelerator, dictation.platform)}
                  </kbd>
                ) : null}
              </span>
            </li>
          </ol>
          <div className="flex flex-col items-start gap-2 md:items-end">
            {dictation?.platform === "darwin" ? (
              <Button variant="outline" size="sm" onClick={() => void store.openSystemDictationSettings()}>
                <ShieldCheck data-icon="inline-start" />
                {t("recorder.dictation_open_accessibility")}
              </Button>
            ) : dictation?.platform === "windows" ? (
              <Button variant="outline" size="sm" onClick={() => void store.openSystemDictationSettings()}>
                <Mic data-icon="inline-start" />
                {t("recorder.dictation_open_microphone")}
              </Button>
            ) : null}
            <span className="text-xs text-subtext">
              {!selectedModelInstalled
                ? t("recorder.dictation_model_required")
                : dictation?.registered
                  ? t("recorder.dictation_ready")
                  : dictation?.error ?? t("recorder.dictation_unavailable")}
            </span>
          </div>
        </div>
          </LayoutSectionItem>
        </DictationReadinessGate>
      )}
    </LayoutStack>
  );
}
