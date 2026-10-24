/**
 * Recorder runtime store (module-level, mirrors the Voice Mode pattern):
 * bootstraps the local model manager, drives capture + live transcription,
 * keeps the transcript, and answers call-overlay questions through the
 * workspace's OpenCode session AI.
 */

import { create } from "zustand";

import {
  audioCaptureOpenSettings,
  audioMeetingGet,
  audioMeetingDetectionSet,
  audioMeetingSetState,
  audioCapturePermissions,
  audioCapturePermissionsRequest,
  audioDiarizationDownload,
  audioModelDelete,
  audioModelDownload,
  audioModelDownloadCancel,
  audioOverlaySetVisible,
  audioRecorderBootstrap,
  audioSystemDictationGet,
  audioSystemDictationMicrophoneActive,
  audioSystemDictationMicrophoneSelect,
  audioSystemDictationOpenSettings,
  audioSystemDictationPaste,
  audioSystemDictationReadiness,
  audioSystemDictationRepairPermission,
  audioSystemDictationRequestPermission,
  audioSystemDictationSetAppearance,
  audioSystemDictationSetEnabled,
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
  audioRecordingSetProject,
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
  AudioDictationPermissionKind,
  AudioDictationReadiness,
  AudioDictationMicrophoneState,
  AudioPermissionKind,
  AudioRecorderBootstrap,
  AudioRecorderEvent,
  AudioRecordingDetail,
  AudioRecordingMeta,
  AudioMeetingStatus,
  AudioSystemDictationRuntimeState,
  AudioSystemDictationStatus,
  AudioDictationAppearance,
  AudioTranscribeLanguage,
  AudioTranscriberStatus,
  AudioTranscriptSegment,
} from "@legalwork/types/audio";
import { currentLocale, t } from "@/i18n";
import { MODEL_TIERS, isPremiumEntitled, isPremiumEntitlementKnown, tierForModelId } from "./model-tiers";

import { decodeAudioFileToPcm16k, startCapture, type CaptureHandle, type CaptureLevels } from "./capture";
import { refreshDictationMicrophones } from "./dictation-microphone";
import { formatDictationShortcut } from "./dictation-shortcut";

/** PCM chunk size when streaming a decoded file to the worker (~1 s at 16 kHz). */
const IMPORT_PCM_CHUNK = 16000;

const MODEL_PREF_KEY = "legalwork.recorder.model";
const LANGUAGE_PREF_KEY = "legalwork.recorder.language";
const SOURCES_PREF_KEY = "legalwork.recorder.sources";
const TRANSCRIPTION_SOURCE_PREF_KEY = "legalwork.recorder.transcription-source";
const CLOUD_MODEL_PREF_KEY = "legalwork.recorder.cloud-model";

function setDictationFeedback(state: AudioSystemDictationRuntimeState, message = "") {
  // Composer dictation owns its feedback and inserts directly into its draft.
  if (useRecorderStore.getState().composerDictation) return Promise.resolve();
  return audioSystemDictationSetState(state, message, currentLocale());
}

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

let liveTranscriptShareRevision = 0;

export type RecorderState = {
  transcriptionSource: "local" | "cloud";
  cloudModelId: string;
  initialized: boolean;
  bootstrap: AudioRecorderBootstrap | null;
  permissions: AudioCapturePermissions | null;
  /** Permissions blocking the selected sources — non-empty shows the guided panel. */
  permissionsNeeded: AudioPermissionKind[];
  transcriber: AudioTranscriberStatus;
  recording: AudioRecordingMeta | null;
  recordingStartedAt: number | null;
  segments: AudioTranscriptSegment[];
  partials: AudioTranscriptSegment[];
  recordings: AudioRecordingMeta[];
  openedRecording: AudioRecordingDetail | null;
  /** A file drag-dropped for transcription is being decoded/transcribed. */
  importing: { fileName: string } | null;
  levels: CaptureLevels;
  overlayVisible: boolean;
  copilotEntries: CopilotEntry[];
  /** Session whose chat currently mirrors the live transcript to a file, if any. */
  liveTranscriptSessionId: string | null;
  liveTranscriptWorkspacePath: string | null;
  liveTranscriptNotifiedSessions: string[];
  liveTranscriptDismissedPaths: string[];
  error: string | null;
  systemDictation: AudioSystemDictationStatus | null;
  meeting: AudioMeetingStatus | null;
  /** Live OS permission readiness for "Dictate anywhere" (setup wizard). */
  dictationReadiness: AudioDictationReadiness | null;
  dictationMicrophones: AudioDictationMicrophoneState | null;
  dictationState: AudioSystemDictationRuntimeState;
  dictationRecordingId: string | null;
  composerDictation: { ownerId: string; onComplete: (text: string) => void | Promise<void> } | null;
  composerDictationLevel: number;
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
  starting: boolean;
  /**
   * Testing-only: model ids whose premium/device gate the user dismissed this
   * session, so they can be exercised before auth exists. Per-model (not a
   * global flag) so every gated model still prompts once. Resets on reload.
   */
  unlockedModels: string[];
};

type RecorderActions = {
  setTranscriptionSource: (source: "local" | "cloud", cloudModelId?: string) => void;
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
  /**
   * Re-assert the premium gate against the CURRENT subscription: if the active
   * model is a premium tier and the firm no longer has an active sub (and it
   * wasn't test-unlocked), fall back to the best installed free tier so
   * transcription keeps working even though a premium model is already on disk.
   * Called by the entitlement sync on every plan change and after bootstrap.
   */
  enforcePremiumGate: () => void;
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
    options?: { sources?: AudioCaptureSourceKind[]; systemDictation?: boolean; diarize?: boolean; projectId?: string },
  ) => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  refreshSystemDictation: () => Promise<void>;
  refreshDictationMicrophones: () => Promise<void>;
  selectDictationMicrophone: (selection: string) => Promise<void>;
  /** Probe all OS permissions dictation needs; may heal a dead hotkey monitor. */
  refreshDictationReadiness: () => Promise<void>;
  /** Strongest available re-prompt for one permission (prompt or pane link). */
  requestDictationPermission: (kind: AudioDictationPermissionKind) => Promise<void>;
  /** Reset the app's own stale TCC entries for one permission, then re-prompt. */
  repairDictationPermission: (kind: AudioDictationPermissionKind) => Promise<void>;
  setDictationAppearance: (appearance: AudioDictationAppearance) => Promise<void>;
  setSystemDictationEnabled: (enabled: boolean) => Promise<void>;
  setSystemDictationShortcut: (accelerator: string) => Promise<boolean>;
  setSystemDictationShortcutCapture: (active: boolean) => Promise<void>;
  openSystemDictationSettings: () => Promise<void>;
  startSystemDictation: () => Promise<void>;
  startComposerDictation: (ownerId: string, onComplete: (text: string) => void | Promise<void>, signal?: AbortSignal) => Promise<void>;
  refreshMeeting: () => Promise<void>;
  setMeetingDetection: (enabled: boolean) => Promise<void>;
  startMeetingRecording: (title?: string) => Promise<void>;
  /** Transcribe a dropped/opened audio file locally; adds it to Recordings. */
  importAudioFile: (file: File) => Promise<void>;
  deleteRecording: (recordingId: string) => Promise<void>;
  renameRecording: (recordingId: string, title: string) => Promise<void>;
  setRecordingProject: (recordingId: string, projectId: string, linked: boolean) => Promise<void>;
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
  startLiveTranscriptShare: (sessionId: string, workspacePath: string, directory?: string, sessionClient?: Client, automatic?: boolean) => Promise<boolean>;
  stopLiveTranscriptShare: () => Promise<void>;
  setOverlayVisible: (visible: boolean) => Promise<void>;
  ask: (question: string) => Promise<void>;
  suggestFollowUps: () => Promise<void>;
  clearError: () => void;
};

type TranscriptionSelection = Pick<RecorderState, "bootstrap" | "transcriptionSource" | "modelId" | "cloudModelId">;
export function transcriptionModelId(state: TranscriptionSelection): string {
  return state.transcriptionSource === "cloud" ? state.cloudModelId : state.modelId;
}

export function isTranscriptionReady(state: TranscriptionSelection): boolean {
  if (state.transcriptionSource === "cloud") return state.bootstrap?.cloud?.models.some(
    model => model.model === state.cloudModelId && model.enabled && model.available,
  ) === true;
  return state.bootstrap?.engine.available !== false && state.bootstrap?.models.some(
    model => model.id === state.modelId && model.state === "installed",
  ) === true;
}

/** Availability can recover; capture, storage and interrupted-stream errors need attention. */
export function isCloudAvailabilityError(state: Pick<RecorderState, "transcriptionSource" | "error">): boolean {
  return state.transcriptionSource === "cloud" && state.error !== null && (
    /^Cloud transcription is (?:currently )?unavailable\./.test(state.error)
    || state.error === t("recorder.transcription_not_ready")
  );
}

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
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
  // Default to capturing both the mic and system audio (call recordings want
  // both); unsupported sources are filtered out at capture time per platform.
  const raw = readPref(SOURCES_PREF_KEY, "microphone,system");
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is AudioCaptureSourceKind => item === "microphone" || item === "system");
  return parsed.length ? parsed : ["microphone", "system"];
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

/**
 * Kinds not yet granted — used to surface the permission panel PROACTIVELY (on
 * entering the recorder) rather than only after a failed start. Unlike
 * {@link missingPermissionKinds}, an undetermined microphone counts here too so
 * the user can grant everything the raw recorder needs up front.
 */
function ungrantedPermissionKinds(
  permissions: AudioCapturePermissions | null,
  kinds: AudioPermissionKind[],
): AudioPermissionKind[] {
  if (!permissions) return [];
  return kinds.filter((kind) => {
    const state = permissions[kind];
    return state !== "granted" && state !== "unknown";
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
// Cancel in-flight work without deleting a recording another operation is flushing.
let dictationCancelled = false;
let dictationShortPress = false;
let dictationHoldStopPending = false;
let dictationCancelPending = false;
let dictationStartController: AbortController | null = null;
let meetingStartPending = false;
let recordingStartPending = false;
// When the last dictation settled (stopped or canceled). A brand-new dictation
// that tries to start within a beat of the previous one ending is not a human
// key press — it's a runaway restart (e.g. an empty "no speech" result looping
// straight back into listening). We refuse it so the loop can't run away.
let dictationSettleAt = 0;
const DICTATION_RESTART_COOLDOWN_MS = 200;
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
  let bootstrapRevision = 0;
  const clearCloudAvailabilityError = () => {
    const state = get();
    if (!state.starting && !state.finalizing && isCloudAvailabilityError(state)) set({ error: null });
  };

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

  const cancelledDictationFeedback = () => {
    const status = get().systemDictation;
    return dictationShortPress && status
      ? setDictationFeedback("idle", t("recorder.dictation_hold_to_speak", {
          shortcut: formatDictationShortcut(status.accelerator, status.platform),
        }))
      : setDictationFeedback("cancelled");
  };

  const finishReleasedDictation = async () => {
    if (!dictationHoldReleased || dictationCancelled || !get().dictationRecordingId || dictationHoldStopPending) return;
    dictationHoldStopPending = true;
    await get().stopRecording().finally(() => { dictationHoldStopPending = false; });
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
        if (state.recording?.id === event.streamId) {
          clearCloudAvailabilityError();
          set(current => ({ partials: [...current.partials.filter(partial => partial.source !== event.segment.source), ...(event.parts ?? [event.segment])] }));
        }
        break;
      }
      case "transcript-segment": {
        if (state.recording?.id === event.streamId) {
          clearCloudAvailabilityError();
          set((current) => ({
            segments: [...current.segments, event.segment].sort((a, b) => a.startMs - b.startMs),
            partials: current.partials.filter(partial => partial.source !== event.segment.source || partial.endMs > event.segment.endMs),
          }));
        }
        break;
      }
      case "transcript-speakers-updated": {
        if (state.recording?.id === event.streamId) {
          const updates = new Map(event.segments.map(segment => [segment.id, segment]));
          const replaced = new Set(event.replacedIds ?? event.segments.map(segment => segment.id));
          set(current => ({
            segments: [...current.segments.filter(segment => !replaced.has(segment.id) && !updates.has(segment.id)), ...event.segments].sort((a, b) => a.startMs - b.startMs),
            recording: current.recording ? { ...current.recording, speakerNames: event.speakerNames } : null,
          }));
        }
        break;
      }
      case "recording-warning": {
        if (state.recording?.id === event.recordingId) set({ error: event.error });
        break;
      }
      case "recording-updated": {
        set(current => ({ recordings: current.recordings.map(meta => meta.id === event.meta.id ? event.meta : meta) }));
        if (state.openedRecording?.meta.id === event.meta.id) {
          void audioRecordingGet(event.meta.id).then(detail => {
            if (get().openedRecording?.meta.id === event.meta.id) set({ openedRecording: detail });
          }).catch(() => {});
        }
        break;
      }
      case "transcript-partial-clear": {
        if (state.recording?.id === event.streamId) {
          set((current) => ({
            partials: current.partials.filter(partial => partial.source !== event.source || partial.endMs > event.endMs),
          }));
        }
        break;
      }
      case "recording-error": {
        set({ error: event.error });
        if (state.transcriptionSource === "cloud" && state.recording?.id === event.recordingId && !state.finalizing) void get().stopRecording();
        break;
      }
      case "meeting-status": {
        set({ meeting: event.status });
        break;
      }
      case "meeting-recording-start": {
        void get().startMeetingRecording(event.title);
        break;
      }
      case "meeting-recording-stop": {
        if (state.recording && !state.recording.ephemeral && !state.finalizing) void get().stopRecording();
        break;
      }
      case "meeting-recording-open": {
        window.dispatchEvent(new Event("legalwork:open-recorder"));
        // Settings has its own route; open the existing recorder surface
        // without reloading the renderer or interrupting audio capture.
        if (window.location.hash.includes("/settings/")) {
          window.location.hash = window.location.hash.replace(/\/settings\/.*$/, "/session?recorder=1");
        }
        break;
      }
      case "system-dictation-toggle": {
        if (dictationTogglePending) {
          if (state.dictationState === "starting") void get().cancelRecording();
          break;
        }
        if (state.finalizing) break;
        dictationTogglePending = true;
        dictationHoldReleased = false;
        const toggleEpoch = suspendEpoch;
        void (async () => {
          try {
            await get().init();
            if (toggleEpoch !== suspendEpoch) return;
            if (get().dictationRecordingId) await get().stopRecording();
            else await get().startSystemDictation();
          } finally {
            dictationTogglePending = false;
            await finishReleasedDictation();
          }
        })();
        break;
      }
      case "system-dictation-press": {
        if (dictationHoldStartPending || state.dictationRecordingId || state.finalizing || state.dictationState === "starting") break;
        dictationHoldReleased = false;
        dictationCancelled = false;
        dictationShortPress = false;
        dictationHoldStartPending = true;
        const pressEpoch = suspendEpoch;
        void (async () => {
          try {
            await get().init();
            if (dictationCancelled || dictationHoldReleased || pressEpoch !== suspendEpoch) {
              await cancelledDictationFeedback().catch(() => {});
              return;
            }
            await get().startSystemDictation();
          } finally {
            dictationHoldStartPending = false;
            await finishReleasedDictation();
          }
        })();
        break;
      }
      case "system-dictation-release": {
        dictationHoldReleased = true;
        // There is no usable capture to finish yet. Repeated taps must not
        // queue an empty transcription behind a slow microphone request.
        if (state.dictationState === "starting") {
          void get().cancelRecording();
          break;
        }
        if (!dictationHoldStartPending && !dictationTogglePending && !state.finalizing) void finishReleasedDictation();
        break;
      }
      case "system-dictation-stop": {
        if (state.dictationState === "starting") {
          void get().cancelRecording();
          break;
        }
        // The explicit finish button always inserts, including a short phrase.
        if (state.dictationRecordingId && !state.finalizing && !dictationHoldStopPending) {
          dictationHoldStopPending = true;
          void get().stopRecording().finally(() => { dictationHoldStopPending = false; });
        }
        break;
      }
      case "system-dictation-cancel": {
        dictationShortPress = event.reason === "short-press";
        if (dictationHoldStartPending) dictationCancelled = true;
        if ((state.dictationRecordingId || state.dictationState === "starting") && !dictationCancelPending) {
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
      case "system-dictation-microphones": {
        set({ dictationMicrophones: event.status });
        break;
      }
      case "power-suspend": {
        dictationShortPress = false;
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
        set({ liveTranscriptSessionId: null, liveTranscriptWorkspacePath: null });
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
    transcriptionSource: readPref(TRANSCRIPTION_SOURCE_PREF_KEY, "local") === "cloud" ? "cloud" : "local",
    cloudModelId: readPref(CLOUD_MODEL_PREF_KEY, ""),
    initialized: false,
    bootstrap: null,
    permissions: null,
    permissionsNeeded: [],
    transcriber: { state: "idle", modelId: null, error: null },
    recording: null,
    recordingStartedAt: null,
    segments: [],
    partials: [],
    recordings: [],
    openedRecording: null,
    importing: null,
    levels: {},
    overlayVisible: false,
    copilotEntries: [],
    liveTranscriptSessionId: null,
    liveTranscriptWorkspacePath: null,
    liveTranscriptNotifiedSessions: [],
    liveTranscriptDismissedPaths: [],
    error: null,
    systemDictation: null,
    meeting: null,
    dictationReadiness: null,
    dictationMicrophones: null,
    dictationState: "idle",
    dictationRecordingId: null,
    composerDictation: null,
    composerDictationLevel: 0,
    modelId: readPref(MODEL_PREF_KEY, ""),
    language: readLanguagePref(),
    sources: readSourcesPref(),
    diarizing: false,
    finalizing: false,
    starting: false,
    unlockedModels: [],

    init: async () => {
      if (!eventsSubscribed) {
        eventsSubscribed = true;
        window.__LEGALWORK_ELECTRON__?.audio?.onEvent?.(handleEvent);
        if (typeof navigator !== "undefined") {
          navigator.mediaDevices?.addEventListener("devicechange", () => { void get().refreshDictationMicrophones(); });
        }
      }
      if (get().initialized) return;
      set({ initialized: true });
      await Promise.all([
        get().refreshBootstrap(),
        get().refreshRecordings(),
        get().refreshPermissions(),
        get().refreshSystemDictation(),
        get().refreshDictationMicrophones(),
        get().refreshMeeting(),
      ]);
      // Surface any OS permission the raw recorder still needs (microphone /
      // the macOS system-audio recording pane) up front, so the user grants it
      // before pressing Record instead of bouncing off a failed start.
      const needed = ungrantedPermissionKinds(
        get().permissions,
        requiredPermissionKinds(get().sources),
      );
      if (needed.length) set({ permissionsNeeded: needed });
      void get().prewarm();
      void get().ensureDiarizationReady();
      if (get().dictationState === "idle") void setDictationFeedback("idle").catch(() => {});
    },

    /**
     * Speaker identification is always on, so pull its models in the
     * background the first time — recordings then just get labeled without the
     * user ever setting anything up.
     */
    ensureDiarizationReady: async () => {
      if (get().transcriptionSource === "cloud") return;
      const diarization = get().bootstrap?.diarization;
      if (!diarization || diarization.installed || diarization.downloading) return;
      await get().downloadDiarization();
    },

    refreshBootstrap: async () => {
      const revision = ++bootstrapRevision;
      try {
        const result = await audioRecorderBootstrap();
        if (revision !== bootstrapRevision) return;
        // A failed background check is not evidence that a working model was
        // disabled. Keep the last choices until a successful check replaces them.
        const previousCloud = get().bootstrap?.cloud;
        const bootstrap = result.cloud?.error && previousCloud
          ? { ...result, cloud: { ...result.cloud, models: previousCloud.models } }
          : result;
        set({ bootstrap });
        if (!bootstrap.cloud?.error && isTranscriptionReady(get())) clearCloudAvailabilityError();
        // Clear a stale selection that no longer maps to a real model (e.g. an
        // old Base/Turbo tier) so the user consciously picks + downloads one.
        // Never auto-select a model on their behalf — recording requires an
        // explicit, installed choice.
        const chosen = get().modelId;
        if (chosen && !bootstrap.models.some((model) => model.id === chosen)) {
          set({ modelId: "" });
        }
        // A premium model may have been downloaded under a sub that has since
        // lapsed — fall back to a free tier now that bootstrap knows what's
        // installed.
        get().enforcePremiumGate();
      } catch {
        // Navigation/focus refreshes must not create sticky recording errors.
        // Keep the last snapshot; actual recording failures are reported at start.
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

    refreshDictationMicrophones: async () => {
      try {
        set({ dictationMicrophones: await refreshDictationMicrophones() });
      } catch {
        // Microphone discovery can be unavailable before permission is granted.
      }
    },

    selectDictationMicrophone: async (selection) => {
      try {
        set({ dictationMicrophones: await audioSystemDictationMicrophoneSelect(selection), error: null });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    refreshDictationReadiness: async () => {
      try {
        const readiness = await audioSystemDictationReadiness();
        set({ dictationReadiness: readiness });
        // The probe may have healed (restarted) the hotkey monitor — pick up
        // the refreshed registration state.
        await get().refreshSystemDictation();
      } catch {
        // Plain web and older desktop builds do not expose this feature.
      }
    },

    requestDictationPermission: async (kind) => {
      try {
        const readiness = await audioSystemDictationRequestPermission(kind);
        set({ dictationReadiness: readiness });
        await get().refreshSystemDictation();
      } catch {
        // Bridge unavailable — the wizard's settings links remain the manual path.
      }
    },

    repairDictationPermission: async (kind) => {
      try {
        const readiness = await audioSystemDictationRepairPermission(kind);
        set({ dictationReadiness: readiness });
        await get().refreshSystemDictation();
      } catch {
        // Bridge unavailable — the wizard's settings links remain the manual path.
      }
    },

    setDictationAppearance: async (appearance) => {
      try {
        set({ systemDictation: await audioSystemDictationSetAppearance(appearance), error: null });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    setSystemDictationEnabled: async (enabled) => {
      if (!enabled && !get().composerDictation && (get().dictationRecordingId || get().dictationState === "starting")) {
        await get().cancelRecording();
      }
      try {
        const status = await audioSystemDictationSetEnabled(enabled);
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

    refreshMeeting: async () => {
      try { set({ meeting: await audioMeetingGet() }); } catch { /* Plain web has no floating recorder. */ }
    },

    setMeetingDetection: async (enabled) => {
      try { set({ meeting: await audioMeetingDetectionSet(enabled) }); }
      catch (error) { set({ error: error instanceof Error ? error.message : String(error) }); }
    },

    startMeetingRecording: async (title) => {
      if (meetingStartPending) return;
      if (get().finalizing) {
        await audioMeetingSetState("saving", get().recording?.id)
          .catch(() => audioMeetingSetState("idle").catch(() => {}));
        return;
      }
      meetingStartPending = true;
      const startEpoch = suspendEpoch;
      try {
        await get().init();
        if (!get().bootstrap) await get().refreshBootstrap();
        const current = get().recording;
        if (current && !current.ephemeral) {
          await audioMeetingSetState("recording", current.id).catch(() => {});
          return;
        }
        if (recordingStartPending || dictationHoldStartPending || dictationTogglePending || get().dictationState === "starting" || get().dictationRecordingId) {
          throw new Error(t("recorder.stop_session_first"));
        }
        if (!isTranscriptionReady(get())) throw new Error(t("recorder.transcription_not_ready"));
        await audioMeetingSetState("starting");
        await get().startRecording(title || t("recorder.meeting_recording_title"), { sources: ["microphone", "system"] });
        if (suspendEpoch !== startEpoch) { await audioMeetingSetState("idle").catch(() => {}); return; }
        if (!get().recording) throw new Error(get().error || t("recorder.meeting_setup_required"));
      } catch (error) {
        if (suspendEpoch !== startEpoch) { await audioMeetingSetState("idle").catch(() => {}); return; }
        const message = error instanceof Error ? error.message : String(error);
        await audioMeetingSetState("error", undefined, message).catch(() => {});
      } finally { meetingStartPending = false; }
    },

    startComposerDictation: async (ownerId, onComplete, signal) => {
      await get().init();
      if (!get().bootstrap) await get().refreshBootstrap();
      if (signal?.aborted) return;
      if (get().recording || get().starting || get().finalizing || get().importing || recordingStartPending || meetingStartPending || get().dictationState === "starting") {
        throw new Error(t("recorder.stop_session_first"));
      }
      if (!isTranscriptionReady(get())) throw new Error(t("recorder.transcription_not_ready"));
      dictationCancelled = false;
      dictationShortPress = false;
      set({ composerDictation: { ownerId, onComplete }, composerDictationLevel: 0, dictationState: "starting", error: null });
      try {
        await get().startRecording("Chat dictation", { sources: ["microphone"], systemDictation: true });
        if (!get().dictationRecordingId && !dictationCancelled) {
          throw new Error(get().error ?? t("recorder.mic_access_required"));
        }
      } finally {
        if (!get().dictationRecordingId) set({ composerDictation: null, composerDictationLevel: 0, dictationState: "idle" });
      }
    },

    startSystemDictation: async () => {
      const { systemDictation, recording } = get();
      if (!systemDictation?.enabled || !systemDictation.registered) return;
      if (get().finalizing || meetingStartPending || recordingStartPending || get().dictationState === "starting") return;
      // Guard against a runaway restart loop: a start that lands within a beat
      // of the previous dictation ending is usually key bounce. Keep the last
      // completion feedback instead of flashing the HUD back to idle.
      if (Date.now() - dictationSettleAt < DICTATION_RESTART_COOLDOWN_MS) {
        return;
      }
      if (recording) {
        const message = t("recorder.stop_session_first");
        set({ error: message, dictationState: "error" });
        await setDictationFeedback("error", message).catch(() => {});
        return;
      }
      if (!isTranscriptionReady(get())) {
        const message = t("recorder.transcription_not_ready");
        set({ error: message, dictationState: "error" });
        await setDictationFeedback("error", message).catch(() => {});
        return;
      }
      dictationCancelled = false;
      dictationShortPress = false;
      set({ dictationState: "starting", error: null });
      await setDictationFeedback("starting").catch(() => {});
      await get().startRecording("System dictation", {
        sources: ["microphone"],
        systemDictation: true,
      });
    },

    setModelId: (modelId) => {
      if (get().recording || get().starting || get().finalizing || get().importing) return;
      // A premium tier requires an ACTIVE subscription — not just being signed
      // in, and not merely having the model already downloaded. Without an
      // active sub (and no test-unlock) the selection is refused so the gate /
      // upsell surfaces instead. `enforcePremiumGate` handles the case where a
      // premium model was already selected when the sub lapsed.
      const model = get().bootstrap?.models.find((entry) => entry.id === modelId);
      if (
        model?.plan === "premium" &&
        !isPremiumEntitled() &&
        !get().unlockedModels.includes(modelId)
      ) {
        return;
      }
      writePref(MODEL_PREF_KEY, modelId);
      writePref(TRANSCRIPTION_SOURCE_PREF_KEY, "local");
      set({ modelId, transcriptionSource: "local", error: null });
      void get().prewarm();
    },

    setTranscriptionSource: (source, cloudModelId) => {
      if (get().recording || get().starting || get().finalizing || get().importing) return;
      const selected = cloudModelId ?? get().cloudModelId;
      if (source === "cloud" && !get().bootstrap?.cloud?.models.some(model => model.model === selected && model.enabled && model.available)) return;
      writePref(TRANSCRIPTION_SOURCE_PREF_KEY, source);
      if (source === "cloud") writePref(CLOUD_MODEL_PREF_KEY, selected);
      set({ transcriptionSource: source, cloudModelId: selected, error: null });
      void get().prewarm();
    },

    enforcePremiumGate: () => {
      // Don't demote anything until we actually know the sub state — otherwise a
      // cold start (entitlements not fetched yet) would strip a subscriber's
      // premium model before their plan loads.
      if (!isPremiumEntitlementKnown()) return;
      const { modelId, bootstrap, unlockedModels } = get();
      const tier = tierForModelId(modelId);
      // Only premium tiers are gated; free tiers and test-unlocked models stay.
      if (!tier?.premium || isPremiumEntitled() || unlockedModels.includes(modelId)) return;
      // Fall back to the best INSTALLED free tier (Standard, then Basic, then any
      // installed non-premium model). The premium weights stay on disk for when
      // the sub comes back — we just stop using them.
      const freeFallback =
        [...MODEL_TIERS]
          .filter((entry) => !entry.premium)
          .reverse()
          .map((entry) => bootstrap?.models.find((m) => m.id === entry.modelId))
          .find((m) => m?.state === "installed")?.id ??
        bootstrap?.models.find((m) => m.plan !== "premium" && m.state === "installed")?.id ??
        "";
      if (freeFallback === modelId) return;
      writePref(MODEL_PREF_KEY, freeFallback);
      set({ modelId: freeFallback });
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
      if (get().transcriptionSource === "cloud") return;
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
      if (recordingStartPending || get().starting || get().importing || get().finalizing) return;
      recordingStartPending = true;
      const startController = options?.systemDictation ? new AbortController() : null;
      dictationStartController = startController;
      set({ starting: true });
      try {
        const { language, recording, bootstrap } = get();
        const modelId = transcriptionModelId(get());
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
        if (options?.systemDictation && dictationCancelled) {
          set({ dictationState: "idle" });
          await cancelledDictationFeedback().catch(() => {});
          return;
        }
        const needed = missingPermissionKinds(get().permissions, requiredPermissionKinds(sources));
        if (needed.length > 0) {
          set({ permissionsNeeded: needed, error: null });
          if (options?.systemDictation) {
            const message = t("recorder.mic_access_required");
            set({ dictationState: "error" });
            await setDictationFeedback("error", message).catch(() => {});
          }
          return;
        }

        set({ error: null, permissionsNeeded: [], segments: [], partials: [], copilotEntries: [], diarizing: false });
        let startedMetaId: string | null = null;
        // Speaker identification is always on for retained recordings once the
        // models are present; never a one-shot dictation.
        const diarize =
          options?.diarize !== false &&
          options?.systemDictation !== true &&
          (get().transcriptionSource === "cloud" || bootstrap?.diarization.installed === true);
        // The start window (model cold-load + getUserMedia + track settle) is
        // seconds wide; if the machine sleeps inside it, roll the whole thing
        // back instead of latching a recording nobody can see.
        const startEpoch = suspendEpoch;
        try {
          if (!isTranscriptionReady(get())) throw new Error(t("recorder.transcription_not_ready"));
          const status = await audioTranscriberStart({ modelId, language });
          startController?.signal.throwIfAborted();
          if (status.state === "error") throw new Error(status.error ?? t("recorder.transcriber_start_failed"));

          const meta = await audioRecordingStart({
            title,
            language,
            modelId,
            sources,
            separateSources: sources.length > 1,
            ephemeral: options?.systemDictation === true,
            projectId: options?.projectId,
            diarize,
          });
          startedMetaId = meta.id;
          startController?.signal.throwIfAborted();
          const audio = window.__LEGALWORK_ELECTRON__?.audio;
          captureHandle = await startCapture(
            sources,
            {
              onPcm: (chunk, source) => audio?.sendPcm?.(meta.id, chunk, source),
              onMeter: (level) => {
                if (get().composerDictation) set({ composerDictationLevel: level });
                else if (options?.systemDictation) audio?.sendDictationLevel?.(level);
                else audio?.sendMeetingLevel?.(meta.id, level);
              },
              onMicrophone: options?.systemDictation && !get().composerDictation
                ? (name) => { void audioSystemDictationMicrophoneActive(name).catch(() => {}); } : undefined,
              onMediaChunk: (chunk, source) => audio?.sendMediaChunk?.(meta.id, chunk, source),
              onSourceEnded: () => {
                if (get().recording?.id === meta.id) void get().stopRecording();
              },
            },
            { dictation: options?.systemDictation === true, signal: startController?.signal },
          );
          if (get().transcriptionSource === "cloud" && get().error) throw new Error(get().error ?? t("recorder.transcription_not_ready"));
          // Suspended or canceled while we were starting: abandon
          // the half-built recording rather than leave it running post-wake.
          if (suspendEpoch !== startEpoch || (options?.systemDictation && dictationCancelled)) {
            await captureHandle.stop().catch(() => {});
            captureHandle = null;
            await audioRecordingCancel(meta.id).catch(() => {});
            set({
              recording: null,
              recordingStartedAt: null,
              dictationRecordingId: null,
              dictationState: options?.systemDictation ? "idle" : get().dictationState,
            });
            if (options?.systemDictation) {
              await (dictationCancelled ? cancelledDictationFeedback() : setDictationFeedback("idle")).catch(() => {});
            }
            return;
          }
          set({
            recording: meta,
            liveTranscriptNotifiedSessions: [],
            liveTranscriptDismissedPaths: [],
            recordingStartedAt: Date.now(),
            dictationRecordingId: options?.systemDictation ? meta.id : null,
            dictationState: options?.systemDictation ? "listening" : get().dictationState,
          });
          levelTimer = window.setInterval(() => {
            if (captureHandle) set({ levels: captureHandle.readLevels() });
          }, 150);
          if (options?.systemDictation) {
            await setDictationFeedback("listening").catch(() => {});
          } else {
            await audioMeetingSetState("recording", meta.id).catch(() => {});
          }
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
          const cancelled = options?.systemDictation && (dictationCancelled || suspendEpoch !== startEpoch);
          set({
            recording: null,
            recordingStartedAt: null,
            dictationRecordingId: null,
            dictationState: options?.systemDictation ? cancelled ? "idle" : "error" : get().dictationState,
            permissionsNeeded: cancelled ? [] : permissionKinds,
            error: cancelled || permissionKinds.length > 0 ? null : message,
          });
          if (options?.systemDictation) {
            await (cancelled ? cancelledDictationFeedback() : setDictationFeedback("error", message)).catch(() => {});
          } else {
            await audioMeetingSetState("error", undefined, message).catch(() => {});
          }
        }
      } finally {
        dictationStartController = null;
        recordingStartPending = false;
        set({ starting: false });
      }
    },

    stopRecording: async () => {
      const recording = get().recording;
      if (!recording || get().finalizing) return;
      const isSystemDictation = get().dictationRecordingId === recording.id;
      const composerDictation = get().composerDictation;
      // Immediate feedback: the finalize round-trip (flush + transcribe the
      // tail) can take seconds on a long recording, and the Stop button would
      // otherwise sit there looking dead.
      const stopEpoch = suspendEpoch;
      let captureError: string | null = null;
      set({ finalizing: true });
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      try {
        if (isSystemDictation) {
          set({ dictationState: "transcribing" });
          await setDictationFeedback("transcribing").catch(() => {});
        } else {
          await audioMeetingSetState("saving", recording.id).catch(() => {});
        }
        if (captureHandle) {
          try { await captureHandle.stop(); }
          catch (error) {
            if (isSystemDictation) throw error;
            // Save the audio already streamed to disk even if the final
            // capture packet failed. A meeting must remain recoverable.
            captureError = error instanceof Error ? error.message : String(error);
          } finally { captureHandle = null; }
        }
        const meta = await audioRecordingStop(recording.id);
        const transcriptionError = meta.status === "error" ? meta.error || "Transcription failed." : null;
        let dictationError: string | null = transcriptionError;
        let recordingsAfterDictation: AudioRecordingMeta[] | null = null;
        if (isSystemDictation) {
          const detail = await audioRecordingGet(meta.id);
          const text = (detail?.segments ?? []).map((segment) => segment.text).join(" ").trim();
          if (text && !dictationError && !dictationCancelled && suspendEpoch === stopEpoch) {
            set({ dictationState: "inserting" });
            await setDictationFeedback("inserting").catch(() => {});
            try {
              if (composerDictation) await composerDictation.onComplete(text);
              else {
                const result = await audioSystemDictationPaste(text);
                dictationError = result.error;
              }
            } catch (error) {
              dictationError = error instanceof Error ? error.message : String(error);
            }
          }
          // Dictation is ephemeral and must never appear in Recordings, even
          // when the paste fails — on failure the text is still on the
          // clipboard (copied), so nothing is silently lost. Always discard it.
          recordingsAfterDictation = await audioRecordingDelete(meta.id).catch(() => null);
          await (dictationCancelled || suspendEpoch !== stopEpoch
            ? cancelledDictationFeedback()
            : setDictationFeedback(dictationError ? "error" : text ? "success" : "idle", dictationError ?? "")
          ).catch(() => {});
        }
        if (isSystemDictation) dictationSettleAt = Date.now();
        if (!isSystemDictation) {
          const meetingError = transcriptionError ?? captureError;
          const meeting = await audioMeetingSetState(meetingError ? "error" : "idle", undefined, meetingError ?? undefined)
            .catch(() => get().meeting);
          set({ meeting });
        }
        set((state) => ({
          recording: null,
          recordingStartedAt: null,
          dictationRecordingId: null,
          composerDictation: null,
          composerDictationLevel: 0,
          dictationState: isSystemDictation && dictationError ? "error" : "idle",
          partials: [],
          levels: {},
          diarizing: false,
          finalizing: false,
          error: dictationError ?? transcriptionError ?? captureError,
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
        captureHandle = null;
        // A failed capture flush still closes the graph. Discard its
        // ephemeral session too, so the worker and power blocker are freed.
        if (isSystemDictation) await audioRecordingCancel(recording.id).catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = isSystemDictation && (dictationCancelled || suspendEpoch !== stopEpoch);
        set({
          recording: null,
          recordingStartedAt: null,
          dictationRecordingId: null,
          composerDictation: null,
          composerDictationLevel: 0,
          dictationState: isSystemDictation ? cancelled ? "idle" : "error" : get().dictationState,
          levels: {},
          diarizing: false,
          finalizing: false,
          error: cancelled ? null : message,
        });
        if (isSystemDictation && !composerDictation) {
          dictationSettleAt = Date.now();
          await (cancelled ? cancelledDictationFeedback() : setDictationFeedback("error", message)).catch(() => {});
        } else if (!isSystemDictation) {
          await audioMeetingSetState("error", recording.id, message).catch(() => {});
        }
      }
      await get().refreshRecordings();
    },

    cancelRecording: async () => {
      const recording = get().recording;
      const isSystemDictation = Boolean(recording && get().dictationRecordingId === recording.id);
      const isComposerDictation = Boolean(get().composerDictation);
      if (get().dictationState === "inserting") return;
      if (isSystemDictation || get().dictationState === "starting") {
        dictationCancelled = true;
        dictationStartController?.abort();
        if (get().finalizing || get().dictationState === "starting") {
          await setDictationFeedback(get().dictationState, t("recorder.dictation_cancelling")).catch(() => {});
          return;
        }
      }
      if (recording) set({ finalizing: true });
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
        composerDictation: null,
        composerDictationLevel: 0,
        dictationState: "idle",
        partials: [],
        segments: [],
        levels: {},
        diarizing: false,
        finalizing: false,
      });
      if (isSystemDictation && !isComposerDictation) {
        dictationSettleAt = Date.now();
        await cancelledDictationFeedback().catch(() => {});
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
        if (status.state === "error") throw new Error(status.error ?? t("recorder.transcriber_start_failed"));
        if (get().transcriber.state !== "ready") {
          const deadline = Date.now() + 60_000;
          while (Date.now() < deadline) {
            const state = get().transcriber.state;
            if (state === "ready") break;
            if (state === "error") throw new Error(get().transcriber.error ?? t("recorder.transcriber_load_failed"));
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

    setRecordingProject: async (recordingId, projectId, linked) => {
      const recordings = await audioRecordingSetProject(recordingId, projectId, linked);
      set((state) => {
        const updated = recordings.find((item) => item.id === recordingId);
        return {
          recordings,
          openedRecording: updated && state.openedRecording?.meta.id === recordingId ? { ...state.openedRecording, meta: updated } : state.openedRecording,
          recording: updated && state.recording?.id === recordingId ? updated : state.recording,
        };
      });
    },

    openRecording: async (recordingId) => {
      const detail = await audioRecordingGet(recordingId);
      set({ openedRecording: detail });
    },

    closeOpenedRecording: () => set({ openedRecording: null }),

    saveRecordingToWorkspace: async (recordingId, workspacePath) => {
      const result = await audioRecordingSaveToWorkspace(recordingId, workspacePath);
      if (!result.ok) {
        set({ error: result.error ?? t("recorder.save_failed") });
        return null;
      }
      return result.folderPath;
    },

    getInsertableTranscript: () => {
      const { segments, openedRecording } = get();
      const source = openedRecording ? openedRecording.segments : segments;
      return transcriptText(source, 100_000).trim();
    },

    startLiveTranscriptShare: async (sessionId, workspacePath, directory, sessionClient, automatic = false) => {
      const root = workspacePath?.trim();
      if (!root) {
        set({ error: t("recorder.context_inject_no_session") });
        return false;
      }
      const recordingId = get().recording?.id;
      if (!recordingId || get().recording?.ephemeral) return false;
      if (automatic && get().liveTranscriptDismissedPaths.includes(root)) return false;
      if (get().liveTranscriptWorkspacePath === root && get().liveTranscriptNotifiedSessions.includes(sessionId)) return true;
      const request = ++liveTranscriptShareRevision;
      let fileName = "live-call-transcript.md";
      try {
        const result = await audioLiveTranscriptStart(root);
        if (!result.ok) {
          set({ error: result.error ?? t("recorder.live_transcript_failed") });
          return false;
        }
        if (result.fileName) fileName = result.fileName;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
        return false;
      }

      if (request !== liveTranscriptShareRevision || get().recording?.id !== recordingId) return false;
      set({ liveTranscriptSessionId: sessionId, liveTranscriptWorkspacePath: root,
        liveTranscriptDismissedPaths: get().liveTranscriptDismissedPaths.filter(path => path !== root) });
      // Tell the agent — once, invisibly (synthetic + noReply) — that a growing
      // transcript file exists to read on demand. No repeated pasting.
      const client = sessionClient ?? copilotContext?.getClient();
      if (client && !get().liveTranscriptNotifiedSessions.includes(sessionId)) {
        set({ liveTranscriptNotifiedSessions: [...get().liveTranscriptNotifiedSessions, sessionId] });
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
      return get().recording?.id === recordingId && get().liveTranscriptWorkspacePath === root;
    },

    stopLiveTranscriptShare: async () => {
      liveTranscriptShareRevision += 1;
      const root = get().liveTranscriptWorkspacePath;
      if (root) set({ liveTranscriptDismissedPaths: [...get().liveTranscriptDismissedPaths, root] });
      await audioLiveTranscriptStop().catch(() => {});
      set({ liveTranscriptSessionId: null, liveTranscriptWorkspacePath: null });
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
