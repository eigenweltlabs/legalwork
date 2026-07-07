/** @jsxImportSource react */
/**
 * Recorder main pane — local audio recording + on-device transcription.
 * Rendered in the session shell's main view (sidebar stays), like Learnings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindowMac,
  Check,
  Download,
  FolderInput,
  FolderOpen,
  HardDrive,
  Languages,
  Loader2,
  Mic,
  MonitorSpeaker,
  PanelTopOpen,
  Pencil,
  Play,
  Sparkles,
  SendHorizontal,
  Square,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
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
import type {
  AudioModelState,
  AudioRecordingMeta,
} from "@legalwork/types/audio";

import { formatBytes } from "../../../app/utils";
import { revealRecording, useRecorderStore, type CopilotEntry } from "./recorder-store";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function tierLabel(tier: AudioModelState["tier"]): string {
  return t(`recorder.tier_${tier}`);
}

function LevelMeter({ level, label, icon }: { level: number; label: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2" title={label}>
      <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-green-9 transition-[width] duration-100"
          style={{ width: `${Math.min(100, Math.round(level * 130))}%` }}
        />
      </div>
    </div>
  );
}

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

function ModelRow(props: { model: AudioModelState }) {
  const { model } = props;
  const store = useRecorderStore();
  const progress =
    model.totalBytes > 0 ? Math.round((model.downloadedBytes / model.totalBytes) * 100) : 0;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{model.label}</span>
          <Badge variant="outline" className="text-[10px]">{tierLabel(model.tier)}</Badge>
          <Badge variant="outline" className="text-[10px]">EN · DE</Badge>
          {model.recommended ? (
            <Badge className="text-[10px]">{t("recorder.model_recommended")}</Badge>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{model.description}</div>
        {model.state === "downloading" ? (
          <div className="mt-2 flex items-center gap-2">
            <Progress value={progress} className="h-1.5 flex-1" />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatBytes(model.downloadedBytes)} / {formatBytes(model.totalBytes || model.approxSizeBytes)}
            </span>
          </div>
        ) : null}
        {model.state === "error" && model.error ? (
          <div className="mt-1 text-xs text-destructive">{model.error}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(model.installedSizeBytes ?? model.approxSizeBytes)}
        </span>
        {model.state === "installed" ? (
          <>
            <Badge variant="outline" className="gap-1 text-[10px] text-green-11">
              <HardDrive className="size-3" />
              {t("recorder.model_installed")}
            </Badge>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("recorder.model_delete")}
              onClick={() => void store.deleteModel(model.id)}
            >
              <Trash2 />
            </Button>
          </>
        ) : model.state === "downloading" ? (
          <Button variant="outline" size="sm" onClick={() => void store.cancelModelDownload(model.id)}>
            <X data-icon="inline-start" />
            {t("recorder.model_cancel")}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={() => void store.downloadModel(model.id)}>
            <Download data-icon="inline-start" />
            {t("recorder.model_download")}
          </Button>
        )}
      </div>
    </div>
  );
}

function CopilotEntryRow({ entry }: { entry: CopilotEntry }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {entry.kind === "suggestions" ? <Sparkles className="size-3.5 text-primary" /> : null}
        <span className="truncate">
          {entry.kind === "suggestions" ? t("recorder.copilot_suggestions_title") : entry.question}
        </span>
      </div>
      {entry.pending ? (
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("recorder.copilot_thinking")}
        </div>
      ) : entry.error ? (
        <div className="mt-1.5 text-xs text-destructive">{entry.error}</div>
      ) : (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
          {entry.answer}
        </div>
      )}
    </div>
  );
}

function RecordingRow(props: {
  recording: AudioRecordingMeta;
  workspacePath: string | null;
  onOpen: () => void;
}) {
  const store = useRecorderStore();
  const { recording } = props;
  const [savedTo, setSavedTo] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <button type="button" className="min-w-0 flex-1 text-left" onClick={props.onOpen}>
        <div className="flex items-center gap-2">
          <Play className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">{recording.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{new Date(recording.createdAt).toLocaleString()}</span>
          <span className="tabular-nums">{formatDuration(recording.durationMs)}</span>
          <span className="tabular-nums">{formatBytes(recording.sizeBytes)}</span>
          <span>
            {recording.segmentCount} {t("recorder.segments")}
          </span>
        </div>
        {savedTo ? (
          <div className="mt-1 truncate text-xs text-green-11">
            {t("recorder.saved_to_workspace")}: {savedTo}
          </div>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {props.workspacePath ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("recorder.save_to_workspace")}
                onClick={() =>
                  void store
                    .saveRecordingToWorkspace(recording.id, props.workspacePath ?? "")
                    .then((folder) => setSavedTo(folder))
                }
              >
                <FolderInput />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("recorder.save_to_workspace")}</TooltipContent>
          </Tooltip>
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
  /** Close the pane and hand the transcript to the session composer. */
  onInsertTranscript?: (text: string) => void;
}) {
  const store = useRecorderStore();
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void store.init();
    // The store is module-scoped; init is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [store.segments.length, store.partial?.text]);

  const models = store.bootstrap?.models ?? [];
  const installedModels = useMemo(() => models.filter((model) => model.state === "installed"), [models]);
  const engine = store.bootstrap?.engine;
  const isRecording = Boolean(store.recording);
  const selectedInstalled = installedModels.some((model) => model.id === store.modelId);
  const canRecord = !isRecording && selectedInstalled && engine?.available !== false;
  const isDesktop = Boolean(window.__LEGALWORK_ELECTRON__?.invokeDesktop);

  const liveSegments = store.segments;

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <Card variant="outline" size="sm" className="max-w-md">
          <CardHeader>
            <CardTitle>{t("recorder.desktop_required_title")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {t("recorder.desktop_required_body")}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto">
      <div className="relative z-10 mx-auto w-full max-w-[1080px] px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="lw-section-eyebrow">{t("recorder.eyebrow")}</span>
            <h1 className="mt-2 text-3xl font-medium tracking-[-0.03em] text-foreground">
              {t("recorder.title")}
            </h1>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">{t("recorder.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={store.overlayVisible ? "default" : "outline"}
              onClick={() => void store.setOverlayVisible(!store.overlayVisible)}
            >
              <PanelTopOpen data-icon="inline-start" />
              {store.overlayVisible ? t("recorder.overlay_hide") : t("recorder.overlay_show")}
            </Button>
            {isRecording ? (
              <Button variant="destructive" onClick={() => void store.stopRecording()}>
                <Square data-icon="inline-start" />
                {t("recorder.stop")}
              </Button>
            ) : (
              <Button disabled={!canRecord} onClick={() => void store.startRecording(title || undefined)}>
                <Mic data-icon="inline-start" />
                {t("recorder.record")}
              </Button>
            )}
          </div>
        </div>

        {store.error ? (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <span className="whitespace-pre-wrap break-words">{store.error}</span>
            <Button variant="ghost" size="icon-sm" aria-label={t("recorder.dismiss")} onClick={store.clearError}>
              <X />
            </Button>
          </div>
        ) : null}

        {engine && !engine.available ? (
          <div className="mt-4 rounded-xl border border-amber-6 bg-amber-2 px-3 py-2 text-sm text-amber-11">
            {t("recorder.engine_unavailable")} {engine.error ?? ""}
          </div>
        ) : null}

        {/* Setup */}
        <Card variant="outline" size="sm" className="mt-6">
          <CardHeader>
            <CardTitle className="text-sm">{t("recorder.setup_title")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">
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
              <SourceToggle
                active={false}
                disabled
                disabledHint={t("recorder.source_app_hint")}
                onToggle={() => {}}
                icon={<AppWindowMac />}
                label={t("recorder.source_app")}
              />
            </div>
            <div className="flex items-center gap-2">
              <Languages className="size-4 text-muted-foreground" />
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
              <HardDrive className="size-4 text-muted-foreground" />
              <Select
                value={store.modelId}
                onValueChange={(value) => {
                  if (value) store.setModelId(value);
                }}
                disabled={isRecording}
              >
                <SelectTrigger size="sm" className="w-[220px]">
                  <SelectValue placeholder={t("recorder.model_select_placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id} disabled={model.state !== "installed"}>
                      {model.label}
                      {model.state !== "installed" ? ` (${t("recorder.model_not_installed")})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-w-[200px] flex-1 items-center gap-2">
              <Pencil className="size-4 shrink-0 text-muted-foreground" />
              <Input
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder={t("recorder.title_placeholder")}
                disabled={isRecording}
                className="h-8"
              />
            </div>
          </CardContent>
        </Card>

        {/* Live transcript */}
        {(isRecording || liveSegments.length > 0 || store.partial) ? (
          <Card variant="outline" size="sm" className="mt-4">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    isRecording ? "animate-pulse bg-red-9" : "bg-muted-foreground",
                  )}
                />
                {isRecording ? t("recorder.live_transcript") : t("recorder.last_transcript")}
                {store.transcriber.state === "loading" ? (
                  <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {t("recorder.loading_model")}
                  </span>
                ) : null}
              </CardTitle>
              <div className="flex items-center gap-4">
                {store.sources.includes("microphone") && isRecording ? (
                  <LevelMeter
                    level={store.levels.microphone ?? 0}
                    label={t("recorder.source_microphone")}
                    icon={<Mic />}
                  />
                ) : null}
                {store.sources.includes("system") && isRecording ? (
                  <LevelMeter
                    level={store.levels.system ?? 0}
                    label={t("recorder.source_system")}
                    icon={<MonitorSpeaker />}
                  />
                ) : null}
                {store.recordingStartedAt ? (
                  <span className="text-sm text-muted-foreground">
                    <RecordingTimer startedAt={store.recordingStartedAt} />
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                {liveSegments.length === 0 && !store.partial ? (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    {t("recorder.waiting_for_speech")}
                  </div>
                ) : null}
                {liveSegments.map((segment) => (
                  <div key={segment.id} className="flex gap-2 text-sm leading-relaxed">
                    <span className="shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground">
                      {formatDuration(segment.startMs)}
                    </span>
                    <span className="text-foreground">{segment.text}</span>
                  </div>
                ))}
                {store.partial ? (
                  <div className="flex gap-2 text-sm italic leading-relaxed text-muted-foreground">
                    <span className="shrink-0 pt-px text-[11px] not-italic tabular-nums">
                      {formatDuration(store.partial.startMs)}
                    </span>
                    <span>{store.partial.text}…</span>
                  </div>
                ) : null}
                <div ref={transcriptEndRef} />
              </div>
              {liveSegments.length > 0 ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const text = store.getInsertableTranscript();
                      if (text) props.onInsertTranscript?.(text);
                    }}
                  >
                    <SendHorizontal data-icon="inline-start" />
                    {t("recorder.insert_into_composer")}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* AI copilot */}
        {(isRecording || store.copilotEntries.length > 0) ? (
          <Card variant="outline" size="sm" className="mt-4">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="text-primary" />
                {t("recorder.copilot_title")}
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                disabled={liveSegments.length === 0}
                onClick={() => void store.suggestFollowUps()}
              >
                <Sparkles data-icon="inline-start" />
                {t("recorder.copilot_suggest")}
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {store.copilotEntries.map((entry) => (
                <CopilotEntryRow key={entry.id} entry={entry} />
              ))}
              <InputGroup>
                <InputGroupTextarea
                  value={question}
                  onChange={(event) => setQuestion(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    const text = question;
                    setQuestion("");
                    void store.ask(text);
                  }}
                  placeholder={t("recorder.copilot_placeholder")}
                  rows={2}
                />
                <InputGroupAddon align="block-end" className="justify-end border-t border-border">
                  <InputGroupButton
                    variant="outline"
                    disabled={!question.trim()}
                    onClick={() => {
                      const text = question;
                      setQuestion("");
                      void store.ask(text);
                    }}
                  >
                    <SendHorizontal data-icon="inline-start" />
                    {t("recorder.copilot_ask")}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </CardContent>
          </Card>
        ) : null}

        {/* Models */}
        <Card variant="outline" size="sm" className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">{t("recorder.models_title")}</CardTitle>
            <p className="text-xs text-muted-foreground">{t("recorder.models_subtitle")}</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {models.map((model) => (
              <ModelRow key={model.id} model={model} />
            ))}
          </CardContent>
        </Card>

        {/* Recordings */}
        <Card variant="outline" size="sm" className="mt-4">
          <CardHeader>
            <CardTitle className="text-sm">{t("recorder.recordings_title")}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {t("recorder.recordings_subtitle")} {store.bootstrap?.recordingsDir ?? ""}
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {store.recordings.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t("recorder.recordings_empty")}
              </div>
            ) : (
              store.recordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  workspacePath={props.workspacePath}
                  onOpen={() => void store.openRecording(recording.id)}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Transcript viewer dialog */}
      <Dialog
        open={Boolean(store.openedRecording)}
        onOpenChange={(open) => {
          if (!open) store.closeOpenedRecording();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{store.openedRecording?.meta.title}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
            {(store.openedRecording?.segments ?? []).length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {t("recorder.transcript_empty")}
              </div>
            ) : (
              (store.openedRecording?.segments ?? []).map((segment) => (
                <div key={segment.id} className="flex gap-2 text-sm leading-relaxed">
                  <span className="shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground">
                    {formatDuration(segment.startMs)}
                  </span>
                  <span className="text-foreground">{segment.text}</span>
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
