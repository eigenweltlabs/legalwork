/**
 * Recorder service — the main-process hub for local recording + transcription.
 *
 * Owns:
 *  - the transcription utilityProcess (spawn, load model, restart on crash),
 *  - recording folders under `<userData>/recordings/<id>/` (audio.webm +
 *    transcript.json/srt/txt/md + meta.json) so any OpenCode session can be
 *    pointed at plain files on disk,
 *  - fan-out of AudioRecorderEvent to subscribed windows (main + overlay).
 *
 * The renderer streams two things at it during a recording: compressed
 * MediaRecorder chunks (appended to audio.webm) and 16 kHz mono Float32 PCM
 * (forwarded to the worker for VAD + decoding).
 */

import { VoiceVerifierClient } from "./voice-verifier.mjs";
import fs from "node:fs";
import { finished } from "node:stream/promises";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { AudioModelManager } from "./model-manager.mjs";
import { findAudioModel } from "./model-catalog.mjs";
import { macOsAtLeast } from "./mac-version.mjs";
import { editTranscriptSpeakers, resolveSummarySpeakerNames } from "./transcript-edit.mjs";
import { CloudTranscriber, isCloudTranscriptionModel } from "./cloud-transcriber.mjs";
import { RecorderRequestError } from "./recorder-server-request.mjs";
import { mergeSpeakerTurns } from "./cloud-speakers.mjs";
import { mergeSpeakerWords, splitCloudTranscript } from "./cloud-transcript.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUDIO_EVENT_CHANNEL = "legalwork:audio:event";

function nowId() {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeTitle(title) {
  const cleaned = String(title ?? "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-");
  return cleaned.slice(0, 120) || "Recording";
}

/** A safe on-disk file name (keeps the extension) for an imported audio file. */
function sanitizeFileName(name) {
  const base = String(name ?? "").trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^\.+/, "");
  return base.slice(0, 180) || "audio";
}

function stripExtension(name) {
  return String(name ?? "").replace(/\.[a-z0-9]{1,8}$/i, "").trim();
}

const WORKSPACE_TRANSCRIPT_END = "\n> Recording ended. Changes made in the recording tab are reflected here automatically.\n";
const WORKSPACE_TRANSCRIPT_NOTE = "> Audio saved on this device. New segments are appended during recording. Edit speakers in the recording tab; this file updates automatically.";

function workspaceTranscriptOwnerPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.json`);
}

function workspaceTranscriptHeader(meta) {
  return `# ${meta.title}\n\n${WORKSPACE_TRANSCRIPT_NOTE}\n\n${meta.summary ? `## Summary\n\n${meta.summary}\n\n` : ""}## Transcript\n\n`;
}

function workspaceTranscriptBody(meta, segments) {
  return segments.map(segment => {
    const label = speakerLabel(segment.speaker, meta.speakerNames);
    return `**[${formatClockTime(segment.startMs)}]** ${label ? `${label}: ` : ""}${segment.text}\n\n`;
  }).join("");
}

export class RecorderService {
  /**
   * Structural worker handle — what RecorderService actually uses of
   * Electron's UtilityProcess, so tests can substitute a fake.
   * @typedef {{
   *   postMessage: (message: object) => void,
   *   on: (event: string, listener: (payload: any) => void) => unknown,
   *   kill: () => unknown,
   * }} TranscriberWorkerHandle
   */
  /**
   * @param {{
   *   userDataDir: string,
   *   resolveWorkerPath?: () => string,
   *   forkWorker?: (workerPath: string) => TranscriberWorkerHandle,
   *   appAudioAvailable?: () => boolean,
   *   powerSessions?: { acquire: (key: string) => void, release: (key: string) => void },
   *   pinProcessQoS?: (pids: number[]) => void,
   *   resolveCloudConnection?: (modelId: string) => Promise<{ url: string, apiKey: string }>,
   *   generateMeetingNotes?: (input: { model: string, transcript: string, settings: import("@legalwork/types/audio").AudioMeetingNotesSettings, speakers: { id: number, label: string }[] }, signal: AbortSignal) => Promise<{ title?: string, summary?: string, speakerNames?: Record<string, string> }>,
   * }} options
   */
  constructor(options) {
    this.userDataDir = options.userDataDir;
    this.resolveCloudConnection = options.resolveCloudConnection;
    this.generateMeetingNotes = options.generateMeetingNotes;
    this.modelsDir = path.join(options.userDataDir, "stt-models");
    this.recordingsDir = path.join(options.userDataDir, "recordings");
    this.appAudioAvailable = options.appAudioAvailable ?? (() => false);
    // Keeps the OS from idle-sleeping (and Modern Standby from freezing the
    // process) while a recording or import is in flight; no-op in tests.
    this.powerSessions = options.powerSessions ?? { acquire: () => {}, release: () => {} };
    // Pins the transcription utilityProcess to Windows HighQoS so a hidden
    // window can't get it EcoQoS-throttled (slow decode = slow paste); no-op
    // off Windows and in tests.
    this.pinProcessQoS = options.pinProcessQoS ?? (() => {});
    this.resolveWorkerPath =
      options.resolveWorkerPath ?? (() => path.join(__dirname, "transcription-worker.cjs"));
    // Injectable so unit tests run without electron.
    this.forkWorker =
      options.forkWorker ??
      ((workerPath) => {
        const nodeRequire = createRequire(import.meta.url);
        const { utilityProcess } = nodeRequire("electron");
        // Pipe (not ignore) so a worker crash leaves its uncaught exception
        // in the main-process log instead of dying silently with "exited
        // unexpectedly (code 1)" and no trace.
        const worker = utilityProcess.fork(workerPath, [], {
          serviceName: "legalwork-transcriber",
          stdio: ["ignore", "pipe", "pipe"],
        });
        for (const stream of [worker.stdout, worker.stderr]) {
          stream?.setEncoding("utf8");
          stream?.on("data", (text) => {
            for (const line of String(text).split("\n")) {
              if (line.trim()) console.warn(`[transcriber] ${line}`);
            }
          });
        }
        return worker;
      });

    this.modelManager = new AudioModelManager({
      modelsDir: this.modelsDir,
      emitEvent: (event) => this.broadcast(event),
    });

    /** @type {Set<import('electron').WebContents>} */
    this.subscribers = new Set();

    /** @type {TranscriberWorkerHandle | null} */
    this.worker = null;
    this.workerReady = false;
    /**
     * PCM that arrived while the model was still loading — flushed on ready
     * so the opening seconds of a call are not lost. Capped per stream.
     * @type {Map<string, ArrayBuffer[]>}
     */
    this.pendingPcm = new Map();
    /** @type {Map<string, { recordingId: string, source: import("@legalwork/types/audio").AudioCaptureSourceKind, speaker: number }>} */
    this.recordingInputs = new Map();
    /** @type {{ modelId: string, language: string } | null} */
    this.loadedModel = null;
    /** @type {import("@legalwork/types/audio").AudioTranscriberStatus} */
    this.transcriberStatus = { state: "idle", modelId: null, error: null };

    /**
     * @type {Map<string, {
     *   meta: import("@legalwork/types/audio").AudioRecordingMeta,
     *   segments: import("@legalwork/types/audio").AudioTranscriptSegment[],
     *   sizeBytes: number,
     *   startedAt: number,
     *   audioStream: import('node:fs').WriteStream | null,
     *   sourceStreams?: Map<import("@legalwork/types/audio").AudioCaptureSourceKind, import('node:fs').WriteStream>,
     *   finalizingStreams?: Set<string>,
     *   transcriptStream?: import('node:fs').WriteStream,
     *   resolveFinalized: (() => void) | null,
     *   cancelled?: boolean,
     *   finishing?: Promise<import("@legalwork/types/audio").AudioRecordingMeta>,
     *   importAudioPath?: string,
     *   diarize?: boolean,
     *   cloudSpeakers?: Map<string, { ids: Map<number, number>, turns: { startMs: number, endMs: number, speaker: number | null }[], words: { text?: string, startMs: number, endMs: number, speaker: number | null }[], endMs: number }>,
     *   cloudDiarize?: boolean,
     *   meetingNotes?: import("@legalwork/types/audio").AudioMeetingNotesSettings,
     *   speakerPasses?: import("./deferred-cloud-speakers.mjs").DeferredCloudSpeakerPass[],
     *   cloudSegments?: Map<string, { streamId: string, original: import("@legalwork/types/audio").AudioTranscriptSegment, parts: import("@legalwork/types/audio").AudioTranscriptSegment[] }>,
     *   cloudPartials?: Map<string, import("@legalwork/types/audio").AudioTranscriptSegment>,
     *   reconnectingInputs?: Set<string>,
     *   speakerTurns?: { startMs: number, endMs: number, speaker: number }[] | null,
     * }>}
     */
    this.activeRecordings = new Map();
    /** @type {typeof this.activeRecordings} */
    this.backgroundRecordings = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.speakerJobs = new Map();
    /** @type {Map<string, { controller: AbortController, promise: Promise<void> }>} */
    this.summaryJobs = new Map();

    /**
     * Live-transcript mirror: while set, the growing transcript of the active
     * recording is continuously written to a markdown file in a workspace so
     * the agent can read the latest conversation on demand (composer "Live
     * call" toggle). Cleared when toggled off or the recording ends.
     * @type {{ workspacePath: string, filePath: string, fileName: string,
     * live: { meta: import("@legalwork/types/audio").AudioRecordingMeta, segments: import("@legalwork/types/audio").AudioTranscriptSegment[] },
     * written: number, revision: number, writtenRevision: number, initialized: boolean, queued: boolean, ended: boolean, endWritten: boolean } | null}
     */
    this.liveTranscript = null;
    this.liveTranscriptWriteQueue = Promise.resolve();
  }

  // ── live transcript mirror ──────────────────────────────────────────────

  /** File the live transcript is mirrored to, relative to the workspace root. */
  static LIVE_TRANSCRIPT_FILE = "live-call-transcript.md";

  startLiveTranscript(workspacePath) {
    const root = String(workspacePath ?? "").trim();
    if (!root || !fs.existsSync(root)) {
      return { ok: false, filePath: null, fileName: null, error: "Workspace folder not found." };
    }
    const fileName = RecorderService.LIVE_TRANSCRIPT_FILE;
    const filePath = path.join(root, fileName);
    const live = this.currentLiveSegments();
    if (!live) return { ok: false, filePath: null, fileName: null, error: "No recording is active." };
    if (this.liveTranscript?.filePath !== filePath || this.liveTranscript.live.meta.id !== live.meta.id) {
      this.liveTranscript = { workspacePath: root, filePath, fileName, live,
        written: 0, revision: 0, writtenRevision: 0, initialized: false, queued: false, ended: false, endWritten: false };
    }
    void this.writeLiveTranscript();
    return { ok: true, filePath, fileName, error: null };
  }

  liveTranscriptStatus(workspacePath) {
    const root = String(workspacePath ?? "").trim();
    const recordingActive = Array.from(this.activeRecordings.values()).some(
      (recording) => recording.meta.ephemeral !== true,
    );
    const liveTranscriptActive = Boolean(
      root && this.liveTranscript && path.resolve(this.liveTranscript.workspacePath) === path.resolve(root),
    );
    return {
      available: true,
      recordingActive,
      liveTranscriptActive,
      fileName: liveTranscriptActive ? this.liveTranscript.fileName : null,
      error: null,
    };
  }

  setLiveTranscript(enabled, workspacePath) {
    const status = this.liveTranscriptStatus(workspacePath);
    if (enabled) {
      if (!status.recordingActive) {
        return { ...status, error: "No recording is active." };
      }
      const result = this.startLiveTranscript(workspacePath);
      return { ...this.liveTranscriptStatus(workspacePath), error: result.error };
    }
    if (status.liveTranscriptActive) this.stopLiveTranscript();
    return this.liveTranscriptStatus(workspacePath);
  }

  stopLiveTranscript() {
    this.liveTranscript = null;
    return { ok: true };
  }

  /** The transcript of whichever recording is currently active (usually one). */
  currentLiveSegments() {
    for (const recording of this.activeRecordings.values()) {
      if (recording.meta.ephemeral === true) continue;
      return { meta: recording.meta, segments: recording.segments };
    }
    return null;
  }

  writeLiveTranscript(ended = false) {
    const target = this.liveTranscript;
    if (!target) return this.liveTranscriptWriteQueue;
    target.ended ||= ended;
    if (target.queued) return this.liveTranscriptWriteQueue;
    target.queued = true;
    // One coalesced append job, regardless of how many segments arrive while
    // disk I/O is pending. Never queue copies of the entire meeting transcript.
    this.liveTranscriptWriteQueue = this.liveTranscriptWriteQueue.then(async () => {
      if (this.liveTranscript !== target) return;
      do {
        const revision = target.revision;
        if (!target.initialized || target.writtenRevision !== revision) {
          await fsp.writeFile(workspaceTranscriptOwnerPath(target.filePath), JSON.stringify({ recordingId: target.live.meta.id }));
          await fsp.writeFile(target.filePath, workspaceTranscriptHeader(target.live.meta));
          target.initialized = true;
          target.written = 0;
          target.endWritten = false;
          target.writtenRevision = revision;
        }
        while (this.liveTranscript === target && target.written < target.live.segments.length) {
          const batch = target.live.segments.slice(target.written, target.written + 100);
          const body = workspaceTranscriptBody(target.live.meta, batch);
          await fsp.appendFile(target.filePath, body);
          target.written += batch.length;
        }
        if (this.liveTranscript === target && target.ended && !target.endWritten) {
          await fsp.appendFile(target.filePath, WORKSPACE_TRANSCRIPT_END);
          target.endWritten = true;
        }
      } while (this.liveTranscript === target && target.writtenRevision !== target.revision);
    }).catch(error => {
      this.broadcast({ type: "recording-error", recordingId: target.live.meta.id,
        error: `Could not save the live transcript: ${error.message}` });
    }).finally(() => { target.queued = false; });
    return this.liveTranscriptWriteQueue;
  }

  /** Update managed copies after corrections, including after an app restart. */
  syncWorkspaceTranscripts(meta, segments) {
    const operation = this.liveTranscriptWriteQueue.then(async () => {
      for (const filePath of meta.workspaceTranscriptPaths ?? []) {
        if (path.basename(filePath) !== RecorderService.LIVE_TRANSCRIPT_FILE) continue;
        const owner = await fsp.readFile(workspaceTranscriptOwnerPath(filePath), "utf8")
          .then(JSON.parse).catch(error => {
            if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
            throw error;
          });
        if (owner?.recordingId !== meta.id) continue;
        const current = await fsp.readFile(filePath, "utf8").catch(error => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        // The path is reused by later calls. Never replace another recording,
        // or a file the user has replaced with an unrelated document.
        const previousNote = WORKSPACE_TRANSCRIPT_NOTE.replace("Audio saved on this device.", "Recorded locally, on-device.");
        if (!current.startsWith("# ") || ![WORKSPACE_TRANSCRIPT_NOTE, previousNote].some(note => current.includes(`\n\n${note}\n\n`))) continue;
        const body = workspaceTranscriptHeader(meta) + workspaceTranscriptBody(meta, segments) + WORKSPACE_TRANSCRIPT_END;
        const temporary = `${filePath}.${meta.id}.tmp`;
        try {
          await fsp.writeFile(temporary, body);
          await fsp.rename(temporary, filePath);
        } finally {
          await fsp.rm(temporary, { force: true });
        }
      }
    });
    // Serialize with live writes so editing an older call cannot race a new
    // recording taking ownership of the same workspace file.
    this.liveTranscriptWriteQueue = operation.catch(() => {});
    return operation;
  }

  createTranscriptJournal(meta) {
    const stream = fs.createWriteStream(path.join(meta.folderPath, "transcript.jsonl"));
    stream.on("error", error => {
      meta.status = "error";
      meta.error = `Could not save transcript segments: ${error.message}`;
      this.broadcast({ type: "recording-error", recordingId: meta.id, error: meta.error });
    });
    return stream;
  }

  // ── window fan-out ──────────────────────────────────────────────────────

  subscribe(webContents) {
    this.subscribers.add(webContents);
    webContents.once("destroyed", () => this.subscribers.delete(webContents));
  }

  broadcast(event) {
    for (const target of this.subscribers) {
      if (!target.isDestroyed()) target.send(AUDIO_EVENT_CHANNEL, event);
    }
  }

  // ── bootstrap / models ──────────────────────────────────────────────────

  engineStatus() {
    try {
      const nodeRequire = createRequire(import.meta.url);
      nodeRequire.resolve("sherpa-onnx-node/package.json");
      return { available: true, error: null };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  capabilities() {
    // WASAPI loopback ships in Chromium on Windows; macOS needs
    // ScreenCaptureKit (13+) behind the feature flags enabled at startup;
    // Linux goes through PipeWire/Pulse (assumed present on desktop distros).
    const systemAudio = process.platform === "darwin" ? macOsAtLeast(13) : true;
    return {
      microphone: true,
      systemAudio,
      appAudio: this.appAudioAvailable(),
    };
  }

  /**
   * Rough device tier for the "recommended for your device" hint. We recommend
   * a FREE tier so a first-run user isn't nudged toward the gated Premium model
   * they can't use yet: Basic (Whisper small) on a capable machine, Super small
   * (Whisper tiny) on a weak/old one. Never the Premium or Maximum models.
   *
   * `fastDevice` is a stricter bar than `strong`: the Maximum (Whisper
   * large-v3) model is ~1.7 GB and slow on CPU, so it only makes sense on
   * Apple Silicon or a roomy, many-core machine.
   * @returns {import("@legalwork/types/audio").AudioDeviceProfile}
   */
  deviceProfile() {
    const totalMemoryGb = os.totalmem() / 1024 ** 3;
    const logicalCores = os.cpus().length || 1;
    const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
    const strong = appleSilicon || (totalMemoryGb >= 8 && logicalCores >= 4);
    const fastDevice = appleSilicon || (totalMemoryGb >= 16 && logicalCores >= 8);
    return {
      totalMemoryGb: Math.round(totalMemoryGb * 10) / 10,
      logicalCores,
      appleSilicon,
      fastDevice,
      recommendedModelId: strong ? "whisper-small" : "whisper-tiny",
    };
  }

  bootstrap() {
    return {
      models: this.modelManager.listModelStates(),
      capabilities: this.capabilities(),
      engine: this.engineStatus(),
      diarization: this.modelManager.diarizationState(),
      device: this.deviceProfile(),
      modelsDir: this.modelsDir,
      recordingsDir: this.recordingsDir,
    };
  }

  async downloadModel(modelId) {
    void this.modelManager.download(modelId).catch(() => {});
    return this.modelManager.listModelStates();
  }

  cancelModelDownload(modelId) {
    this.modelManager.cancelDownload(modelId);
    return this.modelManager.listModelStates();
  }

  async deleteModel(modelId) {
    if (this.loadedModel?.modelId === modelId) this.stopTranscriber();
    await this.modelManager.delete(modelId);
    return this.modelManager.listModelStates();
  }

  diarizationState() {
    return this.modelManager.diarizationState();
  }

  async downloadDiarization() {
    return this.modelManager.downloadDiarization();
  }

  // ── transcriber lifecycle ───────────────────────────────────────────────

  setTranscriberStatus(status) {
    this.transcriberStatus = status;
    this.broadcast({ type: "transcriber-status", status });
  }

  async startTranscriber({ modelId, language }) {
    if (isCloudTranscriptionModel(modelId)) {
      if (this.loadedModel?.modelId === modelId && this.loadedModel?.language === language && this.workerReady) return this.transcriberStatus;
      this.stopWorker();
      if (!this.resolveCloudConnection) {
        this.setTranscriberStatus({ state: "error", modelId, error: "Cloud transcription is unavailable." });
        return this.transcriberStatus;
      }
      this.loadedModel = { modelId, language };
      let speakerModelsReady;
      this.worker = new CloudTranscriber({ modelId, language, resolveConnection: this.resolveCloudConnection,
        createVoiceVerifier: async () => {
          // Both inputs start their deferred pass together. Share the download
          // promise so neither input observes a partially installed model.
          speakerModelsReady ??= this.modelManager.downloadDiarization().catch(error => {
            speakerModelsReady = null;
            throw error;
          });
          await speakerModelsReady;
          if (!this.modelManager.isDiarizationInstalled()) {
            speakerModelsReady = null;
            throw new Error("Speaker models are unavailable.");
          }
          return new VoiceVerifierClient(this.forkWorker(path.join(__dirname, "voice-verifier-worker.cjs")), this.modelManager.diarizationModelPaths().embedding);
        },
        onSpeakerPass: (streamId, pass) => {
          const recordingId = this.recordingInputs.get(streamId)?.recordingId ?? streamId;
          const recording = this.activeRecordings.get(recordingId);
          if (recording) (recording.speakerPasses ??= []).push(pass);
          else void pass.stop();
        },
      });
      this.worker.on("message", message => this.handleWorkerMessage(message));
      this.workerReady = true;
      this.setTranscriberStatus({ state: "ready", modelId, error: null });
      return this.transcriberStatus;
    }
    const entry = findAudioModel(modelId);
    if (!entry) {
      this.setTranscriberStatus({ state: "error", modelId, error: `Unknown model: ${modelId}` });
      return this.transcriberStatus;
    }
    const files = this.modelManager.installedModelPaths(modelId);
    if (!files) {
      this.setTranscriberStatus({ state: "error", modelId, error: "Model is not installed yet." });
      return this.transcriberStatus;
    }
    if (!this.modelManager.isVadInstalled()) {
      // Imported models skip the bundled VAD — fetch the ~2 MB file now.
      try {
        await this.modelManager.ensureVadInstalled();
      } catch (error) {
        this.setTranscriberStatus({
          state: "error",
          modelId,
          error: `Voice activity model missing and could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
        });
        return this.transcriberStatus;
      }
    }
    if (
      this.workerReady &&
      this.loadedModel?.modelId === modelId &&
      this.loadedModel?.language === language
    ) {
      return this.transcriberStatus;
    }

    this.stopWorker();
    this.setTranscriberStatus({ state: "loading", modelId, error: null });

    const worker = this.forkWorker(this.resolveWorkerPath());
    this.worker = worker;
    if (typeof worker.pid === "number" && worker.pid > 0) this.pinProcessQoS([worker.pid]);

    worker.on("message", (message) => this.handleWorkerMessage(message));
    worker.on("exit", (code) => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.workerReady = false;
      this.loadedModel = null;
      // Keep a specific error (e.g. the worker's own crash report) over the
      // generic exit message.
      if (this.transcriberStatus.state !== "idle" && this.transcriberStatus.state !== "error") {
        this.setTranscriberStatus({
          state: "error",
          modelId,
          error: `Transcription engine exited unexpectedly (code ${code ?? "?"}).`,
        });
      }
    });

    worker.postMessage({
      type: "load",
      model: { kind: entry.kind, files },
      vadPath: this.modelManager.vadModelPath(),
      language,
      numThreads: 2,
    });
    this.loadedModel = { modelId, language };
    return this.transcriberStatus;
  }

  handleWorkerMessage(message) {
    if (!message || typeof message !== "object") return;
    const input = this.recordingInputs.get(message.streamId);
    const streamId = input?.recordingId ?? message.streamId;
    const recording = this.activeRecordings.get(streamId) ?? this.backgroundRecordings.get(streamId);
    switch (message.type) {
      case "ready": {
        this.workerReady = true;
        for (const [streamId, buffers] of this.pendingPcm) {
          for (const buffer of buffers) {
            this.worker?.postMessage({ type: "pcm", streamId, buffer });
          }
        }
        this.pendingPcm.clear();
        this.setTranscriberStatus({
          state: "ready",
          modelId: this.loadedModel?.modelId ?? null,
          error: null,
        });
        break;
      }
      case "load-error": {
        const modelId = this.loadedModel?.modelId ?? null;
        this.stopWorker();
        this.setTranscriberStatus({ state: "error", modelId, error: message.error });
        break;
      }
      case "partial":
      case "segment": {
        const segment = {
          id: message.type === "segment" ? (input ? `${message.streamId}:${message.id}` : message.id) : `partial-${message.streamId}`,
          startMs: message.startMs,
          endMs: message.endMs,
          text: message.text,
          final: message.type === "segment",
          speaker: input?.speaker ?? (Number.isInteger(message.speaker) && message.speaker >= 0 ? message.speaker : null),
          ...(input ? { source: input.source } : {}),
        };
        const detected = recording?.cloudSpeakers?.get(message.streamId);
        const parts = recording?.cloudDiarize
          ? splitCloudTranscript(segment, detected?.words ?? [], detected?.turns ?? [], detected?.endMs ?? 0) : [segment];
        if (recording && segment.final) {
          if (recording.cloudDiarize) {
            recording.cloudSegments.set(segment.id, { streamId: message.streamId, original: segment, parts });
            recording.cloudPartials.delete(message.streamId);
          }
          const outOfOrder = recording.segments.at(-1)?.startMs > parts[0]?.startMs;
          recording.segments.push(...parts);
          recording.segments.sort((a, b) => a.startMs - b.startMs);
          for (const part of parts) recording.transcriptStream?.write(`${JSON.stringify(part)}\n`);
          // Mirror the growing transcript to the workspace file if armed.
          if (this.liveTranscript) {
            if (outOfOrder) this.liveTranscript.revision++;
            void this.writeLiveTranscript();
          }
        }
        if (segment.final) {
          for (const part of parts) this.broadcast({ type: "transcript-segment", streamId, segment: part });
          this.broadcast({ type: "transcript-partial-clear", streamId, endMs: segment.endMs, ...(input ? { source: input.source } : {}) });
        } else {
          if (recording?.cloudDiarize) recording.cloudPartials.set(message.streamId, segment);
          this.broadcast({ type: "transcript-partial", streamId, segment, parts });
        }
        break;
      }
      case "speaker-merge": {
        const detected = recording?.cloudSpeakers?.get(message.streamId);
        if (!detected || !recording) break;
        const names = recording.meta.speakerNames ?? {};
        const changed = [];
        for (const [from, to] of Object.entries(message.aliases)) {
          const oldId = detected.ids.get(Number(from));
          const newId = detected.ids.get(to);
          if (oldId == null || newId == null || oldId === newId) continue;
          for (const segment of recording.segments) {
            if (segment.speaker !== oldId) continue;
            segment.speaker = newId;
            changed.push(segment);
          }
          detected.ids.set(Number(from), newId);
          delete names[oldId];
        }
        if (changed.length) {
          recording.transcriptStream?.write(`${JSON.stringify({ replacedIds: [], segments: changed })}\n${JSON.stringify({ speakerNames: names })}\n`);
          this.broadcast({ type: "transcript-speakers-updated", streamId, segments: changed, speakerNames: { ...names } });
        }
        break;
      }
      case "speaker-turns": {
        if (!recording || recording.meta.ephemeral) break;
        recording.cloudSpeakers ??= new Map();
        let detected = recording.cloudSpeakers.get(message.streamId);
        if (!detected) {
          detected = { ids: new Map(), turns: [], words: [], endMs: 0 };
          recording.cloudSpeakers.set(message.streamId, detected);
        }
        const names = recording.meta.speakerNames ??= {};
        const turns = message.turns.map(turn => {
          if (input && message.voicesVerified !== true) return { ...turn, speaker: input.speaker };
          if (turn.speaker == null) return turn;
          if (!detected.ids.has(turn.speaker)) {
            // Reuse the input's first label. Further voices on that input get
            // distinct IDs; uncertainty never erases the known audio source.
            const speaker = input && detected.ids.size === 0
              ? input.speaker : Math.max(-1, ...Object.keys(names).map(Number)) + 1;
            detected.ids.set(turn.speaker, speaker);
            names[speaker] ??= `Speaker ${speaker + 1}`;
          }
          return { ...turn, speaker: detected.ids.get(turn.speaker) };
        });
        detected.endMs = Math.max(detected.endMs, message.endMs);
        detected.turns = mergeSpeakerTurns(detected.turns, { startMs: message.startMs, endMs: message.endMs, turns })
          .filter(turn => turn.endMs >= detected.endMs - 120_000);
        detected.words = mergeSpeakerWords(detected.words, { startMs: message.startMs, endMs: message.endMs,
          words: (message.words ?? []).map(word => ({ ...word, speaker: input && message.voicesVerified !== true
            ? input.speaker : word.speaker == null ? null : detected.ids.get(word.speaker) ?? null })) });
        const changed = [];
        const replacedIds = [];
        const replacements = new Map();
        for (const [id, entry] of recording.cloudSegments ?? []) {
          if (entry.streamId !== message.streamId || entry.original.startMs > detected.endMs + 4000) continue;
          if (entry.original.endMs < detected.endMs - 120_000) { recording.cloudSegments.delete(id); continue; }
          const parts = splitCloudTranscript(entry.original, detected.words, detected.turns, detected.endMs, entry.parts);
          if (JSON.stringify(parts) === JSON.stringify(entry.parts)) continue;
          replacedIds.push(...entry.parts.map(part => part.id));
          replacements.set(entry.parts[0].id, parts);
          changed.push(...parts);
          entry.parts = parts;
        }
        if (changed.length) {
          const removed = new Set(replacedIds);
          const next = recording.segments.flatMap(segment => replacements.get(segment.id) ?? (removed.has(segment.id) ? [] : [segment]));
          // Word alignment can move a trailing word past the next caption's
          // onset. Preserve the original order on each input, including when
          // uncertain words keep a different speaker label and become a part.
          const previousStarts = new Map();
          for (const segment of next) {
            const previousStart = previousStarts.get(segment.source) ?? 0;
            if (segment.startMs < previousStart) {
              segment.startMs = previousStart;
              segment.endMs = Math.max(segment.endMs, segment.startMs);
              if (!changed.includes(segment)) changed.push(segment);
            }
            previousStarts.set(segment.source, segment.startMs);
          }
          next.sort((a, b) => a.startMs - b.startMs);
          recording.segments.splice(0, recording.segments.length, ...next);
          recording.transcriptStream?.write(`${JSON.stringify({ replacedIds, segments: changed })}\n`);
        }
        recording.meta.speakerDetection = "cloud";
        recording.transcriptStream?.write(`${JSON.stringify({ speakerNames: names })}\n`);
        this.broadcast({ type: "transcript-speakers-updated", streamId, segments: changed, replacedIds, speakerNames: { ...names } });
        const partial = recording.cloudPartials?.get(message.streamId);
        if (partial) this.broadcast({ type: "transcript-partial", streamId, segment: partial,
          parts: splitCloudTranscript(partial, detected.words, detected.turns, detected.endMs) });
        if (this.liveTranscript?.live.meta.id === streamId && changed.length) {
          this.liveTranscript.revision++;
          void this.writeLiveTranscript();
        }
        break;
      }
      case "diarize-error": {
        if (recording) recording.meta.speakerError = message.error;
        this.broadcast({ type: "recording-warning", recordingId: streamId,
          error: recording?.meta.transcriptionSource === "cloud" ? message.error : `Live speaker detection is unavailable: ${message.error}. Transcription is still running.` });
        break;
      }
      case "stream-reconnecting":
      case "stream-reconnected": {
        if (!recording || recording.finishing || recording.cancelled) break;
        const interrupted = message.type === "stream-reconnecting";
        recording.reconnectingInputs ??= new Set();
        if (interrupted) {
          console.warn(`[recorder] Reconnecting live transcription for ${message.streamId}: ${message.error}`);
          recording.reconnectingInputs.add(message.streamId);
          // A reconnect cannot promise delivery of audio already sent to the
          // broken connection. Keep that caveat on the saved transcript.
          recording.meta.error ??= "Live transcription was interrupted. Some speech may be missing from the transcript. Your audio is saved on this device.";
          recording.cloudPartials?.delete(message.streamId);
          this.broadcast({ type: "transcript-partial-clear", streamId, endMs: Number.MAX_SAFE_INTEGER,
            ...(input ? { source: input.source } : {}) });
        } else recording.reconnectingInputs.delete(message.streamId);
        this.broadcast({ type: "recording-transcription-status", recordingId: streamId,
          reconnecting: recording.reconnectingInputs.size > 0 });
        break;
      }
      case "stream-error": {
        if (recording) {
          recording.meta.status = "error";
          recording.meta.error = message.error;
          this.dropRecordingStreams(streamId, !recording.meta.ephemeral);
          recording.resolveFinalized?.();
        }
        this.broadcast({ type: "recording-error", recordingId: streamId, error: message.error });
        break;
      }
      case "partial-clear": {
        const partial = recording?.cloudPartials?.get(message.streamId);
        if (partial && partial.endMs <= message.endMs) recording.cloudPartials.delete(message.streamId);
        this.broadcast({
          type: "transcript-partial-clear",
          streamId,
          endMs: message.endMs,
          ...(input ? { source: input.source } : {}),
        });
        break;
      }
      case "finalized": {
        if (recording) {
          if (!input) recording.speakerTurns = Array.isArray(message.speakers) ? message.speakers : null;
          recording.finalizingStreams?.delete(message.streamId);
          if (!recording.finalizingStreams?.size) recording.resolveFinalized?.();
        } else {
          this.broadcast({ type: "transcribe-file-done", streamId: message.streamId });
        }
        break;
      }
      default:
        break;
    }
  }

  stopWorker() {
    if (this.worker) {
      try {
        this.worker.postMessage({ type: "stop" });
        this.worker.kill();
      } catch {
        // already gone
      }
    }
    this.worker = null;
    this.workerReady = false;
    this.loadedModel = null;
    this.pendingPcm.clear();
  }

  stopTranscriber() {
    this.stopWorker();
    this.setTranscriberStatus({ state: "idle", modelId: null, error: null });
    return this.transcriberStatus;
  }

  // ── PCM / media chunk ingest (dedicated channels) ───────────────────────

  recordingStreamIds(recordingId) {
    const inputs = [...this.recordingInputs].filter(([, input]) => input.recordingId === recordingId).map(([id]) => id);
    return inputs.length ? inputs : [recordingId];
  }

  dropRecordingStreams(recordingId, preserveSpeakers = false) {
    for (const streamId of this.recordingStreamIds(recordingId)) {
      this.pendingPcm.delete(streamId);
      this.worker?.postMessage({ type: "drop", streamId, ...(preserveSpeakers ? { preserveSpeakers: true } : {}) });
    }
  }

  forgetRecordingStreams(recordingId) {
    for (const streamId of this.recordingStreamIds(recordingId)) {
      this.pendingPcm.delete(streamId);
      this.recordingInputs.delete(streamId);
    }
  }

  feedPcm(streamId, buffer, source) {
    if (!this.worker) return;
    const recording = this.activeRecordings.get(streamId);
    if (recording?.sourceStreams?.size) {
      if (!recording.sourceStreams.has(source) || recording.meta.status === "error") return;
      streamId = `${streamId}:${source}`;
    } else if (source !== undefined) return;
    if (!this.workerReady) {
      // ~120 s of 16 kHz Float32 per stream, then oldest chunks drop.
      const queue = this.pendingPcm.get(streamId) ?? [];
      queue.push(buffer);
      let queuedBytes = queue.reduce((sum, item) => sum + item.byteLength, 0);
      while (queue.length > 1 && queuedBytes > 120 * 16000 * 4) {
        queuedBytes -= queue[0].byteLength;
        queue.shift();
      }
      this.pendingPcm.set(streamId, queue);
      return;
    }
    this.worker.postMessage({ type: "pcm", streamId, buffer });
  }

  appendMediaChunk(recordingId, chunk, source) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) return;
    const stream = source === undefined ? recording.audioStream : recording.sourceStreams?.get(source);
    if (!stream) return;
    stream.write(Buffer.from(chunk));
    recording.sizeBytes += chunk.byteLength;
  }

  // ── recording lifecycle ─────────────────────────────────────────────────

  async startRecording(input) {
    // A source switch must never send a local recording to a previously loaded cloud worker.
    if (isCloudTranscriptionModel(input?.modelId) || isCloudTranscriptionModel(this.loadedModel?.modelId)) {
      if (!this.workerReady || this.loadedModel?.modelId !== input?.modelId) {
        throw new Error("The selected transcription engine is not ready.");
      }
    }
    const id = nowId();
    const folderPath = path.join(this.recordingsDir, id);
    await fsp.mkdir(folderPath, { recursive: true });
    const audioPath = path.join(folderPath, "audio.webm");

    /** @type {import("@legalwork/types/audio").AudioRecordingMeta} */
    const meta = {
      id,
      title: sanitizeTitle(input?.title || defaultRecordingTitle()),
      createdAt: Date.now(),
      durationMs: 0,
      language: input?.language ?? "auto",
      modelId: input?.modelId ?? null,
      transcriptionSource: isCloudTranscriptionModel(input?.modelId) ? "cloud" : "local",
      sources: Array.isArray(input?.sources) ? input.sources : ["microphone"],
      folderPath,
      audioPath,
      transcriptPath: null,
      sizeBytes: 0,
      segmentCount: 0,
      status: "recording",
      error: null,
      ephemeral: input?.ephemeral === true,
      projectIds: input?.ephemeral !== true && typeof input?.projectId === "string" && input.projectId.trim() ? [input.projectId.trim()] : [],
    };

    const cloudDiarize = isCloudTranscriptionModel(input?.modelId) && input?.diarize !== false && !meta.ephemeral;
    const separateSources = input?.separateSources === true && !meta.ephemeral && meta.sources.length > 1;
    /** @type {Map<import("@legalwork/types/audio").AudioCaptureSourceKind, import('node:fs').WriteStream>} */
    const sourceStreams = new Map();
    if (separateSources) {
      meta.sourceAudioPaths = {};
      meta.speakerNames = {};
      for (const source of new Set(meta.sources)) {
        if (!["microphone", "system", "app"].includes(source)) continue;
        const speaker = source === "microphone" ? 0 : source === "system" ? 1 : 2;
        meta.speakerNames[speaker] = source === "microphone" ? "Microphone" : source === "system" ? "System audio" : "App audio";
        const sourcePath = path.join(folderPath, `audio-${source}.webm`);
        meta.sourceAudioPaths[source] = sourcePath;
        sourceStreams.set(source, fs.createWriteStream(sourcePath));
        this.recordingInputs.set(`${id}:${source}`, { recordingId: id, source, speaker });
      }
    }

    // Diarization is opt-in, needs the models, and only makes sense for a
    // retained multi-voice recording (never a one-shot dictation).
    const diarize =
      input?.diarize === true &&
      !separateSources &&
      !isCloudTranscriptionModel(input?.modelId) &&
      input?.ephemeral !== true &&
      this.modelManager.isDiarizationInstalled();

    const audioStream = fs.createWriteStream(audioPath);
    const recording = {
      meta,
      segments: [],
      sizeBytes: 0,
      startedAt: Date.now(),
      audioStream,
      sourceStreams,
      transcriptStream: this.createTranscriptJournal(meta),
      resolveFinalized: null,
      diarize,
      cloudSpeakers: new Map(),
      cloudDiarize,
      meetingNotes: meta.transcriptionSource === "cloud" && !meta.ephemeral && input?.meetingNotes
        ? { enabled: input.meetingNotes.enabled === true,
          model: String(input.meetingNotes.model ?? "").slice(0, 200), instructions: String(input.meetingNotes.instructions ?? "").slice(0, 1000) } : undefined,
      cloudSegments: new Map(),
      cloudPartials: new Map(),
      speakerTurns: null,
    };
    // Without a listener a disk-full/unlink error would crash the main
    // process as an uncaught 'error' event mid-call.
    for (const stream of [audioStream, ...sourceStreams.values()]) stream.on("error", (error) => {
      meta.status = "error";
      meta.error = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: "recording-error", recordingId: id, error: meta.error });
    });
    this.activeRecordings.set(id, recording);
    if (isCloudTranscriptionModel(input?.modelId)) {
      for (const streamId of this.recordingStreamIds(id)) this.worker?.postMessage({ type: "begin", streamId, ephemeral: meta.ephemeral, diarize: input?.diarize !== false && !meta.ephemeral });
    }
    this.powerSessions.acquire(`recording:${id}`);
    try {
      await writeMeta(folderPath, meta);
    } catch (error) {
      // The renderer's rollback only fires once it has the id; a throw here
      // never returns one, so undo everything before rethrowing or the power
      // blocker and the active entry would leak until quit.
      this.dropRecordingStreams(id);
      this.forgetRecordingStreams(id);
      this.activeRecordings.delete(id);
      this.powerSessions.release(`recording:${id}`);
      await Promise.all([audioStream, ...sourceStreams.values()].map(finishStream));
      await finishStream(recording.transcriptStream);
      await fsp.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    // Identify speakers on bounded speech segments while recording.
    if (diarize && this.worker) {
      const paths = this.modelManager.diarizationModelPaths();
      this.worker.postMessage({
        type: "diarize-begin",
        streamId: id,
        segModel: paths.segmentation,
        embModel: paths.embedding,
        threshold: 0.5,
      });
    }
    this.broadcast({ type: "recording-started", recordingId: id });
    return meta;
  }

  async stopRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error(`Unknown recording: ${recordingId}`);
    try {
      recording.finishing ??= this.finishRecording(recordingId, recording);
      return await recording.finishing;
    } catch (error) {
      for (const pass of recording.speakerPasses ?? []) await pass.stop();
      this.backgroundRecordings.delete(recordingId);
      this.forgetRecordingStreams(recordingId);
      throw error;
    } finally {
      this.powerSessions.release(`recording:${recordingId}`);
    }
  }

  async finishRecording(recordingId, recording) {
    // Duration is capture time — the finalize round-trip below must not count.
    const stoppedAt = Date.now();

    // Stopped while the model was still loading? Wait for it so the PCM
    // buffered in pendingPcm still gets transcribed instead of thrown away.
    if (this.worker && !this.workerReady) {
      const deadline = Date.now() + 60_000;
      while (this.worker && !this.workerReady && !recording.cancelled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (recording.cancelled) throw new Error("Recording cancelled.");
    const streamIds = this.recordingStreamIds(recordingId);
    for (const streamId of streamIds) this.pendingPcm.delete(streamId);

    // Flush the VAD → wait for the trailing segments before writing files.
    // Cloud speaker detection runs after the live transcript has finished.
    if (this.worker && this.workerReady) {
      if (recording.diarize) this.broadcast({ type: "recording-diarizing", recordingId });
      const cloud = recording.meta.transcriptionSource === "cloud";
      // A very short dictation can finish while the cloud connection is still opening.
      const finalizeTimeout = recording.diarize ? 10 * 60_000 : cloud ? 120_000 : 15_000;
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (cloud) {
            recording.meta.status = "error";
            recording.meta.error = "Cloud transcription did not finish.";
            this.dropRecordingStreams(recordingId, !recording.meta.ephemeral);
          }
          resolve(undefined);
        }, finalizeTimeout);
        recording.resolveFinalized = () => {
          clearTimeout(timeout);
          resolve(undefined);
        };
        recording.finalizingStreams = new Set(streamIds);
        if (recording.meta.status === "error") {
          this.dropRecordingStreams(recordingId, !recording.meta.ephemeral);
          recording.resolveFinalized();
        } else {
          for (const streamId of streamIds) this.worker.postMessage({ type: "finalize", streamId });
        }
      });
    }
    if (recording.cancelled) throw new Error("Recording cancelled.");
    const background = Boolean(recording.speakerPasses?.length);
    if (background) this.backgroundRecordings.set(recordingId, recording);
    else this.forgetRecordingStreams(recordingId);
    // Keep dictation cancellable through file writes. Retained meetings still
    // detach here so their live-transcript mirror receives its ended marker.
    if (!recording.meta.ephemeral) this.activeRecordings.delete(recordingId);

    await Promise.all([recording.audioStream, ...recording.sourceStreams?.values() ?? []].map(finishStream));
    await finishStream(recording.transcriptStream);
    recording.transcriptStream = undefined;
    if (recording.cancelled) throw new Error("Recording cancelled.");

    const meta = recording.meta;
    meta.speakerProcessing = background;
    const summarize = Boolean(recording.segments.length && recording.meetingNotes?.enabled);
    meta.summaryProcessing = false;
    meta.durationMs = stoppedAt - recording.startedAt;
    meta.sizeBytes = recording.sizeBytes;
    meta.segmentCount = recording.segments.length;
    if (meta.status !== "error") meta.status = "complete";
    meta.transcriptPath = path.join(meta.folderPath, "transcript.json");

    const segments = recording.segments.sort((a, b) => a.startMs - b.startMs);
    meta.speakerCount = recording.speakerTurns?.length
      ? assignSpeakers(segments, recording.speakerTurns)
      : new Set(segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker])).size || null;
    if (this.liveTranscript?.live.meta.id === recordingId) {
      meta.workspaceTranscriptPaths = [...new Set([
        ...meta.workspaceTranscriptPaths ?? [], this.liveTranscript.filePath,
      ])];
    }
    await writeTranscriptFiles(meta, segments);
    await writeMeta(meta.folderPath, meta);
    // Recording ended → finalize the live-transcript mirror (one last write
    // with the "ended" header) and stop tracking; the file stays in place.
    if (this.liveTranscript && !this.currentLiveSegments()) {
      await this.writeLiveTranscript(true);
      this.liveTranscript = null;
      this.broadcast({ type: "live-transcript-stopped" });
    }
    await this.syncWorkspaceTranscripts(meta, segments);
    if (recording.cancelled) throw new Error("Recording cancelled.");
    if (background) {
      this.powerSessions.acquire(`speakers:${recordingId}`);
      const job = this.finishSpeakers(recordingId, recording).finally(() => {
        this.backgroundRecordings.delete(recordingId);
        this.speakerJobs.delete(recordingId);
        this.forgetRecordingStreams(recordingId);
        this.powerSessions.release(`speakers:${recordingId}`);
      });
      this.speakerJobs.set(recordingId, job);
    }
    this.activeRecordings.delete(recordingId);
    if (summarize) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.finishMeetingNotes(recordingId, recording, controller.signal))
        .finally(() => { this.summaryJobs.delete(recordingId); });
      this.summaryJobs.set(recordingId, { controller, promise });
    }
    return { ...meta };
  }

  /** @param {string} recordingId
   * @param {Pick<import("@legalwork/types/audio").AudioMeetingNotesSettings, "model" | "instructions">} settings */
  summarizeRecording(recordingId, settings) {
    if (this.summaryJobs.has(recordingId)) return this.getRecording(recordingId);
    const controller = new AbortController();
    const started = Promise.resolve().then(() => this.updateSavedTranscript(recordingId, saved => {
      if (controller.signal.aborted) throw new Error("Meeting notes cancelled.");
      if (saved.meta.transcriptionSource !== "cloud" || !isCloudTranscriptionModel(saved.meta.modelId)) throw new Error("Summarizing requires a cloud recording.");
      if (saved.meta.speakerProcessing) throw new Error("Wait for speaker detection to finish before generating the summary.");
      if (!saved.segments.some(segment => segment.text.trim())) throw new Error("This recording has no transcript to summarize.");
      if (saved.meta.summary) return saved;
      return { ...saved, meta: { ...saved.meta, summaryProcessing: true, summaryError: undefined } };
    })).then(detail => {
      this.broadcast({ type: "recording-updated", meta: detail.meta });
      return detail;
    });
    // Reserve the job before the first asynchronous read so clicks in two
    // transcript tabs cannot start duplicate model requests.
    const promise = started.then(async detail => {
      if (controller.signal.aborted || detail.meta.summary) return;
      await this.finishMeetingNotes(recordingId, { meta: detail.meta, meetingNotes: {
        enabled: true, model: String(settings?.model ?? "").slice(0, 200),
        instructions: String(settings?.instructions ?? "").slice(0, 1000),
      } }, controller.signal);
    }).catch(() => {}).finally(() => { this.summaryJobs.delete(recordingId); });
    this.summaryJobs.set(recordingId, { controller, promise });
    return started;
  }

  async finishMeetingNotes(recordingId, recording, signal) {
    try {
      await this.speakerJobs.get(recordingId);
      if (signal.aborted) return;
      const detail = await this.getRecording(recordingId);
      if (!detail || detail.meta.transcriptionSource !== "cloud" || detail.meta.ephemeral) return;
      if (detail.meta.speakerProcessing) throw new Error("Wait for speaker detection to finish before generating the summary.");
      if (!this.generateMeetingNotes) throw new Error("Meeting notes are unavailable. Your transcript is saved.");
      if (!detail.meta.summaryProcessing) {
        const started = await this.updateSavedTranscript(recordingId, saved => {
          if (signal.aborted) throw new Error("Meeting notes cancelled.");
          if (saved.meta.speakerProcessing) throw new Error("Wait for speaker detection to finish before generating the summary.");
          return { ...saved, meta: { ...saved.meta, summaryProcessing: true, summaryError: undefined } };
        });
        this.broadcast({ type: "recording-updated", meta: started.meta });
      }
      if (signal.aborted) return;
      const result = await this.generateMeetingNotes({ model: detail.meta.modelId,
        transcript: detail.segments.map(segment => `[speaker:${segment.speaker ?? "unknown"}] ${segment.text.replace(/\s+/g, " ")}`).join("\n"),
        speakers: [...new Set(detail.segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker]))]
          .map(id => ({ id, label: speakerLabel(id, detail.meta.speakerNames) })), settings: recording.meetingNotes }, signal);
      if (signal.aborted) return;
      const updated = await this.updateSavedTranscript(recordingId, saved => {
        if (signal.aborted) throw new Error("Meeting notes cancelled.");
        const speakerNames = { ...saved.meta.speakerNames };
        for (const [id, name] of Object.entries(result.speakerNames ?? {})) {
          const before = detail.meta.speakerNames?.[id];
          if (saved.segments.some(segment => String(segment.speaker) === id)
            && saved.meta.speakerNames?.[id] === before
            && (!before || /^(?:Microphone|System audio|App audio)(?: \d+)?$|^Speaker \d+$/.test(before))) speakerNames[id] = name;
        }
        return { ...saved, meta: { ...saved.meta, speakerNames, summaryProcessing: false, summaryError: undefined,
          // A name edited while this request was pending belongs to the user.
          ...(result.title && saved.meta.title === recording.meta.title ? { title: sanitizeTitle(result.title) } : {}),
          ...(result.summary ? { summary: result.summary } : {}),
        } };
      });
      this.broadcast({ type: "recording-updated", meta: updated.meta });
    } catch (error) {
      if (signal.aborted) return;
      const updated = await this.updateSavedTranscript(recordingId, saved => ({ ...saved, meta: { ...saved.meta,
        summaryProcessing: false, summaryError: error instanceof RecorderRequestError ? error.message
          : error instanceof Error && error.name === "TimeoutError"
            ? "Meeting notes took too long to generate. Try again. Your transcript is saved."
            : "Meeting notes could not be generated. Try again or check your notes model and settings. Your transcript is saved." },
      })).catch(() => null);
      if (updated) this.broadcast({ type: "recording-updated", meta: updated.meta });
    }
  }

  async finishSpeakers(recordingId, recording) {
    try {
      await Promise.all(recording.speakerPasses.map(pass => pass.finish()));
      if (this.backgroundRecordings.get(recordingId) !== recording) return;
      const detail = await this.updateSavedTranscript(recordingId, saved => {
        if (this.backgroundRecordings.get(recordingId) !== recording) throw new Error("Speaker detection cancelled.");
        return { segments: recording.segments, meta: {
          ...saved.meta, speakerProcessing: false, speakerError: recording.meta.speakerError,
          speakerDetection: recording.meta.speakerDetection, speakerNames: recording.meta.speakerNames,
          segmentCount: recording.segments.length,
          speakerCount: new Set(recording.segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker])).size || null,
        } };
      });
      this.broadcast({ type: "recording-updated", meta: detail.meta });
    } catch (error) {
      if (this.backgroundRecordings.get(recordingId) !== recording) return;
      const detail = await this.updateSavedTranscript(recordingId, saved => ({ ...saved,
        meta: { ...saved.meta, speakerProcessing: false, speakerError: `Speaker detection could not finish: ${error.message}` },
      })).catch(() => null);
      if (detail) this.broadcast({ type: "recording-updated", meta: detail.meta });
    } finally {
      await Promise.all(recording.speakerPasses.map(pass => pass.stop()));
    }
  }

  async cancelRecording(recordingId) {
    const summary = this.summaryJobs.get(recordingId);
    summary?.controller.abort();
    const background = this.backgroundRecordings.get(recordingId);
    if (background) {
      this.backgroundRecordings.delete(recordingId);
      await Promise.all(background.speakerPasses.map(pass => pass.stop()));
      await this.speakerJobs.get(recordingId);
    }
    await summary?.promise;
    const recording = this.activeRecordings.get(recordingId);
    if (recording) {
      recording.cancelled = true;
      recording.resolveFinalized?.();
    }
    this.dropRecordingStreams(recordingId);
    this.forgetRecordingStreams(recordingId);
    if (!recording) return;
    this.activeRecordings.delete(recordingId);
    this.powerSessions.release(`recording:${recordingId}`);
    // A pending finalize must settle before removing its folder; otherwise a
    // late completion can recreate cancelled files or write into a new session.
    await recording.finishing?.catch(() => {});
    // Imported files have no live webm stream (audioStream === null).
    await Promise.all([recording.audioStream, ...recording.sourceStreams?.values() ?? []].map(finishStream));
    await finishStream(recording.transcriptStream);
    await fsp.rm(recording.meta.folderPath, { recursive: true, force: true });
    if (this.liveTranscript && !this.currentLiveSegments()) {
      await this.writeLiveTranscript(true);
      this.liveTranscript = null;
      this.broadcast({ type: "live-transcript-stopped" });
    }
  }

  // ── file import (drag & drop) ───────────────────────────────────────────
  //
  // Transcribe an existing audio file. The renderer decodes it to 16 kHz mono
  // Float32 PCM via Web Audio (the main process has no bundled decoder) and
  // streams that through the SAME `sendPcm` → worker path a live recording
  // uses; here we just own the folder/meta and finalize. The original file is
  // stored verbatim so it can be revealed/played later.

  async importFileStart(input) {
    const id = nowId();
    const folderPath = path.join(this.recordingsDir, id);
    await fsp.mkdir(folderPath, { recursive: true });
    const audioName = sanitizeFileName(input?.fileName || "audio");
    const audioPath = path.join(folderPath, audioName);

    /** @type {import("@legalwork/types/audio").AudioRecordingMeta} */
    const meta = {
      id,
      title: sanitizeTitle(input?.title || stripExtension(input?.fileName) || defaultRecordingTitle()),
      createdAt: Date.now(),
      durationMs: 0,
      language: input?.language ?? "auto",
      modelId: input?.modelId ?? null,
      sources: [],
      folderPath,
      audioPath,
      transcriptPath: null,
      sizeBytes: 0,
      segmentCount: 0,
      status: "recording",
      error: null,
      ephemeral: false,
    };
    const recording = {
      meta,
      segments: [],
      sizeBytes: 0,
      startedAt: Date.now(),
      audioStream: null,
      transcriptStream: this.createTranscriptJournal(meta),
      resolveFinalized: null,
      importAudioPath: audioPath,
    };
    this.activeRecordings.set(id, recording);
    // Same key namespace as live recordings: the shared cancelRecording
    // error path releases it either way.
    this.powerSessions.acquire(`recording:${id}`);
    try {
      await writeMeta(folderPath, meta);
    } catch (error) {
      this.activeRecordings.delete(id);
      this.powerSessions.release(`recording:${id}`);
      await finishStream(recording.transcriptStream);
      await fsp.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    this.broadcast({ type: "recording-started", recordingId: id });
    return meta;
  }

  /** Persist the original file bytes (called once with the whole file). */
  async importFileSource(recordingId, buffer) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording?.importAudioPath) return { ok: false };
    await fsp.writeFile(recording.importAudioPath, Buffer.from(buffer));
    recording.sizeBytes = buffer.byteLength;
    return { ok: true };
  }

  async importFileFinish(recordingId, durationMs) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error(`Unknown import: ${recordingId}`);
    try {
      return await this.finishImport(recordingId, recording, durationMs);
    } finally {
      this.powerSessions.release(`recording:${recordingId}`);
    }
  }

  async finishImport(recordingId, recording, durationMs) {
    // The renderer streams the whole file's PCM before calling finish; wait for
    // the model if it is still loading so nothing is dropped.
    if (this.worker && !this.workerReady) {
      const deadline = Date.now() + 60_000;
      while (this.worker && !this.workerReady && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    // Flush the VAD and wait for the worker to drain its decode queue. Files can
    // be long, so the safety timeout is generous; normal completion resolves on
    // the worker's `finalized` message.
    if (this.worker && this.workerReady) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 15 * 60_000);
        recording.resolveFinalized = () => {
          clearTimeout(timeout);
          resolve(undefined);
        };
        this.worker.postMessage({ type: "finalize", streamId: recordingId });
      });
    }
    this.pendingPcm.delete(recordingId);
    this.activeRecordings.delete(recordingId);

    const meta = recording.meta;
    const segments = recording.segments.sort((a, b) => a.startMs - b.startMs);
    const lastEnd = segments.length ? segments[segments.length - 1].endMs : 0;
    meta.durationMs = Math.max(Number(durationMs) || 0, lastEnd);
    meta.sizeBytes = recording.sizeBytes;
    meta.segmentCount = segments.length;
    if (meta.status !== "error") meta.status = "complete";
    meta.transcriptPath = path.join(meta.folderPath, "transcript.json");

    await finishStream(recording.transcriptStream);
    await writeTranscriptFiles(meta, segments);
    await writeMeta(meta.folderPath, meta);
    return meta;
  }

  async listRecordings() {
    let entries = [];
    try {
      entries = await fsp.readdir(this.recordingsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const metas = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readMeta(path.join(this.recordingsDir, entry.name));
      if (!meta) continue;
      if (meta.ephemeral) {
        // Sweep only stale strays (crash leftovers). A fresh ephemeral
        // dictation may be between "stopped" and retainRecording (failed
        // paste) when a concurrent list runs — deleting it here would race
        // the retain and destroy spoken text.
        const age = Date.now() - (Number(meta.createdAt) || 0);
        if (!this.activeRecordings.has(meta.id) && age > 60 * 60 * 1000) {
          await fsp.rm(path.join(this.recordingsDir, entry.name), { recursive: true, force: true });
        }
        continue;
      }
      if ((meta.status === "recording" && !this.activeRecordings.has(meta.id)) || (meta.speakerProcessing && !this.backgroundRecordings.has(meta.id))
        || (meta.summaryProcessing && !this.summaryJobs.has(meta.id))) {
        const recovered = await this.getRecording(meta.id);
        if (recovered) metas.push(recovered.meta);
      } else metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return metas;
  }

  async getRecording(recordingId) {
    const active = this.activeRecordings.get(recordingId);
    if (active) return { meta: active.meta, segments: [...active.segments] };
    const folderPath = path.join(this.recordingsDir, recordingId);
    const meta = await readMeta(folderPath);
    if (!meta) return null;
    if (meta.summaryProcessing && !this.summaryJobs.has(recordingId)) {
      meta.summaryProcessing = false;
      meta.summaryError = "Meeting notes were interrupted. Your transcript is saved.";
      await writeMeta(folderPath, meta);
    }
    if (meta.speakerProcessing && !this.backgroundRecordings.has(recordingId)) {
      meta.speakerProcessing = false;
      meta.speakerError = "Speaker detection was interrupted. Your transcript is saved.";
      await writeMeta(folderPath, meta);
    }
    let segments = [];
    try {
      const raw = await fsp.readFile(path.join(folderPath, "transcript.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.segments)) segments = parsed.segments;
    } catch {
      // Recover completed segments after an interrupted recording, tolerating
      // a partially written final line. Audio has also been streamed to disk.
      const journal = await fsp.readFile(path.join(folderPath, "transcript.jsonl"), "utf8").catch(() => "");
      const recovered = new Map();
      for (const line of journal.split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (entry.final && typeof entry.text === "string") recovered.set(entry.id, entry);
          else if (Array.isArray(entry.replacedIds) && Array.isArray(entry.segments)) {
            for (const id of entry.replacedIds) recovered.delete(id);
            for (const segment of entry.segments) if (segment.final && typeof segment.text === "string") recovered.set(segment.id, segment);
          }
          else if (entry.speakerNames) meta.speakerNames = entry.speakerNames;
        } catch { /* incomplete tail */ }
      }
      segments = [...recovered.values()].sort((a, b) => a.startMs - b.startMs);
    }
    if (meta.status === "recording") {
      meta.status = "error";
      meta.error = "Recording was interrupted. Saved audio and transcript segments have been recovered.";
      meta.segmentCount = segments.length;
      meta.durationMs = segments.reduce((end, segment) => Math.max(end, segment.endMs), 0);
      meta.sizeBytes = meta.audioPath ? (await fsp.stat(meta.audioPath).catch(() => null))?.size ?? 0 : 0;
      meta.transcriptPath = path.join(folderPath, "transcript.json");
      meta.speakerCount = new Set(segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker])).size || null;
      await writeTranscriptFiles(meta, segments);
      await writeMeta(folderPath, meta);
    }
    meta.summary = resolveSummarySpeakerNames(meta.summary, meta.speakerNames);
    return { meta, segments };
  }

  transcriptEdits = new Map();

  /** Serialize corrections so two open transcript tabs cannot overwrite each other. */
  async updateSavedTranscript(recordingId, update) {
    if (!/^[a-zA-Z0-9_-]+$/.test(recordingId)) throw new Error("Invalid recording.");
    const previous = this.transcriptEdits.get(recordingId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const detail = await this.getRecording(recordingId);
      if (!detail || detail.meta.ephemeral) throw new Error("Recording not found.");
      if (this.activeRecordings.has(recordingId) || detail.meta.status === "recording") throw new Error("Finish recording before editing speakers.");
      const updated = update(detail);
      updated.meta.summary = resolveSummarySpeakerNames(updated.meta.summary, updated.meta.speakerNames);
      // Always resolve the destination ourselves, never trust a path in metadata.
      updated.meta.folderPath = path.join(this.recordingsDir, recordingId);
      await fsp.appendFile(path.join(updated.meta.folderPath, "transcript.jsonl"), `${JSON.stringify({
        replacedIds: detail.segments.map(segment => segment.id), segments: updated.segments,
      })}\n${JSON.stringify({ speakerNames: updated.meta.speakerNames ?? {} })}\n`);
      await writeTranscriptFiles(updated.meta, updated.segments);
      await writeMeta(updated.meta.folderPath, updated.meta);
      await this.syncWorkspaceTranscripts(updated.meta, updated.segments);
      return updated;
    });
    this.transcriptEdits.set(recordingId, operation);
    try { return await operation; }
    finally { if (this.transcriptEdits.get(recordingId) === operation) this.transcriptEdits.delete(recordingId); }
  }

  editTranscript(recordingId, edit) {
    return this.updateSavedTranscript(recordingId, detail => {
      if (detail.meta.speakerProcessing) throw new Error("Wait for speaker detection to finish before editing speakers.");
      return editTranscriptSpeakers(detail, edit);
    });
  }

  /**
   * Resolve a finished recording's audio file path, for the `lw-recording://`
   * playback protocol. Returns null (rather than risking traversal) unless the
   * id is a single, safe path segment that resolves inside the recordings dir
   * and the file exists.
   *
   * Live recordings write `audio.webm`; imported files are stored verbatim
   * under their original name + extension (e.g. `recording.mp3`), so the webm
   * fast path misses them — fall back to the source file recorded in meta.json.
   */
  recordingAudioFilePath(recordingId) {
    const id = String(recordingId || "");
    if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
    const folder = path.join(this.recordingsDir, id);
    if (!folder.startsWith(this.recordingsDir + path.sep)) return null;
    const webmPath = path.join(folder, "audio.webm");
    if (fs.existsSync(webmPath)) return webmPath;
    // Imported audio keeps its original extension; the file name lives in
    // meta.audioPath. Resolve only its basename inside the folder so a
    // tampered meta can never point playback outside the recordings dir.
    let audioName = "";
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8"));
      if (meta?.audioPath) audioName = path.basename(String(meta.audioPath));
    } catch {
      return null;
    }
    if (!audioName || audioName === "meta.json") return null;
    const audioPath = path.join(folder, audioName);
    if (!audioPath.startsWith(folder + path.sep)) return null;
    return fs.existsSync(audioPath) ? audioPath : null;
  }

  async deleteRecording(recordingId) {
    await this.cancelRecording(recordingId).catch(() => {});
    await fsp.rm(path.join(this.recordingsDir, recordingId), { recursive: true, force: true });
    return this.listRecordings();
  }

  /**
   * The renderer that was feeding PCM died (crash / reload). Its recordings
   * can never receive more audio, so finalize call recordings (keep what was
   * captured) and cancel dictations/imports (no renderer left to paste or
   * stream). Both paths release the power session and clear the active entry,
   * so the app can idle-sleep and the close-to-hide latch lifts.
   */
  async abandonActiveRecordings() {
    for (const id of [...this.activeRecordings.keys()]) {
      const recording = this.activeRecordings.get(id);
      if (!recording) continue;
      const savePartial = Boolean(recording.audioStream) && recording.meta.ephemeral !== true;
      if (savePartial) {
        await this.stopRecording(id).catch(() => this.cancelRecording(id).catch(() => {}));
      } else {
        await this.cancelRecording(id).catch(() => {});
      }
    }
  }

  /**
   * Flip an ephemeral recording (system dictation) to retained. Used when the
   * paste failed: spoken text that never reached its target must stay
   * recoverable in the Recorder history instead of being swept on next list.
   */
  async retainRecording(recordingId) {
    const folderPath = path.join(this.recordingsDir, recordingId);
    const meta = this.activeRecordings.get(recordingId)?.meta ?? (await readMeta(folderPath));
    if (!meta || meta.ephemeral !== true) return this.listRecordings();
    meta.ephemeral = false;
    await writeMeta(meta.folderPath, meta);
    return this.listRecordings();
  }

  /**
   * Post-wake health check: sleep can take the transcription utilityProcess
   * down (or leave its runtime dead); if a model was loaded, make sure the
   * worker is alive again so the first post-wake dictation is not the moment
   * the user discovers it died.
   */
  async ensureTranscriberAfterWake() {
    const loaded = this.loadedModel;
    if (!loaded) return this.transcriberStatus;
    if (this.worker && this.workerReady) return this.transcriberStatus;
    if (this.worker && !this.workerReady) return this.transcriberStatus; // load in flight
    this.loadedModel = null;
    return this.startTranscriber({ modelId: loaded.modelId, language: loaded.language });
  }

  async setRecordingProject(recordingId, projectId, linked) {
    if (!/^[a-zA-Z0-9_-]+$/.test(recordingId) || !projectId.trim()) {
      throw new Error("Invalid recording or project.");
    }
    const folder = path.join(this.recordingsDir, recordingId);
    const meta = this.activeRecordings.get(recordingId)?.meta ?? await readMeta(folder);
    if (!meta || meta.ephemeral) throw new Error("Recording not found.");
    const ids = new Set(meta.projectIds ?? []);
    if (linked) ids.add(projectId.trim());
    else ids.delete(projectId.trim());
    meta.projectIds = [...ids];
    await writeMeta(folder, meta);
    return this.listRecordings();
  }

  async renameRecording(recordingId, title) {
    const raw = String(title ?? "").trim();
    const nextTitle = raw ? sanitizeTitle(raw) : "";
    if (nextTitle) {
      const active = this.activeRecordings.get(recordingId);
      if (active) {
        active.meta.title = nextTitle;
        await writeMeta(active.meta.folderPath, active.meta);
      } else {
        await this.updateSavedTranscript(recordingId, detail => ({
          ...detail, meta: { ...detail.meta, title: nextTitle },
        }));
      }
    }
    return this.listRecordings();
  }

  /**
   * Copy a finished recording into a workspace folder so the OpenCode
   * session (whose cwd is that folder) can read audio + transcript directly.
   */
  async saveToWorkspace(recordingId, workspacePath) {
    const detail = await this.getRecording(recordingId);
    if (!detail) return { ok: false, folderPath: null, error: "Recording not found." };
    const root = String(workspacePath ?? "").trim();
    if (!root || !fs.existsSync(root)) {
      return { ok: false, folderPath: null, error: "Workspace folder not found." };
    }
    const slug = `${formatDateSlug(detail.meta.createdAt)}-${detail.meta.title}`
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const target = path.join(root, "recordings", slug || recordingId);
    try {
      await fsp.mkdir(target, { recursive: true });
      await fsp.cp(detail.meta.folderPath, target, { recursive: true, force: true });
      return { ok: true, folderPath: target, error: null };
    } catch (error) {
      return {
        ok: false,
        folderPath: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The shareable part of a finished recording (its audio and transcripts,
   * never meta.json, which names this computer's paths) into a synced
   * project's `recordings/` folder, where project sync takes it to the firm.
   * Returns the folder written, or null when the recording is not finished.
   */
  async exportToProject(recordingId, projectRoot) {
    const detail = await this.getRecording(recordingId);
    const root = String(projectRoot ?? "").trim();
    if (!detail || detail.meta.status !== "complete" || !root || !fs.existsSync(root)) return null;
    const slug = `${formatDateSlug(detail.meta.createdAt)}-${detail.meta.title}`
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const target = path.join(root, "recordings", slug || recordingId);
    await fsp.mkdir(target, { recursive: true });
    for (const name of await fsp.readdir(detail.meta.folderPath)) {
      if (name === "meta.json" || name.startsWith(".")) continue;
      await fsp.copyFile(path.join(detail.meta.folderPath, name), path.join(target, name));
    }
    return target;
  }

  dispose() {
    for (const job of this.summaryJobs.values()) job.controller.abort();
    this.stopWorker();
    for (const [id, recording] of this.backgroundRecordings) {
      for (const pass of recording.speakerPasses) void pass.stop();
      this.powerSessions.release(`speakers:${id}`);
    }
    this.backgroundRecordings.clear();
    for (const recording of this.activeRecordings.values()) {
      this.powerSessions.release(`recording:${recording.meta.id}`);
      try {
        recording.audioStream?.end();
        for (const stream of recording.sourceStreams?.values() ?? []) stream.end();
        recording.transcriptStream?.end();
      } catch {
        // shutting down
      }
    }
    this.activeRecordings.clear();
    this.recordingInputs.clear();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

async function finishStream(stream) {
  if (!stream) return;
  stream.end();
  await finished(stream).catch(() => {}); // errors are reported by the stream listener
}

function defaultRecordingTitle() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `Recording ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

function formatDateSlug(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function writeMeta(folderPath, meta) {
  await fsp.writeFile(path.join(folderPath, "meta.json"), JSON.stringify(meta, null, 2));
}

async function readMeta(folderPath) {
  try {
    const raw = await fsp.readFile(path.join(folderPath, "meta.json"), "utf8");
    const meta = JSON.parse(raw);
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

function formatSrtTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

function formatClockTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Stamp a speaker id on each ASR segment from independent diarization turns,
 * by largest total time-overlap (majority vote), with a nearest-turn fallback
 * for short utterances that fell in a gap. Raw ids are remapped to
 * first-appearance order so labels read "Speaker 1", "Speaker 2", … Returns
 * the distinct speaker count, or null when no diarization was available.
 */
export function assignSpeakers(segments, turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    for (const segment of segments) segment.speaker = null;
    return null;
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  for (const segment of segments) {
    const perSpeaker = new Map();
    for (const turn of turns) {
      const ov = overlap(segment, turn);
      if (ov > 0) perSpeaker.set(turn.speaker, (perSpeaker.get(turn.speaker) ?? 0) + ov);
    }
    let best = null;
    let bestOverlap = 0;
    for (const [speaker, ov] of perSpeaker) {
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = speaker;
      }
    }
    if (best === null) {
      const mid = (segment.startMs + segment.endMs) / 2;
      let nearestDist = Infinity;
      for (const turn of turns) {
        const dist = mid < turn.startMs ? turn.startMs - mid : mid > turn.endMs ? mid - turn.endMs : 0;
        if (dist < nearestDist) {
          nearestDist = dist;
          best = turn.speaker;
        }
      }
    }
    segment.speaker = best;
  }
  const order = new Map();
  for (const segment of segments) {
    if (segment.speaker == null) continue;
    if (!order.has(segment.speaker)) order.set(segment.speaker, order.size);
  }
  for (const segment of segments) {
    if (segment.speaker != null) segment.speaker = order.get(segment.speaker);
  }
  return order.size || null;
}

function speakerLabel(speaker, names) {
  return speaker == null ? null : names?.[speaker] ?? `Speaker ${speaker + 1}`;
}

export async function writeTranscriptFiles(meta, segments) {
  const folder = meta.folderPath;
  await fsp.writeFile(
    path.join(folder, "transcript.json"),
    JSON.stringify(
      {
        recordingId: meta.id,
        title: meta.title,
        summary: meta.summary,
        createdAt: meta.createdAt,
        durationMs: meta.durationMs,
        language: meta.language,
        modelId: meta.modelId,
        sources: meta.sources,
        speakerNames: meta.speakerNames,
        segments,
      },
      null,
      2,
    ),
  );

  const srt = segments
    .map((segment, index) => {
      const label = speakerLabel(segment.speaker, meta.speakerNames);
      const text = label ? `${label}: ${segment.text}` : segment.text;
      return `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${text}\n`;
    })
    .join("\n");
  await fsp.writeFile(path.join(folder, "transcript.srt"), srt);

  const txt = segments
    .map((segment) => {
      const label = speakerLabel(segment.speaker, meta.speakerNames);
      return label ? `${label}: ${segment.text}` : segment.text;
    })
    .join("\n");
  await fsp.writeFile(path.join(folder, "transcript.txt"), txt);

  const md = [
    `# ${meta.title}`,
    "",
    `- Recorded: ${new Date(meta.createdAt).toISOString()}`,
    `- Duration: ${formatClockTime(meta.durationMs)}`,
    `- Language: ${meta.language}`,
    `- Model: ${meta.modelId ?? "Unknown"} (${meta.transcriptionSource === "cloud" ? "cloud" : "local, on-device"})`,
    `- Sources: ${meta.sources.join(", ")}`,
    ...(meta.speakerCount ? [`- Speakers: ${meta.speakerCount}${meta.speakerDetection === "cloud" ? " (identified in the cloud)" : meta.sourceAudioPaths ? " (labeled by audio input)" : " (identified on-device)"}`] : []),
    "",
    ...(meta.summary ? ["## Summary", "", meta.summary, ""] : []),
    "## Transcript",
    "",
    ...segments.map((segment) => {
      const time = formatClockTime(segment.startMs);
      const label = speakerLabel(segment.speaker, meta.speakerNames);
      const prefix = label ? `**[${time}] ${label}:**` : `**[${time}]**`;
      return `${prefix} ${segment.text}`;
    }),
    "",
  ].join("\n");
  await fsp.writeFile(path.join(folder, "transcript.md"), md);
}
