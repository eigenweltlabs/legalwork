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

/** Commercial tier: "free" installs for anyone, "premium" is entitlement-gated. */
export type AudioModelPlan = "free" | "premium";

export type AudioModelCatalogEntry = {
  id: string;
  label: string;
  /** Short human description ("Fastest, lowest accuracy", …). */
  description: string;
  kind: AudioModelKind;
  tier: AudioModelTier;
  /** Free to install, or gated behind a premium entitlement. */
  plan: AudioModelPlan;
  /** Languages the model can transcribe. */
  languages: "multilingual" | "english";
  /** Display-only estimate; real progress uses Content-Length. */
  approxSizeBytes: number;
  files: AudioModelFile[];
  recommended?: boolean;
  /**
   * Large/slow models that only make sense on a capable machine. Gated behind
   * {@link AudioDeviceProfile.fastDevice} in the picker: on weaker hardware the
   * model is offered but flagged so the user can confirm before installing.
   */
  requiresFastDevice?: boolean;
};

/**
 * Rough device capability so the UI can hint "recommended for your device".
 * Measured once in the main process (os.cpus / os.totalmem / process.arch).
 */
export type AudioDeviceProfile = {
  totalMemoryGb: number;
  logicalCores: number;
  appleSilicon: boolean;
  /**
   * True when the machine is powerful enough to comfortably run the heaviest
   * models (see {@link AudioModelCatalogEntry.requiresFastDevice}). Apple
   * Silicon, or a roomy multi-core machine.
   */
  fastDevice: boolean;
  /** The model id the app suggests for this machine (a free tier). */
  recommendedModelId: string;
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

/** Mirrors Electron's systemPreferences.getMediaAccessStatus values. */
export type AudioPermissionState = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

/**
 * OS-level capture permissions the recorder needs. `systemAudio` maps to the
 * macOS "Screen & System Audio Recording" privacy pane, which gates both the
 * getDisplayMedia loopback and the per-app Core Audio tap.
 */
export type AudioCapturePermissions = {
  platform: string;
  /** False in dev, where macOS attributes permissions to the launching app (terminal/IDE). */
  packaged: boolean;
  microphone: AudioPermissionState;
  systemAudio: AudioPermissionState;
};

export type AudioPermissionKind = "microphone" | "systemAudio";

export type AudioEngineStatus = {
  /** sherpa-onnx native addon is present for this platform. */
  available: boolean;
  error: string | null;
};

export type AudioRecorderBootstrap = {
  models: AudioModelState[];
  capabilities: AudioCaptureCapabilities;
  engine: AudioEngineStatus;
  diarization: AudioDiarizationState;
  device: AudioDeviceProfile;
  modelsDir: string;
  recordingsDir: string;
};

export type AudioCaptureSourceKind = "microphone" | "system" | "app";

/** A catalog-compatible model found on disk (HF cache, downloads folder). */
export type AudioModelDiskCandidate = {
  modelId: string;
  sourcePath: string;
  sizeBytes: number;
};

export type AudioModelImportResult = {
  ok: boolean;
  modelId: string | null;
  error: string | null;
};

/** A running application offered by the macOS App Audio picker. */
export type AudioTapApp = {
  pid: number;
  name: string;
  bundleId: string;
  /** Data URL of the app icon (resolved via Electron), may be empty. */
  icon: string;
};

/** Transcription language. `auto` lets the model detect (Whisper + Parakeet v3). */
export type AudioTranscribeLanguage = "auto" | "en" | "de";

export type AudioTranscriptSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** True once the segment is finalized by VAD; partials get replaced. */
  final: boolean;
  /**
   * Zero-based speaker id from on-device diarization, or null when speakers
   * were not identified (diarization off, or the segment fell in a gap). The
   * UI renders these as "Speaker 1", "Speaker 2", … by first appearance.
   */
  speaker?: number | null;
};

/**
 * Local speaker-diarization models (pyannote segmentation + a speaker
 * embedding extractor). Downloaded on demand, shared across recordings.
 */
export type AudioDiarizationState = {
  installed: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
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
  /** Temporary capture used by system dictation; never shown in Recorder history. */
  ephemeral?: boolean;
  /** Number of distinct speakers identified, or null when not diarized. */
  speakerCount?: number | null;
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

export type AudioSystemDictationPlatform = "darwin" | "windows" | "linux";
export type AudioSystemDictationMode = "tap" | "hold";

export type AudioSystemDictationStatus = {
  enabled: boolean;
  registered: boolean;
  accelerator: string;
  defaultAccelerator: string;
  customAccelerator: boolean;
  mode: AudioSystemDictationMode;
  supportsHold: boolean;
  shortcutCaptureActive: boolean;
  platform: AudioSystemDictationPlatform;
  accessibility: "granted" | "needed" | "not-required";
  error: string | null;
};

export type AudioSystemDictationRuntimeState =
  | "idle"
  | "listening"
  | "transcribing"
  | "error";

export type AudioSystemDictationPasteResult = {
  pasted: boolean;
  copied: boolean;
  error: string | null;
};

export type AudioRecordingStartInput = {
  title?: string;
  language: AudioTranscribeLanguage;
  modelId: string;
  sources: AudioCaptureSourceKind[];
  ephemeral?: boolean;
  /** Run on-device speaker diarization at finalize (retained recordings only). */
  diarize?: boolean;
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
  | { type: "diarization-download-progress"; downloadedBytes: number; totalBytes: number }
  | { type: "diarization-download-done" }
  | { type: "diarization-download-error"; error: string }
  /** A stopping recording is running its on-device speaker pass (can take a while). */
  | { type: "recording-diarizing"; recordingId: string }
  | { type: "transcriber-status"; status: AudioTranscriberStatus }
  | { type: "transcript-partial"; streamId: string; segment: AudioTranscriptSegment }
  | { type: "transcript-segment"; streamId: string; segment: AudioTranscriptSegment }
  /** A speech run ended with an empty decode — drop any partial up to endMs. */
  | { type: "transcript-partial-clear"; streamId: string; endMs: number }
  /** A new recording began — live-caption consumers reset their state. */
  | { type: "recording-started"; recordingId: string }
  | { type: "transcribe-file-done"; streamId: string }
  | { type: "recording-error"; recordingId: string; error: string }
  | { type: "system-dictation-toggle" }
  | { type: "system-dictation-press" }
  | { type: "system-dictation-release" }
  | { type: "system-dictation-cancel" }
  | { type: "system-dictation-status"; status: AudioSystemDictationStatus }
  /**
   * The machine is about to sleep — finalize the active call recording and
   * cancel any dictation (pasting into whatever is focused after wake would
   * be wrong). Capture devices will need reacquiring after resume anyway.
   */
  | { type: "power-suspend" }
  /** The live-transcript workspace mirror stopped (recording ended). */
  | { type: "live-transcript-stopped" }
  | { type: "overlay-visibility"; visible: boolean }
  /** Overlay → main window: the lawyer typed a question for the AI copilot. */
  | { type: "overlay-ask"; askId: string; question: string }
  /** Overlay → main window: request AI-suggested follow-up questions. */
  | { type: "overlay-suggest"; askId: string }
  /** Main window → overlay: streaming answer text for an ask. */
  | { type: "ask-answer"; askId: string; text: string; done: boolean; error: string | null };
