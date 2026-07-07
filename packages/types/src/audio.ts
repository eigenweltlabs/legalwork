/**
 * Shared contracts for the local audio recording + transcription feature
 * (Recorder tab, live captions overlay, model manager).
 *
 * Producer: apps/desktop/electron/audio/* (model manager, recorder service,
 * transcription worker). Consumer: apps/app recorder domain + call overlay.
 *
 * Everything here is local-first: models are ONNX files downloaded to the
 * user's machine and inference runs in an Electron utility process via
 * sherpa-onnx. No audio ever leaves the device for transcription.
 */

/** Engine family a model runs on (all via sherpa-onnx). */
export type AudioModelKind = "whisper" | "nemo-transducer";

/** Rough quality/resource tier shown in the model picker. */
export type AudioModelTier = "fastest" | "balanced" | "accurate" | "best";

export type AudioModelFile = {
  /** Local file name inside the model directory. */
  name: string;
  /** Direct HTTPS download URL (Hugging Face `resolve/main` link). */
  url: string;
};

export type AudioModelCatalogEntry = {
  id: string;
  label: string;
  /** Short human description ("Fastest, lowest accuracy", …). */
  description: string;
  kind: AudioModelKind;
  tier: AudioModelTier;
  /** Languages the model can transcribe. */
  languages: "multilingual" | "english";
  /** Display-only estimate; real progress uses Content-Length. */
  approxSizeBytes: number;
  files: AudioModelFile[];
  recommended?: boolean;
};

export type AudioModelInstallState = "not-installed" | "downloading" | "installed" | "error";

export type AudioModelState = AudioModelCatalogEntry & {
  state: AudioModelInstallState;
  downloadedBytes: number;
  totalBytes: number;
  installedSizeBytes: number | null;
  error: string | null;
};

/** What the current platform can capture. */
export type AudioCaptureCapabilities = {
  microphone: boolean;
  /** WASAPI loopback (Windows), ScreenCaptureKit/CoreAudio tap (macOS 13+), PipeWire (Linux). */
  systemAudio: boolean;
  /** Per-application capture — currently macOS only, via the native audio tap helper. */
  appAudio: boolean;
};

export type AudioEngineStatus = {
  /** sherpa-onnx native addon is present for this platform. */
  available: boolean;
  error: string | null;
};

export type AudioRecorderBootstrap = {
  models: AudioModelState[];
  capabilities: AudioCaptureCapabilities;
  engine: AudioEngineStatus;
  modelsDir: string;
  recordingsDir: string;
};

export type AudioCaptureSourceKind = "microphone" | "system" | "app";

/** Transcription language. `auto` lets the model detect (Whisper + Parakeet v3). */
export type AudioTranscribeLanguage = "auto" | "en" | "de";

export type AudioTranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** True once the segment is finalized by VAD; partials get replaced. */
  final: boolean;
};

export type AudioRecordingStatus = "recording" | "complete" | "error";

export type AudioRecordingMeta = {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  language: AudioTranscribeLanguage;
  modelId: string | null;
  sources: AudioCaptureSourceKind[];
  /** Folder containing audio + transcript files. */
  folderPath: string;
  /** Absolute path of the audio file (webm/opus), null until first chunk. */
  audioPath: string | null;
  /** Absolute path of transcript.json once finalized. */
  transcriptPath: string | null;
  sizeBytes: number;
  segmentCount: number;
  status: AudioRecordingStatus;
  error: string | null;
};

export type AudioRecordingDetail = {
  meta: AudioRecordingMeta;
  segments: AudioTranscriptSegment[];
};

export type AudioTranscriberState = "idle" | "loading" | "ready" | "error";

export type AudioTranscriberStatus = {
  state: AudioTranscriberState;
  modelId: string | null;
  error: string | null;
};

export type AudioRecordingStartInput = {
  title?: string;
  language: AudioTranscribeLanguage;
  modelId: string;
  sources: AudioCaptureSourceKind[];
};

export type AudioSaveToWorkspaceResult = {
  ok: boolean;
  folderPath: string | null;
  error: string | null;
};

/**
 * Events broadcast from the main process on `legalwork:audio:event` to the
 * main window and the call overlay window.
 */
export type AudioRecorderEvent =
  | { type: "model-download-progress"; modelId: string; downloadedBytes: number; totalBytes: number }
  | { type: "model-download-done"; modelId: string }
  | { type: "model-download-error"; modelId: string; error: string }
  | { type: "transcriber-status"; status: AudioTranscriberStatus }
  | { type: "transcript-partial"; streamId: string; segment: AudioTranscriptSegment }
  | { type: "transcript-segment"; streamId: string; segment: AudioTranscriptSegment }
  /** A speech run ended with an empty decode — drop any partial up to endMs. */
  | { type: "transcript-partial-clear"; streamId: string; endMs: number }
  /** A new recording began — live-caption consumers reset their state. */
  | { type: "recording-started"; recordingId: string }
  | { type: "transcribe-file-done"; streamId: string }
  | { type: "recording-error"; recordingId: string; error: string }
  | { type: "overlay-visibility"; visible: boolean }
  /** Overlay → main window: the lawyer typed a question for the AI copilot. */
  | { type: "overlay-ask"; askId: string; question: string }
  /** Overlay → main window: request AI-suggested follow-up questions. */
  | { type: "overlay-suggest"; askId: string }
  /** Main window → overlay: streaming answer text for an ask. */
  | { type: "ask-answer"; askId: string; text: string; done: boolean; error: string | null };
