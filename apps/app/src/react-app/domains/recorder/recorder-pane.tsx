/** @jsxImportSource react */
/**
 * Recorder main pane — local audio recording + on-device transcription.
 * Rendered in the session shell's main view (sidebar stays), like Learnings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileAudio,
  FolderInput,
  FolderOpen,
  Globe2,
  HardDrive,
  Languages,
  Loader2,
  Mic,
  MonitorSpeaker,
  Pause,
  Pencil,
  Play,
  Settings2,
  SendHorizontal,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { t } from "@/i18n";
import type { AudioRecordingMeta } from "@legalwork/types/audio";

import { formatBytes } from "../../../app/utils";
import { ModelTierSelect } from "./model-tier-select";
import { PermissionsPanel } from "./permissions-panel";
import { revealRecording, useRecorderStore } from "./recorder-store";

/**
 * Flat section card in the @legalwork/ui idiom: soft surface, hairline border,
 * rounded, and a whisper-soft shadow — matches the grouped cards used across
 * settings and the rest of the reskinned app.
 */
function SectionCard(props: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-subtle bg-surface p-4 shadow-xs",
        props.className,
      )}
    >
      {props.children}
    </div>
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
      variant={props.active ? "default" : "outline"}
      size="sm"
      disabled={props.disabled}
      onClick={props.onToggle}
      className="gap-2"
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

function RecordingRow(props: {
  recording: AudioRecordingMeta;
  workspaceTargets: RecorderWorkspaceTarget[];
  onOpen: () => void;
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

  return (
    <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface px-3 py-2.5">
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
        <button type="button" className="min-w-0 flex-1 text-left" onClick={props.onOpen}>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{recording.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-subtext">
            <span>{new Date(recording.createdAt).toLocaleString()}</span>
            <span className="tabular-nums">{formatDuration(recording.durationMs)}</span>
            <span className="tabular-nums">{formatBytes(recording.sizeBytes)}</span>
            <span>
              {recording.segmentCount} {t("recorder.segments")}
            </span>
          </div>
          {savedTo ? (
            <div className="mt-1 truncate text-xs text-success">
              {t("recorder.saved_to_workspace")}: {savedTo}
            </div>
          ) : null}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("recorder.rename")}
              onClick={() => {
                setDraft(recording.title);
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("recorder.rename")}</TooltipContent>
        </Tooltip>
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
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("recorder.reveal")}
              onClick={() => void revealRecording(recording)}
            >
              <FolderOpen />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("recorder.reveal")}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("recorder.delete_recording")}
          onClick={() => void store.deleteRecording(recording.id)}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function RecorderPane(props: {
  workspacePath: string | null;
  /** Local workspaces offered as save targets (selected workspace first). */
  workspaceTargets?: RecorderWorkspaceTarget[];
  /** Close the pane and hand the transcript to the session composer. */
  onInsertTranscript?: (text: string) => void;
}) {
  const store = useRecorderStore();
  const [title, setTitle] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [recordingsPage, setRecordingsPage] = useState(0);
  const [dictateInfoDismissed, setDictateInfoDismissed] = useState(() => {
    try {
      return localStorage.getItem(DICTATE_INFO_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
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
  const isRecording = Boolean(store.recording);
  const selectedInstalled = installedModels.some((model) => model.id === store.modelId);
  const canRecord = !isRecording && selectedInstalled && engine?.available !== false;
  const isDesktop = Boolean(window.__LEGALWORK_ELECTRON__?.invokeDesktop);
  const showDictateInfo = store.systemDictation?.enabled === false && !dictateInfoDismissed;

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
  const canImport = !isRecording && !importing && selectedInstalled && engine?.available !== false;
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

  return (
    <div
      className="relative h-full w-full overflow-y-auto"
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
      <div className="relative z-10 mx-auto w-full max-w-5xl px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="lw-section-eyebrow">{t("recorder.eyebrow")}</span>
            <h1 className="mt-2 text-3xl font-medium tracking-[-0.03em] text-ink">
              {t("recorder.title")}
            </h1>
            <p className="mt-1 max-w-lg text-sm text-subtext">{t("recorder.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={!canImport}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload data-icon="inline-start" />
              {t("recorder.import_file")}
            </Button>
            {isRecording ? (
              store.finalizing ? (
                <Button variant="destructive" disabled>
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                  {t("recorder.finishing")}
                </Button>
              ) : (
                <Button variant="destructive" onClick={() => void store.stopRecording()}>
                  <Square data-icon="inline-start" />
                  {t("recorder.stop")}
                </Button>
              )
            ) : (
              <Button
                disabled={!canRecord}
                onClick={() => void store.startRecording(title || undefined)}
                className="gap-2 bg-danger text-white hover:bg-danger/90"
              >
                <span className="size-2.5 shrink-0 rounded-full bg-white" aria-hidden />
                <Mic className="size-4 text-white" />
                {t("recorder.record")}
              </Button>
            )}
          </div>
        </div>

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
          <div className="mt-6 flex flex-col gap-3 border-y border-subtle py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
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

        {/* Setup */}
        <SectionCard className="mt-4">
          <h3 className="text-sm font-medium text-ink">{t("recorder.setup_title")}</h3>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <SourceToggle
                active={store.sources.includes("microphone")}
                disabled={isRecording}
                onToggle={() => store.toggleSource("microphone")}
                icon={<Mic />}
                label={t("recorder.source_microphone")}
              />
              <SourceToggle
                active={store.sources.includes("system")}
                disabled={isRecording || store.bootstrap?.capabilities.systemAudio === false}
                disabledHint={t("recorder.source_system_unavailable")}
                onToggle={() => store.toggleSource("system")}
                icon={<MonitorSpeaker />}
                label={t("recorder.source_system")}
              />
            </div>
            <div className="flex items-center gap-2">
              <Languages className="size-4 text-subtext" />
              <Select
                value={store.language}
                onValueChange={(value) => {
                  if (value === "auto" || value === "en" || value === "de") store.setLanguage(value);
                }}
                disabled={isRecording}
              >
                <SelectTrigger size="sm" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("recorder.language_auto")}</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="de">Deutsch</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <HardDrive className="size-4 text-subtext" />
              <ModelTierSelect disabled={isRecording} />
              <Button variant="ghost" size="sm" onClick={() => navigate("/settings/recorder")}>
                <Settings2 data-icon="inline-start" />
                {t("recorder.manage_models")}
              </Button>
            </div>
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Pencil className="size-4 shrink-0 text-subtext" />
              <Input
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder={t("recorder.title_placeholder")}
                disabled={isRecording}
                className="h-8"
              />
            </div>
          </div>
          {!selectedInstalled && !isRecording ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-ink">
              <HardDrive className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1">{t("recorder.model_required_hint")}</span>
              <Button variant="outline" size="sm" onClick={() => navigate("/settings/recorder")}>
                {t("recorder.model_required_cta")}
              </Button>
            </div>
          ) : null}
        </SectionCard>

        {/* While recording, a slim status row replaces the old live-transcript
            card: the transcript itself lives in the workspace file (composer
            "Live call" toggle) and in the recording afterwards. */}
        {isRecording ? (
          <SectionCard className="mt-4">
            <div className="flex flex-row items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium text-ink">
                {store.finalizing ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin text-brand" />
                    {t("recorder.finishing")}
                  </>
                ) : (
                  <>
                    <span className="size-2 animate-pulse rounded-full bg-danger" />
                    {t("recorder.live_transcript")}
                    {store.transcriber.state === "loading" ? (
                      <span className="flex items-center gap-1 text-xs font-normal text-subtext">
                        <Loader2 className="size-3 animate-spin" />
                        {t("recorder.loading_model")}
                      </span>
                    ) : null}
                  </>
                )}
              </h3>
              {store.recordingStartedAt && !store.finalizing ? (
                <span className="text-sm tabular-nums text-subtext">
                  <RecordingTimer startedAt={store.recordingStartedAt} />
                </span>
              ) : null}
            </div>
          </SectionCard>
        ) : null}

        {/* Recordings */}
        <SectionCard className="mt-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-ink">{t("recorder.recordings_title")}</h3>
              <p className="mt-0.5 text-xs text-subtext">
                {t("recorder.recordings_subtitle")} {store.bootstrap?.recordingsDir ?? ""}
              </p>
            </div>
            {recordingsCount > 0 ? (
              <span className="shrink-0 pt-0.5 text-xs tabular-nums text-subtext">
                {recordingsCount} {t("recorder.recordings_count_label")}
              </span>
            ) : null}
          </div>
          <div className="space-y-2">
            {recordingsCount === 0 ? (
              <div className="py-4 text-center text-sm text-subtext">
                {t("recorder.recordings_empty")}
              </div>
            ) : (
              pagedRecordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  workspaceTargets={saveTargets}
                  onOpen={() => void store.openRecording(recording.id)}
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
        </SectionCard>
      </div>

      {/* Transcript viewer dialog */}
      <Dialog
        open={Boolean(store.openedRecording)}
        onOpenChange={(open) => {
          if (!open) store.closeOpenedRecording();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{store.openedRecording?.meta.title}</DialogTitle>
          </DialogHeader>
          {store.openedRecording ? (
            <RecordingPlayer recordingId={store.openedRecording.meta.id} />
          ) : null}
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {(store.openedRecording?.segments ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-subtext">
                {t("recorder.transcript_empty")}
              </div>
            ) : (
              (store.openedRecording?.segments ?? []).map((segment) => (
                <div key={segment.id} className="flex gap-2 text-sm leading-relaxed">
                  <span className="shrink-0 pt-px text-[11px] tabular-nums text-subtext">
                    {formatDuration(segment.startMs)}
                  </span>
                  <span className="text-ink">
                    {segment.speaker != null ? (
                      <span className="mr-1.5 font-medium text-brand">
                        {t("recorder.speaker_label", { n: segment.speaker + 1 })}:
                      </span>
                    ) : null}
                    {segment.text}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end gap-2">
            {store.openedRecording ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const opened = store.openedRecording;
                  if (opened) void revealRecording(opened.meta);
                }}
              >
                <FolderOpen data-icon="inline-start" />
                {t("recorder.reveal")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={(store.openedRecording?.segments ?? []).length === 0}
              onClick={() => {
                const text = store.getInsertableTranscript();
                store.closeOpenedRecording();
                if (text) props.onInsertTranscript?.(text);
              }}
            >
              <SendHorizontal data-icon="inline-start" />
              {t("recorder.insert_into_composer")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
