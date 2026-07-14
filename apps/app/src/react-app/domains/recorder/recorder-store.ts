/**
 * Recorder runtime store (module-level, mirrors the Voice Mode pattern):
 * bootstraps the local model manager, drives capture + live transcription,
 * keeps the transcript, and answers call-overlay questions through the
 * workspace's OpenCode session AI.
 */

import { create } from "zustand";

import {
  audioCaptureOpenSettings,
  audioCapturePermissions,
  audioCapturePermissionsRequest,
  audioDiarizationDownload,
  audioModelDelete,
  audioModelDownload,
  audioModelDownloadCancel,
  audioOverlaySetVisible,
  audioRecorderBootstrap,
  audioSystemDictationGet,
  audioSystemDictationOpenSettings,
  audioSystemDictationPaste,
  audioSystemDictationSetEnabled,
  audioSystemDictationSetMode,
  audioSystemDictationSetShortcut,
  audioSystemDictationSetShortcutCapture,
  audioSystemDictationSetState,
  audioLiveTranscriptStart,
  audioLiveTranscriptStop,
  audioImportStart,
  audioImportSource,
  audioImportFinish,
  audioRecordingCancel,
  audioRecordingDelete,
  audioRecordingGet,
  audioRecordingRename,
  audioRecordingSaveToWorkspace,
  audioRecordingStart,
  audioRecordingStop,
  audioRecordingsList,
  audioTranscriberStart,
  desktopBridge,
} from "@/app/lib/desktop";
import { unwrap } from "@/app/lib/opencode";
import type { Client } from "@/app/types";
import type {
  AudioCapturePermissions,
  AudioCaptureSourceKind,
  AudioPermissionKind,
  AudioRecorderBootstrap,
  AudioRecorderEvent,
  AudioRecordingDetail,
  AudioRecordingMeta,
  AudioSystemDictationRuntimeState,
  AudioSystemDictationMode,
  AudioSystemDictationStatus,
  AudioTranscribeLanguage,
  AudioTranscriberStatus,
  AudioTranscriptSegment,
} from "@legalwork/types/audio";
import { t } from "@/i18n";
import { isPremiumEntitled } from "./model-tiers";

import { decodeAudioFileToPcm16k, startCapture, type CaptureHandle, type CaptureLevels } from "./capture";

/** PCM chunk size when streaming a decoded file to the worker (~1 s at 16 kHz). */
const IMPORT_PCM_CHUNK = 16000;

const MODEL_PREF_KEY = "legalwork.recorder.model";
const LANGUAGE_PREF_KEY = "legalwork.recorder.language";
const SOURCES_PREF_KEY = "legalwork.recorder.sources";

/**
 * The session composer listens to this event (voice mode uses it too) — but
 * only while SessionSurface is mounted, i.e. NOT while the Recorder pane is
 * the main view. Callers must close the pane first and dispatch after the
 * session view has remounted (see RecorderPane's onInsertTranscript).
 */
export const RECORDER_TRANSCRIPT_EVENT = "legalwork:voice-transcript";

// ── AI copilot context (set by the shell, survives pane unmounts) ──────────

type CopilotContext = {
  getClient: () => Client | null;
  getDirectory: () => string | null;
};

let copilotContext: CopilotContext | null = null;
let copilotSessionId: string | null = null;

export function registerRecorderCopilotContext(context: CopilotContext | null) {
  copilotContext = context;
  copilotSessionId = null;
}

export type CopilotEntry = {
  id: string;
  kind: "question" | "suggestions";
  question: string;
  answer: string;
  pending: boolean;
  error: string | null;
  at: number;
};

export type RecorderState = {
  initialized: boolean;
  bootstrap: AudioRecorderBootstrap | null;
  permissions: AudioCapturePermissions | null;
  /** Permissions blocking the selected sources — non-empty shows the guided panel. */
  permissionsNeeded: AudioPermissionKind[];
  transcriber: AudioTranscriberStatus;
  recording: AudioRecordingMeta | null;
  recordingStartedAt: number | null;
  segments: AudioTranscriptSegment[];
  partial: AudioTranscriptSegment | null;
  recordings: AudioRecordingMeta[];
  openedRecording: AudioRecordingDetail | null;
  /** A file drag-dropped for transcription is being decoded/transcribed. */
  importing: { fileName: string } | null;
  levels: CaptureLevels;
  overlayVisible: boolean;
  copilotEntries: CopilotEntry[];
  /** Session whose chat currently mirrors the live transcript to a file, if any. */
  liveTranscriptSessionId: string | null;
  error: string | null;
  systemDictation: AudioSystemDictationStatus | null;
  dictationState: AudioSystemDictationRuntimeState;
  dictationRecordingId: string | null;
  modelId: string;
  language: AudioTranscribeLanguage;
  sources: AudioCaptureSourceKind[];
  /** A stopping recording is running its speaker pass. */
  diarizing: boolean;
  /**
   * Stop was pressed and the recording is finalizing — flushing capture and
   * transcribing the tail of a long recording. Drives the "Finishing…" UI so a
   * slow finalize never looks like a dead Stop button.
   */
  finalizing: boolean;
  /**
   * Testing-only: model ids whose premium/device gate the user dismissed this
   * session, so they can be exercised before auth exists. Per-model (not a
   * global flag) so every gated model still prompts once. Resets on reload.
   */
  unlockedModels: string[];
};

type RecorderActions = {
  init: () => Promise<void>;
  refreshBootstrap: () => Promise<void>;
  refreshRecordings: () => Promise<void>;
  /** Re-read OS permission status; clears `permissionsNeeded` once satisfied. */
  refreshPermissions: () => Promise<void>;
  /** Native prompt (microphone) or System Settings deep link (systemAudio). */
  requestPermission: (kind: AudioPermissionKind) => Promise<void>;
  openPermissionSettings: (kind: AudioPermissionKind) => Promise<void>;
  dismissPermissionsPanel: () => void;
  setModelId: (modelId: string) => void;
  /**
   * Testing-only escape hatch: dismiss the premium/device gate for one model so
   * it can be selected and downloaded before auth is wired up.
   */
  unlockModelForTesting: (modelId: string) => void;
  setLanguage: (language: AudioTranscribeLanguage) => void;
  prewarm: () => Promise<void>;
  toggleSource: (source: AudioCaptureSourceKind) => void;
  downloadDiarization: () => Promise<void>;
  /** Background-download the speaker models when they aren't installed yet. */
  ensureDiarizationReady: () => Promise<void>;
  downloadModel: (modelId: string) => Promise<void>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  startRecording: (
    title?: string,
    options?: { sources?: AudioCaptureSourceKind[]; systemDictation?: boolean; diarize?: boolean },
  ) => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  refreshSystemDictation: () => Promise<void>;
  setSystemDictationEnabled: (enabled: boolean) => Promise<void>;
  setSystemDictationMode: (mode: AudioSystemDictationMode) => Promise<void>;
  setSystemDictationShortcut: (accelerator: string) => Promise<boolean>;
  setSystemDictationShortcutCapture: (active: boolean) => Promise<void>;
  openSystemDictationSettings: () => Promise<void>;
  startSystemDictation: () => Promise<void>;
  /** Transcribe a dropped/opened audio file locally; adds it to Recordings. */
  importAudioFile: (file: File) => Promise<void>;
  deleteRecording: (recordingId: string) => Promise<void>;
  renameRecording: (recordingId: string, title: string) => Promise<void>;
  openRecording: (recordingId: string) => Promise<void>;
  closeOpenedRecording: () => void;
  saveRecordingToWorkspace: (recordingId: string, workspacePath: string) => Promise<string | null>;
  getInsertableTranscript: () => string;
  /**
   * Toggle: start mirroring the live transcript to a `live-call-transcript.md`
   * file in the given workspace and tell the chat's agent (once, via a hidden
   * no-reply message) that a growing transcript file exists to check. Returns
   * true when armed. Stops automatically when the recording ends.
   */
  startLiveTranscriptShare: (sessionId: string, workspacePath: string, directory?: string) => Promise<boolean>;
  stopLiveTranscriptShare: () => Promise<void>;
  setOverlayVisible: (visible: boolean) => Promise<void>;
  ask: (question: string) => Promise<void>;
  suggestFollowUps: () => Promise<void>;
  clearError: () => void;
};

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Raw stored value (null when the user never set it), to tell default from choice. */
function readStoredPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode etc.
  }
}

function readSourcesPref(): AudioCaptureSourceKind[] {
  const raw = readPref(SOURCES_PREF_KEY, "microphone");
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is AudioCaptureSourceKind => item === "microphone" || item === "system");
  return parsed.length ? parsed : ["microphone"];
}

function readLanguagePref(): AudioTranscribeLanguage {
  const raw = readPref(LANGUAGE_PREF_KEY, "auto");
  return raw === "en" || raw === "de" ? raw : "auto";
}

/** Which OS permissions the selected sources depend on. */
function requiredPermissionKinds(sources: AudioCaptureSourceKind[]): AudioPermissionKind[] {
  const kinds: AudioPermissionKind[] = [];
  if (sources.includes("microphone")) kinds.push("microphone");
  // System-audio loopback is gated by the macOS "Screen & System Audio
  // Recording" pane.
  if (sources.includes("system")) kinds.push("systemAudio");
  return kinds;
}

/**
 * Kinds that will make capture fail as things stand. Microphone
 * "not-determined" is fine — getUserMedia triggers the native prompt — but
 * screen/system-audio has no runtime prompt, so anything short of granted
 * needs the guided flow. "unknown" (status unreadable) never blocks.
 */
function missingPermissionKinds(
  permissions: AudioCapturePermissions | null,
  kinds: AudioPermissionKind[],
): AudioPermissionKind[] {
  if (!permissions) return [];
  return kinds.filter((kind) => {
    const state = permissions[kind];
    if (kind === "microphone") return state === "denied" || state === "restricted";
    return state === "denied" || state === "restricted" || state === "not-determined";
  });
}

/** Runtime errors that mean "an OS permission is missing", per source. */
function permissionKindsFromCaptureError(message: string, sources: AudioCaptureSourceKind[]): AudioPermissionKind[] {
  const text = message.toLowerCase();
  const kinds: AudioPermissionKind[] = [];
  if (sources.includes("microphone") && (text.includes("microphone") || text.includes("mikrofon"))) {
    kinds.push("microphone");
  }
  const systemShaped =
    text.includes("error starting capture") || // Chromium getDisplayMedia loopback failure
    text.includes("screen capture") ||
    text.includes("system audio") ||
    text.includes("notallowederror") ||
    text.includes("permission denied");
  if (sources.includes("system") && systemShaped) {
    kinds.push("systemAudio");
  }
  return kinds;
}

let captureHandle: CaptureHandle | null = null;
let levelTimer: number | null = null;
let eventsSubscribed = false;
let dictationTogglePending = false;
let dictationHoldStartPending = false;
let dictationHoldReleased = false;
let dictationHoldStopPending = false;
let dictationCancelPending = false;
// When the last dictation settled (stopped or canceled). A brand-new dictation
// that tries to start within a beat of the previous one ending is not a human
// key press — it's a runaway restart (e.g. an empty "no speech" result looping
// straight back into listening). We refuse it so the loop can't run away.
let dictationSettleAt = 0;
const DICTATION_RESTART_COOLDOWN_MS = 1000;
// Bumped whenever the machine suspends. startRecording captures it on entry
// and rolls back if it changed by the time capture is wired up — a recording
// whose start straddled a sleep would otherwise latch on indefinitely (and
// hold the OS power blocker) until the user next toggles the hotkey.
let suspendEpoch = 0;

function transcriptText(segments: AudioTranscriptSegment[], limit = 12_000): string {
  const text = segments
    .map((segment) =>
      segment.speaker != null ? `Speaker ${segment.speaker + 1}: ${segment.text}` : segment.text,
    )
    .join("\n");
  return text.length > limit ? text.slice(text.length - limit) : text;
}

async function ensureCopilotSession(client: Client, directory: string | null): Promise<string> {
  if (copilotSessionId) return copilotSessionId;
  const session = unwrap(
    await client.session.create({ directory: directory ?? undefined, title: "Recorder call copilot" }),
  );
  copilotSessionId = session.id;
  return session.id;
}

async function runCopilotPrompt(question: string, transcript: string, language: AudioTranscribeLanguage) {
  const client = copilotContext?.getClient() ?? null;
  if (!client) throw new Error(t("recorder.copilot_unavailable"));
  const directory = copilotContext?.getDirectory() ?? null;
  const sessionID = await ensureCopilotSession(client, directory);
  const languageHint =
    language === "de"
      ? "Antworte auf Deutsch."
      : language === "en"
        ? "Answer in English."
        : "Answer in the language of the transcript.";
  const system = [
    "You are a discreet real-time assistant for a lawyer who is in a live conversation (client call, negotiation, hearing).",
    "You receive the live transcript so far plus one request. The lawyer is waiting mid-call, so default to answering immediately from the transcript and your own knowledge.",
    "Tools are available but use them RARELY: only when the request clearly needs a specific fact from the case files (a date, clause, figure) — then do one quick lookup, never a broad investigation.",
    "Be terse and immediately useful: at most 3 short sentences or 3 bullet points.",
    "Never invent facts that are not in the transcript. When asked for follow-up questions, ask sharp, critical ones that surface missing facts, inconsistencies, deadlines, and legal risk.",
    languageHint,
  ].join(" ");
  const prompt = transcript.trim().length
    ? `Live transcript so far:\n"""\n${transcript}\n"""\n\nRequest: ${question}`
    : `There is no transcript yet.\n\nRequest: ${question}`;
  const promptCall = client.session.prompt({
    sessionID,
    system,
    parts: [{ type: "text", text: prompt }],
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(t("recorder.copilot_timeout"))), 75_000);
  });
  const result = unwrap(await Promise.race([promptCall, timeout]));
  const answer = (result.parts ?? [])
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  return answer || t("recorder.copilot_empty_answer");
}

export const useRecorderStore = create<RecorderState & RecorderActions>((set, get) => {
  const sendAskAnswer = (askId: string, text: string, done: boolean, error?: string | null) => {
    window.__LEGALWORK_ELECTRON__?.audio?.sendAskAnswer?.(askId, text, done, error ?? null);
  };

  const upsertCopilotEntry = (entry: CopilotEntry) => {
    set((state) => {
      const existing = state.copilotEntries.findIndex((item) => item.id === entry.id);
      const next = [...state.copilotEntries];
      if (existing >= 0) next[existing] = entry;
      else next.push(entry);
      return { copilotEntries: next.slice(-40) };
    });
  };

  const answerAsk = async (askId: string, kind: CopilotEntry["kind"], question: string) => {
    const { segments, language } = get();
    const entry: CopilotEntry = {
      id: askId,
      kind,
      question,
      answer: "",
      pending: true,
      error: null,
      at: Date.now(),
    };
    upsertCopilotEntry(entry);
    try {
      const answer = await runCopilotPrompt(question, transcriptText(segments), language);
      upsertCopilotEntry({ ...entry, answer, pending: false });
      sendAskAnswer(askId, answer, true, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertCopilotEntry({ ...entry, pending: false, error: message });
      sendAskAnswer(askId, "", true, message);
    }
  };

  const handleEvent = (event: AudioRecorderEvent) => {
    const state = get();
    switch (event.type) {
      case "model-download-progress": {
        // Patch the one model in place — a full bootstrap round-trip per
        // progress tick would hammer IPC + fs during large downloads.
        set((current) => {
          if (!current.bootstrap) return current;
          return {
            bootstrap: {
              ...current.bootstrap,
              models: current.bootstrap.models.map((model) =>
                model.id === event.modelId
                  ? {
                      ...model,
                      state: "downloading",
                      downloadedBytes: event.downloadedBytes,
                      totalBytes: event.totalBytes,
                    }
                  : model,
              ),
            },
          };
        });
        break;
      }
      case "model-download-done":
      case "model-download-error":
      case "diarization-download-progress":
      case "diarization-download-done":
      case "diarization-download-error": {
        void get().refreshBootstrap();
        break;
      }
      case "recording-diarizing": {
        if (state.recording?.id === event.recordingId) set({ diarizing: true });
        break;
      }
      case "transcriber-status": {
        set({ transcriber: event.status });
        break;
      }
      case "transcript-partial": {
        if (state.recording?.id === event.streamId) set({ partial: event.segment });
        break;
      }
      case "transcript-segment": {
        if (state.recording?.id === event.streamId) {
          set((current) => ({
            segments: [...current.segments, event.segment].sort((a, b) => a.startMs - b.startMs),
            partial:
              current.partial && current.partial.endMs <= event.segment.endMs ? null : current.partial,
          }));
        }
        break;
      }
      case "transcript-partial-clear": {
        if (state.recording?.id === event.streamId) {
          set((current) => ({
            partial: current.partial && current.partial.endMs <= event.endMs ? null : current.partial,
          }));
        }
        break;
      }
      case "recording-error": {
        set({ error: event.error });
        break;
      }
      case "system-dictation-toggle": {
        if (dictationTogglePending) break;
        dictationTogglePending = true;
        void (async () => {
          try {
            await get().init();
            if (get().dictationRecordingId) await get().stopRecording();
            else await get().startSystemDictation();
          } finally {
            dictationTogglePending = false;
          }
        })();
        break;
      }
      case "system-dictation-press": {
        if (dictationHoldStartPending || state.dictationRecordingId) break;
        dictationHoldReleased = false;
        dictationHoldStartPending = true;
        void (async () => {
          try {
            await get().init();
            await get().startSystemDictation();
          } finally {
            dictationHoldStartPending = false;
            if (dictationHoldReleased && get().dictationRecordingId && !dictationHoldStopPending) {
              dictationHoldStopPending = true;
              await get().stopRecording().finally(() => {
                dictationHoldStopPending = false;
              });
            }
          }
        })();
        break;
      }
      case "system-dictation-release": {
        dictationHoldReleased = true;
        if (state.dictationRecordingId && !dictationHoldStartPending && !dictationHoldStopPending) {
          dictationHoldStopPending = true;
          void get().stopRecording().finally(() => {
            dictationHoldStopPending = false;
          });
        }
        break;
      }
      case "system-dictation-cancel": {
        if (state.dictationRecordingId && !dictationCancelPending) {
          dictationCancelPending = true;
          void get().cancelRecording().finally(() => {
            dictationCancelPending = false;
          });
        }
        break;
      }
      case "system-dictation-status": {
        set({ systemDictation: event.status, error: event.status.error });
        break;
      }
      case "power-suspend": {
        // Machine is going to sleep. Dictation is canceled (a paste into
        // whatever happens to be focused after wake would be wrong); a call
        // recording is stopped so everything captured so far finalizes to
        // disk instead of freezing mid-write.
        suspendEpoch += 1;
        // A hold-mode dictation may be mid-start with its key-up about to be
        // swallowed by sleep — release it so the press handler's finally
        // stops it (and so startRecording's post-capture check rolls back).
        dictationHoldReleased = true;
        // Don't race a stop/start that's already in flight: issuing a cancel
        // against a recording another handler is finalizing throws
        // "Unknown recording" and deletes the folder out from under it. A
        // pending start is covered by the suspendEpoch rollback; a pending
        // stop already finalizes (and retains on paste failure) on its own.
        if (
          dictationTogglePending
          || dictationHoldStartPending
          || dictationHoldStopPending
          || dictationCancelPending
        ) break;
        if (state.dictationRecordingId) void get().cancelRecording();
        else if (state.recording) void get().stopRecording();
        break;
      }
      case "live-transcript-stopped": {
        // Recording ended → the workspace mirror is finalized; reset the toggle.
        set({ liveTranscriptSessionId: null });
        break;
      }
      case "overlay-visibility": {
        set({ overlayVisible: event.visible });
        break;
      }
      case "overlay-ask": {
        if (event.question.trim()) void answerAsk(event.askId, "question", event.question.trim());
        break;
      }
      case "overlay-suggest": {
        void answerAsk(event.askId, "suggestions", t("recorder.copilot_suggest_prompt"));
        break;
      }
      default:
        break;
    }
  };

  return {
    initialized: false,
    bootstrap: null,
    permissions: null,
    permissionsNeeded: [],
    transcriber: { state: "idle", modelId: null, error: null },
    recording: null,
    recordingStartedAt: null,
    segments: [],
    partial: null,
    recordings: [],
    openedRecording: null,
    importing: null,
    levels: {},
    overlayVisible: false,
    copilotEntries: [],
    liveTranscriptSessionId: null,
    error: null,
    systemDictation: null,
    dictationState: "idle",
    dictationRecordingId: null,
    modelId: readPref(MODEL_PREF_KEY, "whisper-small"),
    language: readLanguagePref(),
    sources: readSourcesPref(),
    diarizing: false,
    finalizing: false,
    unlockedModels: [],

    init: async () => {
      if (!eventsSubscribed) {
        eventsSubscribed = true;
        window.__LEGALWORK_ELECTRON__?.audio?.onEvent?.(handleEvent);
      }
      if (get().initialized) return;
      set({ initialized: true });
      await Promise.all([
        get().refreshBootstrap(),
        get().refreshRecordings(),
        get().refreshPermissions(),
        get().refreshSystemDictation(),
      ]);
      void get().prewarm();
      void get().ensureDiarizationReady();
    },

    /**
     * Speaker identification is always on, so pull its models in the
     * background the first time — recordings then just get labeled without the
     * user ever setting anything up.
     */
    ensureDiarizationReady: async () => {
      const diarization = get().bootstrap?.diarization;
      if (!diarization || diarization.installed || diarization.downloading) return;
      await get().downloadDiarization();
    },

    refreshBootstrap: async () => {
      try {
        const bootstrap = await audioRecorderBootstrap();
        set({ bootstrap });
        // Repoint the selection when it references a model that no longer
        // exists (old Base/Turbo tiers) or the user never chose one — pick the
        // model recommended for this device so nothing is silently unselectable.
        const chosen = get().modelId;
        const stored = readStoredPref(MODEL_PREF_KEY);
        const known = bootstrap.models.some((model) => model.id === chosen);
        if (!known || !stored) {
          const recommended = bootstrap.device?.recommendedModelId;
          const fallback = bootstrap.models.find((model) => model.id === recommended)
            ? recommended
            : bootstrap.models.find((model) => model.plan === "free")?.id ?? chosen;
          if (fallback && fallback !== chosen) set({ modelId: fallback });
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    refreshPermissions: async () => {
      try {
        const permissions = await audioCapturePermissions();
        // Prune satisfied kinds so the panel collapses as the user grants
        // access (e.g. coming back from System Settings on window focus).
        const stillMissing = missingPermissionKinds(permissions, get().permissionsNeeded);
        set({ permissions, permissionsNeeded: stillMissing });
      } catch {
        // plain web / old desktop build — pre-flight simply stays off
      }
    },

    requestPermission: async (kind) => {
      try {
        const permissions = await audioCapturePermissionsRequest(kind);
        const stillMissing = missingPermissionKinds(permissions, get().permissionsNeeded);
        set({ permissions, permissionsNeeded: stillMissing });
      } catch {
        // bridge unavailable — the panel's settings link still explains the manual path
      }
    },

    openPermissionSettings: async (kind) => {
      await audioCaptureOpenSettings(kind).catch(() => {});
    },

    dismissPermissionsPanel: () => {
      set({ permissionsNeeded: [] });
    },

    refreshRecordings: async () => {
      try {
        set({ recordings: await audioRecordingsList() });
      } catch {
        // desktop bridge unavailable (plain web) — recorder UI shows a hint
      }
    },

    refreshSystemDictation: async () => {
      try {
        set({ systemDictation: await audioSystemDictationGet() });
      } catch {
        // Plain web and older desktop builds do not expose this feature.
      }
    },

    setSystemDictationEnabled: async (enabled) => {
      if (!enabled && get().dictationRecordingId) await get().cancelRecording();
      try {
        const status = await audioSystemDictationSetEnabled(enabled);
        set({ systemDictation: status, error: status.error });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    setSystemDictationMode: async (mode) => {
      try {
        const status = await audioSystemDictationSetMode(mode);
        set({ systemDictation: status, error: status.error });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    setSystemDictationShortcut: async (accelerator) => {
      try {
        const status = await audioSystemDictationSetShortcut(accelerator);
        set({ systemDictation: status, error: status.error });
        return status.error === null;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },

    setSystemDictationShortcutCapture: async (active) => {
      try {
        set({ systemDictation: await audioSystemDictationSetShortcutCapture(active) });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    openSystemDictationSettings: async () => {
      try {
        set({ systemDictation: await audioSystemDictationOpenSettings() });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    startSystemDictation: async () => {
      const { systemDictation, bootstrap, modelId, recording } = get();
      if (!systemDictation?.enabled || !systemDictation.registered) return;
      // Guard against a runaway restart loop: a start that lands within a beat
      // of the previous dictation ending isn't a real key press. Drop it and
      // settle to idle so the HUD hides instead of re-arming forever.
      if (Date.now() - dictationSettleAt < DICTATION_RESTART_COOLDOWN_MS) {
        set({ dictationState: "idle" });
        await audioSystemDictationSetState("idle").catch(() => {});
        return;
      }
      if (recording) {
        const message = "Stop the current Recorder session before starting system-wide dictation.";
        set({ error: message, dictationState: "error" });
        await audioSystemDictationSetState("error", message).catch(() => {});
        return;
      }
      const model = bootstrap?.models.find((entry) => entry.id === modelId);
      if (!model || model.state !== "installed") {
        const message = "Install and select a local transcription model in Recorder settings first.";
        set({ error: message, dictationState: "error" });
        await audioSystemDictationSetState("error", message).catch(() => {});
        return;
      }
      await get().startRecording("System dictation", {
        sources: ["microphone"],
        systemDictation: true,
      });
    },

    setModelId: (modelId) => {
      // Never let a still-gated premium model become the active selection — but
      // an already-installed model is on disk and always usable, even after the
      // session unlock set has reset.
      const model = get().bootstrap?.models.find((entry) => entry.id === modelId);
      const installed = model?.state === "installed";
      if (
        model?.plan === "premium" &&
        !installed &&
        !isPremiumEntitled() &&
        !get().unlockedModels.includes(modelId)
      ) {
        return;
      }
      writePref(MODEL_PREF_KEY, modelId);
      set({ modelId });
      void get().prewarm();
    },

    unlockModelForTesting: (modelId) => {
      // Testing-only: mark this one model as gate-dismissed for the session so
      // its guards pass and the picker re-renders out of its locked UI. Other
      // gated models keep prompting.
      set((state) =>
        state.unlockedModels.includes(modelId)
          ? state
          : { unlockedModels: [...state.unlockedModels, modelId] },
      );
    },

    setLanguage: (language) => {
      writePref(LANGUAGE_PREF_KEY, language);
      set({ language });
      void get().prewarm();
    },

    /**
     * Load the selected model in the worker ahead of time so hitting Record
     * starts transcribing immediately (large models take seconds to load).
     */
    prewarm: async () => {
      const { modelId, language, recording, bootstrap } = get();
      if (recording) return;
      const model = bootstrap?.models.find((entry) => entry.id === modelId);
      if (!model || model.state !== "installed") return;
      await audioTranscriberStart({ modelId, language }).catch(() => {});
    },

    toggleSource: (source) => {
      set((state) => {
        const has = state.sources.includes(source);
        const next = has ? state.sources.filter((item) => item !== source) : [...state.sources, source];
        const normalized: AudioCaptureSourceKind[] = next.length ? next : ["microphone"];
        writePref(SOURCES_PREF_KEY, normalized.join(","));
        return { sources: normalized };
      });
    },

    downloadDiarization: async () => {
      try {
        await audioDiarizationDownload();
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
      await get().refreshBootstrap();
    },

    downloadModel: async (modelId) => {
      // Premium models don't download until the user is entitled (or the gate
      // was dismissed for testing); the UI shows the locked/upgrade state, this
      // guards the path itself.
      const model = get().bootstrap?.models.find((entry) => entry.id === modelId);
      if (model?.plan === "premium" && !isPremiumEntitled() && !get().unlockedModels.includes(modelId)) {
        return;
      }
      try {
        await audioModelDownload(modelId);
        await get().refreshBootstrap();
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    cancelModelDownload: async (modelId) => {
      await audioModelDownloadCancel(modelId).catch(() => {});
      await get().refreshBootstrap();
    },

    deleteModel: async (modelId) => {
      await audioModelDelete(modelId).catch(() => {});
      await get().refreshBootstrap();
    },

    startRecording: async (title, options) => {
      const { modelId, language, recording, bootstrap } = get();
      if (recording) return;
      // A persisted "system" pref may predate running on a platform that
      // can't capture it (e.g. macOS 12) — drop unsupported sources.
      let sources = options?.sources ?? get().sources;
      if (bootstrap && !bootstrap.capabilities.systemAudio) {
        sources = sources.filter((source) => source !== "system");
      }
      if (!sources.length) sources = ["microphone"];

      // Pre-flight: check OS permissions for the selected sources and show
      // the guided panel instead of letting capture fail with a raw error.
      await get().refreshPermissions();
      const needed = missingPermissionKinds(get().permissions, requiredPermissionKinds(sources));
      if (needed.length > 0) {
        set({ permissionsNeeded: needed, error: null });
        if (options?.systemDictation) {
          const message = "Microphone access is required. Open Recorder settings to finish setup.";
          set({ dictationState: "error" });
          await audioSystemDictationSetState("error", message).catch(() => {});
        }
        return;
      }

      set({ error: null, permissionsNeeded: [], segments: [], partial: null, copilotEntries: [], diarizing: false });
      let startedMetaId: string | null = null;
      // Speaker identification is always on for retained recordings once the
      // models are present; never a one-shot dictation.
      const diarize =
        options?.diarize !== false &&
        options?.systemDictation !== true &&
        bootstrap?.diarization.installed === true;
      // The start window (model cold-load + getUserMedia + track settle) is
      // seconds wide; if the machine sleeps inside it, roll the whole thing
      // back instead of latching a recording nobody can see.
      const startEpoch = suspendEpoch;
      try {
        const status = await audioTranscriberStart({ modelId, language });
        if (status.state === "error") throw new Error(status.error ?? "Transcriber failed to start.");

        const meta = await audioRecordingStart({
          title,
          language,
          modelId,
          sources,
          ephemeral: options?.systemDictation === true,
          diarize,
        });
        startedMetaId = meta.id;
        const audio = window.__LEGALWORK_ELECTRON__?.audio;
        captureHandle = await startCapture(
          sources,
          {
            onPcm: (chunk) => audio?.sendPcm?.(meta.id, chunk),
            onMediaChunk: (chunk) => audio?.sendMediaChunk?.(meta.id, chunk),
            onSourceEnded: () => {
              if (get().recording?.id === meta.id) void get().stopRecording();
            },
          },
        );
        // Suspended (or a hold-release fired) while we were starting: abandon
        // the half-built recording rather than leave it running post-wake.
        if (suspendEpoch !== startEpoch) {
          await captureHandle.stop().catch(() => {});
          captureHandle = null;
          await audioRecordingCancel(meta.id).catch(() => {});
          set({
            recording: null,
            recordingStartedAt: null,
            dictationRecordingId: null,
            dictationState: options?.systemDictation ? "idle" : get().dictationState,
          });
          if (options?.systemDictation) await audioSystemDictationSetState("idle").catch(() => {});
          return;
        }
        set({
          recording: meta,
          recordingStartedAt: Date.now(),
          dictationRecordingId: options?.systemDictation ? meta.id : null,
          dictationState: options?.systemDictation ? "listening" : get().dictationState,
        });
        if (options?.systemDictation) {
          await audioSystemDictationSetState("listening").catch(() => {});
        }
        levelTimer = window.setInterval(() => {
          if (captureHandle) set({ levels: captureHandle.readLevels() });
        }, 150);
      } catch (error) {
        // Roll back whatever half-started — capture graph first, then the
        // main-process recording entry created by audioRecordingStart (the
        // store's `recording` is still null at this point on failure).
        if (captureHandle) {
          await captureHandle.stop().catch(() => {});
          captureHandle = null;
        }
        if (startedMetaId) await audioRecordingCancel(startedMetaId).catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        // Permission-shaped runtime failures (status looked fine but the OS
        // still refused) get the guided panel, not a raw error banner.
        const permissionKinds = permissionKindsFromCaptureError(message, sources);
        set({
          recording: null,
          recordingStartedAt: null,
          dictationRecordingId: null,
          dictationState: options?.systemDictation ? "error" : get().dictationState,
          permissionsNeeded: permissionKinds,
          error: permissionKinds.length > 0 ? null : message,
        });
        if (options?.systemDictation) {
          await audioSystemDictationSetState("error", message).catch(() => {});
        }
      }
    },

    stopRecording: async () => {
      const recording = get().recording;
      if (!recording || get().finalizing) return;
      const isSystemDictation = get().dictationRecordingId === recording.id;
      // Immediate feedback: the finalize round-trip (flush + transcribe the
      // tail) can take seconds on a long recording, and the Stop button would
      // otherwise sit there looking dead.
      if (!isSystemDictation) set({ finalizing: true });
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      try {
        if (isSystemDictation) {
          set({ dictationState: "transcribing" });
          await audioSystemDictationSetState("transcribing").catch(() => {});
        }
        if (captureHandle) {
          await captureHandle.stop();
          captureHandle = null;
        }
        const meta = await audioRecordingStop(recording.id);
        let dictationError: string | null = null;
        let recordingsAfterDictation: AudioRecordingMeta[] | null = null;
        if (isSystemDictation) {
          const detail = await audioRecordingGet(meta.id);
          const text = (detail?.segments ?? []).map((segment) => segment.text).join(" ").trim();
          try {
            const result = await audioSystemDictationPaste(text);
            dictationError = result.error;
          } catch (error) {
            dictationError = error instanceof Error ? error.message : String(error);
          }
          // Dictation is ephemeral and must never appear in Recordings, even
          // when the paste fails — on failure the text is still on the
          // clipboard (copied), so nothing is silently lost. Always discard it.
          recordingsAfterDictation = await audioRecordingDelete(meta.id).catch(() => null);
          await audioSystemDictationSetState(
            dictationError ? "error" : "idle",
            dictationError ?? "",
          ).catch(() => {});
        }
        if (isSystemDictation) dictationSettleAt = Date.now();
        set((state) => ({
          recording: null,
          recordingStartedAt: null,
          dictationRecordingId: null,
          dictationState: isSystemDictation && dictationError ? "error" : "idle",
          partial: null,
          levels: {},
          diarizing: false,
          finalizing: false,
          error: dictationError,
          // An ephemeral recording (system dictation) must NEVER enter the
          // recordings list. Key off the recording's own flag, not the racy
          // dictationRecordingId, so a loop or state race can't sneak it in.
          // When delete gave us the authoritative post-dictation list, use it.
          recordings:
            recordingsAfterDictation ??
            (isSystemDictation || meta.ephemeral
              ? state.recordings.filter((item) => item.id !== meta.id)
              : [meta, ...state.recordings.filter((item) => item.id !== meta.id)]),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          recording: null,
          recordingStartedAt: null,
          dictationRecordingId: null,
          dictationState: isSystemDictation ? "error" : get().dictationState,
          levels: {},
          diarizing: false,
          finalizing: false,
          error: message,
        });
        if (isSystemDictation) {
          dictationSettleAt = Date.now();
          await audioSystemDictationSetState("error", message).catch(() => {});
        }
      }
      await get().refreshRecordings();
    },

    cancelRecording: async () => {
      const recording = get().recording;
      const isSystemDictation = Boolean(recording && get().dictationRecordingId === recording.id);
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      if (captureHandle) {
        await captureHandle.stop().catch(() => {});
        captureHandle = null;
      }
      if (recording) await audioRecordingCancel(recording.id).catch(() => {});
      set({
        recording: null,
        recordingStartedAt: null,
        dictationRecordingId: null,
        dictationState: "idle",
        partial: null,
        segments: [],
        levels: {},
        diarizing: false,
        finalizing: false,
      });
      if (isSystemDictation) {
        dictationSettleAt = Date.now();
        await audioSystemDictationSetState("idle").catch(() => {});
      }
    },

    importAudioFile: async (file) => {
      if (get().recording || get().importing) return;
      const { modelId, language, bootstrap } = get();
      const model = bootstrap?.models.find((entry) => entry.id === modelId);
      if (!model || model.state !== "installed") {
        set({ error: t("recorder.import_no_model") });
        return;
      }

      set({ importing: { fileName: file.name }, error: null });
      let recordingId: string | null = null;
      try {
        // Load the model and wait until it's ready — a whole file's PCM would
        // otherwise overflow the worker's pre-ready buffer for long recordings.
        const status = await audioTranscriberStart({ modelId, language });
        if (status.state === "error") throw new Error(status.error ?? "Transcriber failed to start.");
        if (get().transcriber.state !== "ready") {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const state = get().transcriber.state;
            if (state === "ready") break;
            if (state === "error") throw new Error(get().transcriber.error ?? "Transcriber failed to load.");
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }

        const { pcm, durationMs } = await decodeAudioFileToPcm16k(file);
        if (pcm.length === 0) throw new Error(t("recorder.import_decode_failed"));

        const meta = await audioImportStart({ title: file.name, fileName: file.name, language, modelId });
        recordingId = meta.id;
        await audioImportSource(meta.id, await file.arrayBuffer());

        const audio = window.__LEGALWORK_ELECTRON__?.audio;
        for (let offset = 0; offset < pcm.length; offset += IMPORT_PCM_CHUNK) {
          const slice = pcm.slice(offset, Math.min(offset + IMPORT_PCM_CHUNK, pcm.length));
          audio?.sendPcm?.(meta.id, slice.buffer);
        }
        const finalMeta = await audioImportFinish(meta.id, durationMs);
        set((state) => ({
          recordings: [finalMeta, ...state.recordings.filter((item) => item.id !== finalMeta.id)],
        }));
      } catch (error) {
        if (recordingId) await audioRecordingCancel(recordingId).catch(() => {});
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ importing: null });
        await get().refreshRecordings();
      }
    },

    deleteRecording: async (recordingId) => {
      const recordings = await audioRecordingDelete(recordingId);
      set((state) => ({
        recordings,
        openedRecording:
          state.openedRecording?.meta.id === recordingId ? null : state.openedRecording,
      }));
    },

    renameRecording: async (recordingId, title) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      try {
        const recordings = await audioRecordingRename(recordingId, trimmed);
        set((state) => {
          const renamed = recordings.find((item) => item.id === recordingId);
          return {
            recordings,
            openedRecording:
              renamed && state.openedRecording?.meta.id === recordingId
                ? { ...state.openedRecording, meta: renamed }
                : state.openedRecording,
            recording:
              renamed && state.recording?.id === recordingId ? renamed : state.recording,
          };
        });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    openRecording: async (recordingId) => {
      const detail = await audioRecordingGet(recordingId);
      set({ openedRecording: detail });
    },

    closeOpenedRecording: () => set({ openedRecording: null }),

    saveRecordingToWorkspace: async (recordingId, workspacePath) => {
      const result = await audioRecordingSaveToWorkspace(recordingId, workspacePath);
      if (!result.ok) {
        set({ error: result.error ?? "Could not save to workspace." });
        return null;
      }
      return result.folderPath;
    },

    getInsertableTranscript: () => {
      const { segments, openedRecording } = get();
      const source = openedRecording ? openedRecording.segments : segments;
      return transcriptText(source, 100_000).trim();
    },

    startLiveTranscriptShare: async (sessionId, workspacePath, directory) => {
      const root = workspacePath?.trim();
      if (!root) {
        set({ error: t("recorder.context_inject_no_session") });
        return false;
      }
      let fileName = "live-call-transcript.md";
      try {
        const result = await audioLiveTranscriptStart(root);
        if (!result.ok) {
          set({ error: result.error ?? "Could not start the live transcript." });
          return false;
        }
        if (result.fileName) fileName = result.fileName;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        return false;
      }

      // Tell the agent — once, invisibly (synthetic + noReply) — that a growing
      // transcript file exists to read on demand. No repeated pasting.
      const client = copilotContext?.getClient();
      if (client) {
        const body = t("recorder.live_share_notice").replace("{file}", fileName);
        try {
          unwrap(
            await client.session.promptAsync({
              sessionID: sessionId,
              directory: directory || copilotContext?.getDirectory() || undefined,
              noReply: true,
              parts: [{ type: "text", text: body, synthetic: true }],
            }),
          );
        } catch {
          // The file is already live; a failed notice shouldn't block the toggle.
        }
      }
      set({ liveTranscriptSessionId: sessionId });
      return true;
    },

    stopLiveTranscriptShare: async () => {
      await audioLiveTranscriptStop().catch(() => {});
      set({ liveTranscriptSessionId: null });
    },

    setOverlayVisible: async (visible) => {
      try {
        const result = await audioOverlaySetVisible(visible);
        set({ overlayVisible: result.visible });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    ask: async (question) => {
      const trimmed = question.trim();
      if (!trimmed) return;
      await answerAsk(`ask-${Date.now().toString(36)}`, "question", trimmed);
    },

    suggestFollowUps: async () => {
      await answerAsk(`ask-${Date.now().toString(36)}`, "suggestions", t("recorder.copilot_suggest_prompt"));
    },

    clearError: () => set({ error: null }),
  };
});

// Expose the reveal helper here so the pane stays free of dunder commands.
export async function revealRecording(meta: AudioRecordingMeta) {
  await desktopBridge.__revealItemInDir(meta.folderPath);
}
