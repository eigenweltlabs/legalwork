/** @jsxImportSource react */
/**
 * Recorder main pane — local audio recording + on-device transcription.
 * Rendered in the session shell's main view (sidebar stays), like Evals.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileAudio,
  FileText,
  FolderInput,
  FolderOpen,
  Globe2,
  HardDrive,
  Link2,
  Unlink,
  MoreHorizontal,
  Loader2,
  Mic,
  MonitorSpeaker,
  Pause,
  Pencil,
  Play,
  Settings2,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import "./recorder-pane.css";
import { currentLocale, t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import type { AudioRecordingMeta } from "@legalwork/types/audio";

import { ModelTierSelect } from "./model-tier-select";
import { PermissionsPanel } from "./permissions-panel";
import {
  RecorderSetup,
  markRecorderSetupDismissed,
  recorderSetupDemoEnabled,
  recorderSetupDismissed,
  recorderSetupStatus,
} from "./recorder-setup";
import { revealRecording, useRecorderStore } from "./recorder-store";
import { closeRecordingTranscriptTabs, requestRecordingTranscript } from "./recording-transcript-tabs";

/** Shared surface for capture controls and inline progress. */
function SectionCard(props: { className?: string; children: React.ReactNode }) {
  return (
    <Surface
      className={cn(
        "flex flex-col gap-4 p-4",
        props.className,
      )}
    >
      {props.children}
    </Surface>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Recordings list page size — paginated so a long history stays manageable. */
const RECORDINGS_PER_PAGE = 8;

/** Persisted flag: the "Dictate anywhere" intro was dismissed via its ✕. */
const DICTATE_INFO_DISMISSED_KEY = "legalwork.recorder.dictateInfoDismissed";

function RecordingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{formatDuration(now - startedAt)}</span>;
}

function SourceToggle(props: {
  active: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onToggle: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const button = (
    <Button
      variant="outline"
      aria-pressed={props.active}
      size="sm"
      disabled={props.disabled}
      onClick={props.onToggle}
      className={cn("gap-2", props.active && "bg-muted text-foreground border-foreground/20")}
    >
      {props.icon}
      {props.label}
      {props.active ? <Check className="size-3.5" /> : null}
    </Button>
  );
  if (!props.disabled || !props.disabledHint) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipContent>{props.disabledHint}</TooltipContent>
    </Tooltip>
  );
}


/** URL served by the main-process `lw-recording://` protocol (streams audio.webm). */
function recordingAudioSrc(recordingId: string): string {
  return `lw-recording://audio/${encodeURIComponent(recordingId)}`;
}

// Only one recording plays at a time: whichever <audio> starts pauses the
// previously playing one (row buttons and the modal player all share this).
let activeRecordingAudio: HTMLAudioElement | null = null;
function claimRecordingAudio(el: HTMLAudioElement) {
  if (activeRecordingAudio && activeRecordingAudio !== el) activeRecordingAudio.pause();
  activeRecordingAudio = el;
}

/**
 * MediaRecorder writes the webm with no duration in its header (it's unknown
 * while streaming), so <audio>.duration reads Infinity and the scrubber pins to
 * the far right. Force the browser to compute the real duration by seeking past
 * the end once, then snap back to the start.
 */
function fixInfiniteDuration(el: HTMLAudioElement) {
  if (el.duration !== Infinity) return;
  const onDurationChange = () => {
    if (el.duration === Infinity || Number.isNaN(el.duration)) return;
    el.removeEventListener("durationchange", onDurationChange);
    el.currentTime = 0;
  };
  el.addEventListener("durationchange", onDurationChange);
  el.currentTime = 1e101;
}

/**
 * Play a finished recording in place. The <audio> element loads the
 * `lw-recording://` URL natively, so play() stays inside the click gesture
 * (first play works) and the file streams with seeking. `compact` (list rows)
 * renders a single play/pause button; otherwise the native player with its
 * scrubber + time (transcript modal).
 */
function RecordingPlayer(props: { recordingId: string; compact?: boolean }) {
  const src = recordingAudioSrc(props.recordingId);

  if (!props.compact) {
    return (
      <audio
        src={src}
        controls
        preload="metadata"
        className="h-9 w-full min-w-0"
        onLoadedMetadata={(event) => fixInfiniteDuration(event.currentTarget)}
        onPlay={(event) => claimRecordingAudio(event.currentTarget)}
      />
    );
  }

  return <RecordingPlayButton src={src} />;
}

function RecordingPlayButton(props: { src: string }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  return (
    <span className="inline-flex">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={playing ? t("recorder.pause") : t("recorder.play")}
        title={playing ? t("recorder.pause") : t("recorder.play")}
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <audio
        ref={audioRef}
        src={props.src}
        preload="none"
        className="hidden"
        onPlay={(event) => {
          claimRecordingAudio(event.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </span>
  );
}

export type RecorderWorkspaceTarget = { id: string; name: string; path: string };

export function RecordingRow(props: {
  recording: AudioRecordingMeta;
  workspaceTargets: RecorderWorkspaceTarget[];
  onOpen: () => void;
  onUnlink?: () => void;
  busy?: boolean;
}) {
  const store = useRecorderStore();
  const { recording } = props;
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(recording.title);

  const commitRename = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== recording.title) void store.renameRecording(recording.id, next);
  };
  const rename = () => { setDraft(recording.title); setEditing(true); };
  const remove = () => props.onUnlink ? props.onUnlink() : void store.deleteRecording(recording.id).then(() => closeRecordingTranscriptTabs(recording.id));

  return (
    <ContextMenu disabled={editing}>
    <ContextMenuTrigger onContextMenu={(event) => event.stopPropagation()} render={<div className="lw-recorder-row" />}>
      <RecordingPlayer recordingId={recording.id} compact />
      {editing ? (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  setDraft(recording.title);
                  setEditing(false);
                }
              }}
              className="h-7 max-w-xs text-sm"
            />
          </div>
        </div>
      ) : (
        <button type="button" className="lw-recorder-row-open min-w-0 flex-1 text-left" onClick={props.onOpen}>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{recording.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-subtext">
            <span>{new Date(recording.createdAt).toLocaleDateString(currentLocale(), { dateStyle: "medium" })}</span>
            <span className="tabular-nums">{new Date(recording.createdAt).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="tabular-nums">{formatDuration(recording.durationMs)}</span>
          </div>
          {savedTo ? (
            <div className="mt-1 truncate text-xs text-success">
              {t("recorder.saved_to_workspace")}: {savedTo}
            </div>
          ) : null}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-1">
        {props.workspaceTargets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("recorder.link_projects")} title={t("recorder.link_projects")}><Link2 /></Button>} />
            <DropdownMenuContent align="end">
              {props.workspaceTargets.map((target) => <DropdownMenuCheckboxItem key={target.id} checked={recording.projectIds?.includes(target.id) ?? false} onCheckedChange={(linked) => {
                void store.setRecordingProject(recording.id, target.id, linked).catch((error: unknown) => toast.error(t("recorder.link_failed"), { description: error instanceof Error ? error.message : undefined }));
              }}>{target.name}</DropdownMenuCheckboxItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {props.workspaceTargets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={t("recorder.save_to_workspace")} title={t("recorder.save_to_workspace")}>
                  <FolderInput />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {props.workspaceTargets.map((target) => (
                <DropdownMenuItem
                  key={target.id}
                  onClick={() =>
                    void store
                      .saveRecordingToWorkspace(recording.id, target.path)
                      .then((folder) => setSavedTo(folder))
                  }
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">{target.name}</div>
                    <div className="truncate text-xs text-subtext">{target.path}</div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("recorder.recording_actions")}><MoreHorizontal /></Button>} />
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={props.busy} onClick={rename}><Pencil />{t("recorder.rename")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void revealRecording(recording)}><FolderOpen />{t("recorder.reveal")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={props.busy} onClick={remove}>{props.onUnlink ? <Unlink /> : <Trash2 />}{t(props.onUnlink ? "recorder.unlink_project" : "recorder.delete_recording")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuItem onClick={props.onOpen}><FileAudio />{t("projects.open")}</ContextMenuItem>
      <ContextMenuItem disabled={props.busy} onClick={rename}><Pencil />{t("recorder.rename")}</ContextMenuItem>
      <ContextMenuItem onClick={() => { void revealRecording(recording); }}><FolderOpen />{t("recorder.reveal")}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={props.busy} onClick={remove}>
        {props.onUnlink ? <Unlink /> : <Trash2 />}{t(props.onUnlink ? "recorder.unlink_project" : "recorder.delete_recording")}
      </ContextMenuItem>
    </ContextMenuContent>
    </ContextMenu>
  );
}

export function RecorderPane(props: {
  workspacePath: string | null;
  workspaceId?: string;
  project?: { id: string; name: string } | null;
  /** Local workspaces offered as save targets (selected workspace first). */
  workspaceTargets?: RecorderWorkspaceTarget[];
}) {
  const store = useRecorderStore();
  const [title, setTitle] = useState("");
  const titleInputId = useId();
  const [dragActive, setDragActive] = useState(false);
  const [recordingsPage, setRecordingsPage] = useState(0);
  const [dictateInfoDismissed, setDictateInfoDismissed] = useState(() => {
    try {
      return localStorage.getItem(DICTATE_INFO_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [setupDismissed, setSetupDismissed] = useState(() => recorderSetupDismissed());
  const [setupDemo, setSetupDemo] = useState(() => recorderSetupDemoEnabled());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const dismissDictateInfo = () => {
    setDictateInfoDismissed(true);
    try {
      localStorage.setItem(DICTATE_INFO_DISMISSED_KEY, "1");
    } catch {
      // storage unavailable — dismiss for this session only
    }
  };

  useEffect(() => {
    void store.init();
    // The store is module-scoped; init is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = store.bootstrap?.models ?? [];
  const installedModels = useMemo(() => models.filter((model) => model.state === "installed"), [models]);
  const engine = store.bootstrap?.engine;
  // Dictation shares capture with Recorder, but its temporary audio must not
  // appear as a meeting recording. Keep capture controls locked for either.
  const isCaptureBusy = Boolean(store.recording) || store.dictationState === "starting";
  const isRecording = Boolean(
    store.recording && !store.recording.ephemeral && store.recording.id !== store.dictationRecordingId,
  );
  const selectedInstalled = installedModels.some((model) => model.id === store.modelId);
  const canRecord = !isCaptureBusy && !store.starting && !store.importing && selectedInstalled && engine?.available !== false;
  const isDesktop = Boolean(window.__LEGALWORK_ELECTRON__?.invokeDesktop);
  const showDictateInfo = store.systemDictation?.enabled === false && !dictateInfoDismissed;

  // First-run guided setup: permissions + model, in order. Once everything is
  // already satisfied, persist the dismissal so future opens never even flash
  // the loading gate.
  const setupStatus = recorderSetupStatus(store.permissions, store.bootstrap);
  useEffect(() => {
    if (!setupDismissed && setupStatus === "done" && !setupDemo) {
      markRecorderSetupDismissed();
      setSetupDismissed(true);
    }
  }, [setupStatus, setupDismissed, setupDemo]);
  const showSetup = isDesktop && !isCaptureBusy && (setupDemo || (!setupDismissed && setupStatus !== "done"));

  // Save targets: every local workspace (selected first, provided by the
  // shell); older callers that only pass workspacePath still get one target.
  const saveTargets = useMemo<RecorderWorkspaceTarget[]>(() => {
    if (props.workspaceTargets?.length) return props.workspaceTargets;
    if (props.workspacePath) {
      return [{ id: "current", name: t("recorder.save_to_workspace"), path: props.workspacePath }];
    }
    return [];
  }, [props.workspaceTargets, props.workspacePath]);

  // Client-side pagination for the recordings history — the whole list is in
  // memory, but rendering hundreds of rows (and their dropdowns) is wasteful.
  const recordingsCount = store.recordings.length;
  const recordingsPageCount = Math.max(1, Math.ceil(recordingsCount / RECORDINGS_PER_PAGE));
  const recordingsCurrentPage = Math.min(recordingsPage, recordingsPageCount - 1);
  const pagedRecordings = useMemo(
    () =>
      store.recordings.slice(
        recordingsCurrentPage * RECORDINGS_PER_PAGE,
        recordingsCurrentPage * RECORDINGS_PER_PAGE + RECORDINGS_PER_PAGE,
      ),
    [store.recordings, recordingsCurrentPage],
  );

  const importing = store.importing;
  const canImport = !isCaptureBusy && !store.starting && !importing && selectedInstalled && engine?.available !== false;
  const pickAudioFile = (list: FileList | null): File | null => {
    if (!list) return null;
    return (
      Array.from(list).find(
        (file) =>
          file.type.startsWith("audio/") ||
          file.type.startsWith("video/") ||
          /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|webm|mp4|mov|caf|aif|aiff|wma|3gp)$/i.test(file.name),
      ) ?? null
    );
  };
  const handleImportFiles = (list: FileList | null) => {
    if (!canImport) return;
    const file = pickAudioFile(list);
    if (file) void store.importAudioFile(file);
  };

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <SectionCard className="max-w-md">
          <h3 className="text-sm font-medium text-ink">{t("recorder.desktop_required_title")}</h3>
          <p className="text-sm text-subtext">{t("recorder.desktop_required_body")}</p>
        </SectionCard>
      </div>
    );
  }

  if (showSetup) {
    return (
      <div className="@container/page h-full w-full overflow-y-auto">
        {setupStatus === "loading" && !setupDemo ? null : (
          <RecorderSetup
            demo={setupDemo}
            onFinished={() => {
              setSetupDismissed(true);
              setSetupDemo(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="lw-recorder relative h-full w-full overflow-y-auto"
      onDragOver={(event) => {
        if (!canImport) return;
        event.preventDefault();
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        handleImportFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*,.m4a,.caf,.opus"
        className="hidden"
        onChange={(event) => {
          handleImportFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {dragActive ? (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand/60 bg-brand/5 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-2 text-brand">
            <FileAudio className="size-8" />
            <span className="text-sm font-medium">{t("recorder.import_drop_hint")}</span>
          </div>
        </div>
      ) : null}
      <div className="lw-recorder-content relative z-10 mx-auto w-full">
        <SectionHeading
          size="page"
          title={t("recorder.workspace_title")}
          description={props.project ? t("recorder.for_project", { name: props.project.name }) : t("recorder.workspace_description")}
          action={<div className="lw-recorder-header-actions">
            <Button variant="outline" size="sm" disabled={!canImport} onClick={() => fileInputRef.current?.click()}><Upload data-icon="inline-start" />{t("recorder.import_file")}</Button>
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("recorder.manage_models")} onClick={() => navigate("/settings/recorder")}><Settings2 /></Button>} />
              <TooltipContent>{t("recorder.manage_models")}</TooltipContent>
            </Tooltip>
          </div>}
        />

        {importing ? (
          <SectionCard className="mt-4 flex-row items-center gap-3">
            <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-ink">
                {t("recorder.import_transcribing")} {importing.fileName}
              </div>
              <div className="text-xs text-subtext">{t("recorder.import_transcribing_hint")}</div>
            </div>
          </SectionCard>
        ) : null}

        {store.diarizing ? (
          <SectionCard className="mt-4 flex-row items-center gap-3">
            <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
            <div className="truncate text-sm font-medium text-ink">
              {t("recorder.diarize_identifying")}
            </div>
          </SectionCard>
        ) : null}

        <PermissionsPanel />

        {store.error ? (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            <span className="whitespace-pre-wrap break-words">{store.error}</span>
            <Button variant="ghost" size="icon-sm" aria-label={t("recorder.dismiss")} onClick={store.clearError}>
              <X />
            </Button>
          </div>
        ) : null}

        {engine && !engine.available ? (
          <div className="mt-4 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            {t("recorder.engine_unavailable")} {engine.error ?? ""}
          </div>
        ) : null}

        {store.transcriber.state === "error" && store.transcriber.error ? (
          <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("recorder.transcriber_error")} {store.transcriber.error}
          </div>
        ) : null}

        {showDictateInfo ? (
          <div className="mt-5 flex flex-wrap items-start justify-between gap-3 rounded-xl bg-muted/40 p-4">
            <div className="flex min-w-0 flex-1 basis-80 items-start gap-3">
              <Globe2 className="mt-0.5 size-5 shrink-0 text-brand" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium text-ink">{t("recorder.dictation_title")}</h2>
                  <span className="text-xs font-medium text-subtext">
                    {t("recorder.dictation_off")}
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-sm text-subtext">
                  {t("recorder.dictation_pane_description")}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/recorder?tab=dictation")}>
                <Settings2 data-icon="inline-start" />
                {t("recorder.dictation_configure")}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("recorder.dismiss")}
                title={t("recorder.dismiss")}
                onClick={dismissDictateInfo}
              >
                <X />
              </Button>
            </div>
          </div>
        ) : null}

        <SectionCard className="lw-recorder-capture">
          <div className="lw-recorder-title-row">
            <div className="min-w-0 flex-1">
              <label htmlFor={titleInputId} className="lw-recorder-field-label">{t("recorder.recording_title_label")}</label>
              <Input id={titleInputId} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder={t("recorder.title_placeholder")} disabled={isCaptureBusy || store.starting} />
            </div>
            {isRecording ? (
              <Button disabled={store.finalizing} onClick={() => void store.stopRecording()}>
                {store.finalizing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Square data-icon="inline-start" />}
                {t(store.finalizing ? "recorder.finishing" : "recorder.stop")}
              </Button>
            ) : (
              <Button disabled={!canRecord} onClick={() => void store.startRecording(title || undefined, { projectId: props.project?.id })}>
                {store.starting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Mic data-icon="inline-start" />}
                {t(store.starting ? "recorder.starting_recording" : "recorder.record")}
              </Button>
            )}
          </div>
          <div className="lw-recorder-options">
            <fieldset className="lw-recorder-source-field">
              <legend className="lw-recorder-field-label">{t("recorder.audio_sources")}</legend>
              <div className="lw-recorder-sources">
                <SourceToggle active={store.sources.includes("microphone")} disabled={isCaptureBusy || store.starting} onToggle={() => store.toggleSource("microphone")} icon={<Mic />} label={t("recorder.source_microphone")} />
                <SourceToggle active={store.sources.includes("system")} disabled={isCaptureBusy || store.starting || store.bootstrap?.capabilities.systemAudio === false} disabledHint={t("recorder.source_system_unavailable")} onToggle={() => store.toggleSource("system")} icon={<MonitorSpeaker />} label={t("recorder.source_system")} />
              </div>
            </fieldset>
            <div>
              <div className="lw-recorder-field-label">{t("settings.language")}</div>
              <Select value={store.language} items={[{ value: "auto", label: t("recorder.language_auto") }, { value: "en", label: "English" }, { value: "de", label: "Deutsch" }]} onValueChange={(value) => {
                if (value === "auto" || value === "en" || value === "de") store.setLanguage(value);
              }} disabled={isCaptureBusy || store.starting}>
                <SelectTrigger size="sm" aria-label={t("settings.language")} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="auto">{t("recorder.language_auto")}</SelectItem><SelectItem value="en">English</SelectItem><SelectItem value="de">Deutsch</SelectItem></SelectContent>
              </Select>
            </div>
            <div role="group" aria-label={t("recorder.model_select_label")} className="lw-recorder-model-field">
              <div className="lw-recorder-field-label">{t("recorder.model_select_label")}</div>
              <ModelTierSelect disabled={isCaptureBusy || store.starting} />
            </div>
          </div>
          {!selectedInstalled && !isCaptureBusy ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm text-foreground">
              <HardDrive className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">{t("recorder.model_required_hint")}</span>
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/recorder")}>{t("recorder.model_required_cta")}</Button>
            </div>
          ) : null}
          {isRecording ? (
            <div className="lw-recorder-live">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium" role="status">
                  {store.finalizing ? <Loader2 className="size-3.5 animate-spin" /> : <span className="lw-recorder-recording-dot" aria-hidden="true" />}
                  {t(store.finalizing ? "recorder.finishing" : "recorder.recording_in_progress")}
                </div>
                {store.recordingStartedAt ? <div className="lw-recorder-time"><RecordingTimer startedAt={store.recordingStartedAt} /></div> : null}
                {store.transcriber.state === "loading" ? <p className="text-xs text-muted-foreground">{t("recorder.loading_model")}</p> : null}
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => { if (store.recording) requestRecordingTranscript(store.recording, props.project?.id ?? props.workspaceId); }}><FileText />{t("recorder.open_transcript")}</Button>
              </div>
              {!store.finalizing ? <div className="lw-recorder-levels">
                {store.sources.map((source) => {
                  const label = t(source === "microphone" ? "recorder.source_microphone" : source === "system" ? "recorder.source_system" : "recorder.source_app");
                  const level = Math.max(0, Math.min(1, store.levels[source] ?? 0));
                  return (
                    <div key={source} className="lw-recorder-source-level">
                      <span>{label}</span>
                      <div
                        className="lw-recorder-level-track"
                        role="meter"
                        aria-label={t("recorder.source_level", { source: label })}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(level * 100)}
                      >
                        <span style={{ transform: `scaleX(${level})` }} />
                      </div>
                    </div>
                  );
                })}
              </div> : null}
            </div>
          ) : null}
        </SectionCard>

        {/* Recordings */}
        <section className="lw-recorder-library">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-foreground">{t("recorder.recordings_title")}</h2>
              <p className="mt-0.5 text-xs text-subtext">
                {t("recorder.recordings_local")}
              </p>
            </div>
            {recordingsCount > 0 ? (
              <span className="shrink-0 pt-0.5 text-xs tabular-nums text-subtext">
                {recordingsCount} {t("recorder.recordings_count_label")}
              </span>
            ) : null}
          </div>
          <div className="lw-recorder-list">
            {recordingsCount === 0 ? (
              <div className="lw-recorder-empty"><FileAudio className="size-6 text-muted-foreground" aria-hidden="true" /><p className="text-sm font-medium">{t("recorder.recordings_empty")}</p><p className="text-sm text-muted-foreground">{t("recorder.recordings_empty_hint")}</p></div>
            ) : (
              pagedRecordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  workspaceTargets={saveTargets}
                  onOpen={() => requestRecordingTranscript(recording, props.project?.id ?? props.workspaceId)}
                />
              ))
            )}
          </div>
          {recordingsPageCount > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("recorder.page_prev")}
                disabled={recordingsCurrentPage === 0}
                onClick={() => setRecordingsPage(Math.max(0, recordingsCurrentPage - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs tabular-nums text-subtext">
                {recordingsCurrentPage + 1} / {recordingsPageCount}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("recorder.page_next")}
                disabled={recordingsCurrentPage >= recordingsPageCount - 1}
                onClick={() => setRecordingsPage(Math.min(recordingsPageCount - 1, recordingsCurrentPage + 1))}
              >
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </section>
      </div>


    </div>
  );
}
