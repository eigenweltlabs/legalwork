/** @jsxImportSource react */
/**
 * Recorder main pane — local audio recording + on-device transcription.
 * Rendered in the session shell's main view (sidebar stays), like Learnings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AppWindowMac,
  Check,
  FolderInput,
  FolderOpen,
  EyeOff,
  HardDrive,
  Languages,
  Loader2,
  Mic,
  MonitorSpeaker,
  Pencil,
  Play,
  Settings2,
  Sparkles,
  SendHorizontal,
  Square,
  Trash2,
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
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
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
  AudioRecordingMeta,
  AudioTapApp,
} from "@legalwork/types/audio";

import { audioTapListApps } from "@/app/lib/desktop";
import { formatBytes } from "../../../app/utils";
import { PermissionsPanel } from "./permissions-panel";
import { revealRecording, useRecorderStore, type CopilotEntry } from "./recorder-store";

/**
 * Flat section card, same recipe as the Learnings page's PreviewCard: liquid
 * glass fill + hairline border, rounded 20, and an explicit inline
 * `boxShadow: none` — the global `[data-slot="card"]` frost rule puts
 * `!important` shadows + a hover lift on the shared Card component, so a
 * plain div is the only way to stay truly flat.
 */
function SectionCard(props: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn("glass flex flex-col gap-4 rounded-[20px] p-4", props.className)}
      style={{ boxShadow: "none" }}
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

/** MacWhisper-style picker: choose which running apps to capture. */
function AppPickerDialog(props: { open: boolean; onClose: () => void }) {
  const store = useRecorderStore();
  const [apps, setApps] = useState<AudioTapApp[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(store.appPids));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLoading(true);
    setSelected(new Set(useRecorderStore.getState().appPids));
    void audioTapListApps()
      .then(setApps)
      .finally(() => setLoading(false));
  }, [props.open]);

  const filtered = apps.filter((app) => app.name.toLowerCase().includes(query.trim().toLowerCase()));

  const toggle = (pid: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("recorder.app_picker_title")}</DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("recorder.app_picker_search")}
          className="h-8"
        />
        <div className="grid max-h-[50vh] grid-cols-4 gap-2 overflow-y-auto py-1 sm:grid-cols-5">
          <button
            type="button"
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-xl border border-transparent p-2 text-center transition-colors hover:bg-muted",
              selected.size === 0 && "border-primary bg-primary/10",
            )}
            onClick={() => setSelected(new Set())}
          >
            <MonitorSpeaker className="size-9 text-muted-foreground" />
            <span className="line-clamp-2 text-[11px] leading-tight text-foreground">
              {t("recorder.app_picker_all_system")}
            </span>
          </button>
          {loading ? (
            <div className="col-span-3 flex items-center gap-2 p-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("recorder.app_picker_loading")}
            </div>
          ) : null}
          {filtered.map((app) => (
            <button
              key={app.pid}
              type="button"
              className={cn(
                "flex flex-col items-center gap-1.5 rounded-xl border border-transparent p-2 text-center transition-colors hover:bg-muted",
                selected.has(app.pid) && "border-primary bg-primary/10",
              )}
              onClick={() => toggle(app.pid)}
            >
              {app.icon ? (
                <img src={app.icon} alt="" className="size-9 rounded-lg" />
              ) : (
                <AppWindowMac className="size-9 text-muted-foreground" />
              )}
              <span className="line-clamp-2 text-[11px] leading-tight text-foreground">{app.name}</span>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClose}>
            {t("recorder.model_cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const pids = Array.from(selected);
              const names = apps.filter((app) => selected.has(app.pid)).map((app) => app.name);
              store.setAppSelection(pids, names);
              props.onClose();
            }}
          >
            <Check data-icon="inline-start" />
            {t("recorder.app_picker_confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card/60 px-3 py-2.5">
      {editing ? (
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Play className="size-3.5 shrink-0 text-muted-foreground" />
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
                    <div className="truncate text-xs text-muted-foreground">{target.path}</div>
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
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const navigate = useNavigate();
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

  // Save targets: every local workspace (selected first, provided by the
  // shell); older callers that only pass workspacePath still get one target.
  const saveTargets = useMemo<RecorderWorkspaceTarget[]>(() => {
    if (props.workspaceTargets?.length) return props.workspaceTargets;
    if (props.workspacePath) {
      return [{ id: "current", name: t("recorder.save_to_workspace"), path: props.workspacePath }];
    }
    return [];
  }, [props.workspaceTargets, props.workspacePath]);

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <SectionCard className="max-w-md">
          <h3 className="text-sm font-medium text-foreground">{t("recorder.desktop_required_title")}</h3>
          <p className="text-sm text-muted-foreground">{t("recorder.desktop_required_body")}</p>
        </SectionCard>
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

        {isRecording ? (
          <div className="mt-4 flex items-center gap-2 rounded-[20px] border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
            <EyeOff className="size-3.5 shrink-0" />
            {t("recorder.stealth_active")}
          </div>
        ) : null}

        <PermissionsPanel />

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

        {store.transcriber.state === "error" && store.transcriber.error ? (
          <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {t("recorder.transcriber_error")} {store.transcriber.error}
          </div>
        ) : null}

        {/* Setup */}
        <SectionCard className="mt-6">
          <h3 className="text-sm font-medium text-foreground">{t("recorder.setup_title")}</h3>
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
              <SourceToggle
                active={store.sources.includes("app")}
                disabled={isRecording || store.bootstrap?.capabilities.appAudio !== true}
                disabledHint={t("recorder.source_app_hint")}
                onToggle={() => {
                  if (store.sources.includes("app")) store.toggleSource("app");
                  else setAppPickerOpen(true);
                }}
                icon={<AppWindowMac />}
                label={
                  store.sources.includes("app") && store.appNames.length
                    ? `${t("recorder.source_app")}: ${store.appNames.slice(0, 2).join(", ")}${store.appNames.length > 2 ? "…" : ""}`
                    : t("recorder.source_app")
                }
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
              <Button variant="ghost" size="sm" onClick={() => navigate("/settings/recorder")}>
                <Settings2 data-icon="inline-start" />
                {t("recorder.manage_models")}
              </Button>
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
          </div>
        </SectionCard>

        <AppPickerDialog open={appPickerOpen} onClose={() => setAppPickerOpen(false)} />

        {/* Live transcript */}
        {(isRecording || liveSegments.length > 0 || store.partial) ? (
          <SectionCard className="mt-4">
            <div className="flex flex-row items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
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
              </h3>
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
            </div>
            <div>
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
            </div>
          </SectionCard>
        ) : null}

        {/* AI copilot */}
        {(isRecording || store.copilotEntries.length > 0) ? (
          <SectionCard className="mt-4">
            <div className="flex flex-row items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Sparkles className="size-4 text-primary" />
                {t("recorder.copilot_title")}
              </h3>
              <Button
                variant="outline"
                size="sm"
                disabled={liveSegments.length === 0}
                onClick={() => void store.suggestFollowUps()}
              >
                <Sparkles data-icon="inline-start" />
                {t("recorder.copilot_suggest")}
              </Button>
            </div>
            <div className="space-y-2">
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
            </div>
          </SectionCard>
        ) : null}

        {/* Recordings */}
        <SectionCard className="mt-4">
          <div>
            <h3 className="text-sm font-medium text-foreground">{t("recorder.recordings_title")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("recorder.recordings_subtitle")} {store.bootstrap?.recordingsDir ?? ""}
            </p>
          </div>
          <div className="space-y-2">
            {store.recordings.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t("recorder.recordings_empty")}
              </div>
            ) : (
              store.recordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  workspaceTargets={saveTargets}
                  onOpen={() => void store.openRecording(recording.id)}
                />
              ))
            )}
          </div>
        </SectionCard>
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
