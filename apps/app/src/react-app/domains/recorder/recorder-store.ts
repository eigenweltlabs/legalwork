/**
 * Recorder runtime store (module-level, mirrors the Voice Mode pattern):
 * bootstraps the local model manager, drives capture + live transcription,
 * keeps the transcript, and answers call-overlay questions through the
 * workspace's OpenCode session AI.
 */

import { create } from "zustand";

import {
  audioModelDelete,
  audioModelDownload,
  audioModelDownloadCancel,
  audioOverlaySetVisible,
  audioRecorderBootstrap,
  audioRecordingCancel,
  audioRecordingDelete,
  audioRecordingGet,
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
  AudioCaptureSourceKind,
  AudioRecorderBootstrap,
  AudioRecorderEvent,
  AudioRecordingDetail,
  AudioRecordingMeta,
  AudioTranscribeLanguage,
  AudioTranscriberStatus,
  AudioTranscriptSegment,
} from "@legalwork/types/audio";
import { t } from "@/i18n";

import { startCapture, type CaptureHandle, type CaptureLevels } from "./capture";

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
  transcriber: AudioTranscriberStatus;
  recording: AudioRecordingMeta | null;
  recordingStartedAt: number | null;
  segments: AudioTranscriptSegment[];
  partial: AudioTranscriptSegment | null;
  recordings: AudioRecordingMeta[];
  openedRecording: AudioRecordingDetail | null;
  levels: CaptureLevels;
  overlayVisible: boolean;
  copilotEntries: CopilotEntry[];
  error: string | null;
  modelId: string;
  language: AudioTranscribeLanguage;
  sources: AudioCaptureSourceKind[];
  /** macOS App Audio selection (empty = all system audio via the tap). */
  appPids: number[];
  appNames: string[];
};

type RecorderActions = {
  init: () => Promise<void>;
  refreshBootstrap: () => Promise<void>;
  refreshRecordings: () => Promise<void>;
  setModelId: (modelId: string) => void;
  setLanguage: (language: AudioTranscribeLanguage) => void;
  prewarm: () => Promise<void>;
  toggleSource: (source: AudioCaptureSourceKind) => void;
  setAppSelection: (pids: number[], names: string[]) => void;
  downloadModel: (modelId: string) => Promise<void>;
  cancelModelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  startRecording: (title?: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
  deleteRecording: (recordingId: string) => Promise<void>;
  openRecording: (recordingId: string) => Promise<void>;
  closeOpenedRecording: () => void;
  saveRecordingToWorkspace: (recordingId: string, workspacePath: string) => Promise<string | null>;
  getInsertableTranscript: () => string;
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
    .filter((item): item is AudioCaptureSourceKind => item === "microphone" || item === "system" || item === "app");
  return parsed.length ? parsed : ["microphone"];
}

function readLanguagePref(): AudioTranscribeLanguage {
  const raw = readPref(LANGUAGE_PREF_KEY, "auto");
  return raw === "en" || raw === "de" ? raw : "auto";
}

let captureHandle: CaptureHandle | null = null;
let levelTimer: number | null = null;
let eventsSubscribed = false;

function transcriptText(segments: AudioTranscriptSegment[], limit = 12_000): string {
  const text = segments.map((segment) => segment.text).join("\n");
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
      case "model-download-error": {
        void get().refreshBootstrap();
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
    transcriber: { state: "idle", modelId: null, error: null },
    recording: null,
    recordingStartedAt: null,
    segments: [],
    partial: null,
    recordings: [],
    openedRecording: null,
    levels: {},
    overlayVisible: false,
    copilotEntries: [],
    error: null,
    modelId: readPref(MODEL_PREF_KEY, "whisper-base"),
    language: readLanguagePref(),
    sources: readSourcesPref(),
    appPids: [],
    appNames: [],

    init: async () => {
      if (!eventsSubscribed) {
        eventsSubscribed = true;
        window.__LEGALWORK_ELECTRON__?.audio?.onEvent?.(handleEvent);
      }
      if (get().initialized) return;
      set({ initialized: true });
      await Promise.all([get().refreshBootstrap(), get().refreshRecordings()]);
      void get().prewarm();
    },

    refreshBootstrap: async () => {
      try {
        const bootstrap = await audioRecorderBootstrap();
        set({ bootstrap });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    },

    refreshRecordings: async () => {
      try {
        set({ recordings: await audioRecordingsList() });
      } catch {
        // desktop bridge unavailable (plain web) — recorder UI shows a hint
      }
    },

    setModelId: (modelId) => {
      writePref(MODEL_PREF_KEY, modelId);
      set({ modelId });
      void get().prewarm();
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

    setAppSelection: (pids, names) => {
      set((state) => ({
        appPids: pids,
        appNames: names,
        sources: state.sources.includes("app") ? state.sources : [...state.sources, "app"],
      }));
    },

    downloadModel: async (modelId) => {
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

    startRecording: async (title) => {
      const { modelId, language, recording, bootstrap } = get();
      if (recording) return;
      // A persisted "system" pref may predate running on a platform that
      // can't capture it (e.g. macOS 12) — drop unsupported sources.
      let sources = get().sources;
      if (bootstrap && !bootstrap.capabilities.systemAudio) {
        sources = sources.filter((source) => source !== "system");
      }
      if (bootstrap && !bootstrap.capabilities.appAudio) {
        sources = sources.filter((source) => source !== "app");
      }
      if (!sources.length) sources = ["microphone"];
      set({ error: null, segments: [], partial: null, copilotEntries: [] });
      let startedMetaId: string | null = null;
      try {
        const status = await audioTranscriberStart({ modelId, language });
        if (status.state === "error") throw new Error(status.error ?? "Transcriber failed to start.");

        const meta = await audioRecordingStart({ title, language, modelId, sources });
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
          { appPids: get().appPids },
        );
        set({ recording: meta, recordingStartedAt: Date.now() });
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
        set({
          recording: null,
          recordingStartedAt: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    stopRecording: async () => {
      const recording = get().recording;
      if (!recording) return;
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      try {
        if (captureHandle) {
          await captureHandle.stop();
          captureHandle = null;
        }
        const meta = await audioRecordingStop(recording.id);
        set((state) => ({
          recording: null,
          recordingStartedAt: null,
          partial: null,
          levels: {},
          recordings: [meta, ...state.recordings.filter((item) => item.id !== meta.id)],
        }));
      } catch (error) {
        set({
          recording: null,
          recordingStartedAt: null,
          levels: {},
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await get().refreshRecordings();
    },

    cancelRecording: async () => {
      const recording = get().recording;
      if (levelTimer !== null) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      if (captureHandle) {
        await captureHandle.stop().catch(() => {});
        captureHandle = null;
      }
      if (recording) await audioRecordingCancel(recording.id).catch(() => {});
      set({ recording: null, recordingStartedAt: null, partial: null, segments: [], levels: {} });
    },

    deleteRecording: async (recordingId) => {
      const recordings = await audioRecordingDelete(recordingId);
      set((state) => ({
        recordings,
        openedRecording:
          state.openedRecording?.meta.id === recordingId ? null : state.openedRecording,
      }));
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
