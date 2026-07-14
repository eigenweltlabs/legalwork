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

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { AudioModelManager } from "./model-manager.mjs";
import { findAudioModel } from "./model-catalog.mjs";
import { macOsAtLeast } from "./mac-version.mjs";

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
   * }} options
   */
  constructor(options) {
    this.userDataDir = options.userDataDir;
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
     *   resolveFinalized: (() => void) | null,
     *   importAudioPath?: string,
     *   diarize?: boolean,
     *   speakerTurns?: { startMs: number, endMs: number, speaker: number }[] | null,
     * }>}
     */
    this.activeRecordings = new Map();

    /**
     * Live-transcript mirror: while set, the growing transcript of the active
     * recording is continuously written to a markdown file in a workspace so
     * the agent can read the latest conversation on demand (composer "Live
     * call" toggle). Cleared when toggled off or the recording ends.
     * @type {{ workspacePath: string, filePath: string, fileName: string } | null}
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
    this.liveTranscript = { workspacePath: root, filePath, fileName };
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

  writeLiveTranscript() {
    const target = this.liveTranscript;
    if (!target) return this.liveTranscriptWriteQueue;
    const live = this.currentLiveSegments();
    const recording = Boolean(live);
    const segments = live?.segments ?? [];
    const title = live?.meta?.title ?? "Live call";
    const body = [
      `# ${title}`,
      "",
      recording
        ? "> Live transcript — recorded locally, on-device. This file keeps growing until the recording ends."
        : "> Recording ended. This is the final transcript.",
      "",
      "## Transcript",
      "",
      ...(segments.length
        ? segments.map((segment) => `**[${formatClockTime(segment.startMs)}]** ${segment.text}`)
        : ["_Waiting for speech…_"]),
      "",
    ].join("\n");
    // Serialize writes so overlapping segment events never interleave.
    this.liveTranscriptWriteQueue = this.liveTranscriptWriteQueue
      .then(() => (this.liveTranscript ? fsp.writeFile(target.filePath, body) : undefined))
      .catch(() => {});
    return this.liveTranscriptWriteQueue;
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
          id: message.type === "segment" ? message.id : `partial-${message.streamId}`,
          startMs: message.startMs,
          endMs: message.endMs,
          text: message.text,
          final: message.type === "segment",
        };
        const recording = this.activeRecordings.get(message.streamId);
        if (recording && segment.final) {
          recording.segments.push(segment);
          // Mirror the growing transcript to the workspace file if armed.
          if (this.liveTranscript) void this.writeLiveTranscript();
        }
        this.broadcast({
          type: message.type === "segment" ? "transcript-segment" : "transcript-partial",
          streamId: message.streamId,
          segment,
        });
        break;
      }
      case "partial-clear": {
        this.broadcast({
          type: "transcript-partial-clear",
          streamId: message.streamId,
          endMs: message.endMs,
        });
        break;
      }
      case "finalized": {
        const recording = this.activeRecordings.get(message.streamId);
        if (recording) {
          recording.speakerTurns = Array.isArray(message.speakers) ? message.speakers : null;
          recording.resolveFinalized?.();
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

  feedPcm(streamId, buffer) {
    if (!this.worker) return;
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

  appendMediaChunk(recordingId, chunk) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording || !recording.audioStream) return;
    recording.audioStream.write(Buffer.from(chunk));
    recording.sizeBytes += chunk.byteLength;
  }

  // ── recording lifecycle ─────────────────────────────────────────────────

  async startRecording(input) {
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
      sources: Array.isArray(input?.sources) ? input.sources : ["microphone"],
      folderPath,
      audioPath,
      transcriptPath: null,
      sizeBytes: 0,
      segmentCount: 0,
      status: "recording",
      error: null,
      ephemeral: input?.ephemeral === true,
    };

    // Diarization is opt-in, needs the models, and only makes sense for a
    // retained multi-voice recording (never a one-shot dictation).
    const diarize =
      input?.diarize === true &&
      input?.ephemeral !== true &&
      this.modelManager.isDiarizationInstalled();

    const audioStream = fs.createWriteStream(audioPath);
    const recording = {
      meta,
      segments: [],
      sizeBytes: 0,
      startedAt: Date.now(),
      audioStream,
      resolveFinalized: null,
      diarize,
      speakerTurns: null,
    };
    // Without a listener a disk-full/unlink error would crash the main
    // process as an uncaught 'error' event mid-call.
    audioStream.on("error", (error) => {
      meta.status = "error";
      meta.error = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: "recording-error", recordingId: id, error: meta.error });
    });
    this.activeRecordings.set(id, recording);
    this.powerSessions.acquire(`recording:${id}`);
    try {
      await writeMeta(folderPath, meta);
    } catch (error) {
      // The renderer's rollback only fires once it has the id; a throw here
      // never returns one, so undo everything before rethrowing or the power
      // blocker and the active entry would leak until quit.
      this.activeRecordings.delete(id);
      this.powerSessions.release(`recording:${id}`);
      await new Promise((resolve) => audioStream.end(resolve));
      await fsp.rm(folderPath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    // Arm the worker to tee this stream's PCM for the finalize diarization
    // pass. Sent before any PCM flows (the renderer starts capture after this
    // resolves), and processed regardless of recognizer readiness.
    if (diarize && this.worker) {
      const paths = this.modelManager.diarizationModelPaths();
      this.worker.postMessage({
        type: "diarize-begin",
        streamId: id,
        pcmPath: path.join(folderPath, "diarize.f32"),
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
      return await this.finishRecording(recordingId, recording);
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
      while (this.worker && !this.workerReady && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    this.pendingPcm.delete(recordingId);

    // Flush the VAD → wait for the trailing segments before writing files.
    // When diarizing, the worker also reads the recording back and runs the
    // speaker pass before replying, which can take tens of seconds — give it a
    // generous window and tell the UI what's happening.
    if (this.worker && this.workerReady) {
      if (recording.diarize) this.broadcast({ type: "recording-diarizing", recordingId });
      const finalizeTimeout = recording.diarize ? 10 * 60_000 : 15_000;
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, finalizeTimeout);
        recording.resolveFinalized = () => {
          clearTimeout(timeout);
          resolve(undefined);
        };
        this.worker.postMessage({ type: "finalize", streamId: recordingId });
      });
    }
    this.activeRecordings.delete(recordingId);

    await new Promise((resolve) => recording.audioStream.end(resolve));

    const meta = recording.meta;
    meta.durationMs = stoppedAt - recording.startedAt;
    meta.sizeBytes = recording.sizeBytes;
    meta.segmentCount = recording.segments.length;
    if (meta.status !== "error") meta.status = "complete";
    meta.transcriptPath = path.join(meta.folderPath, "transcript.json");

    const segments = recording.segments.sort((a, b) => a.startMs - b.startMs);
    meta.speakerCount = assignSpeakers(segments, recording.speakerTurns);
    await writeTranscriptFiles(meta, segments);
    await writeMeta(meta.folderPath, meta);
    // Recording ended → finalize the live-transcript mirror (one last write
    // with the "ended" header) and stop tracking; the file stays in place.
    if (this.liveTranscript && !this.currentLiveSegments()) {
      await this.writeLiveTranscript().catch(() => {});
      this.liveTranscript = null;
      this.broadcast({ type: "live-transcript-stopped" });
    }
    return meta;
  }

  async cancelRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    this.pendingPcm.delete(recordingId);
    if (!recording) return;
    this.activeRecordings.delete(recordingId);
    this.powerSessions.release(`recording:${recordingId}`);
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: "drop", streamId: recordingId });
    }
    // Imported files have no live webm stream (audioStream === null).
    if (recording.audioStream) {
      await new Promise((resolve) => recording.audioStream.end(resolve));
    }
    await fsp.rm(recording.meta.folderPath, { recursive: true, force: true });
    if (this.liveTranscript && !this.currentLiveSegments()) {
      await this.writeLiveTranscript().catch(() => {});
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
      metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return metas;
  }

  async getRecording(recordingId) {
    const folderPath = path.join(this.recordingsDir, recordingId);
    const meta = await readMeta(folderPath);
    if (!meta) return null;
    let segments = [];
    try {
      const raw = await fsp.readFile(path.join(folderPath, "transcript.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.segments)) segments = parsed.segments;
    } catch {
      // transcript may not exist (recording failed mid-way)
    }
    return { meta, segments };
  }

  /**
   * Resolve a finished recording's audio file path, for the `lw-recording://`
   * playback protocol. Returns null (rather than risking traversal) unless the
   * id is a single, safe path segment that resolves inside the recordings dir
   * and the file exists.
   */
  recordingAudioFilePath(recordingId) {
    const id = String(recordingId || "");
    if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
    const audioPath = path.join(this.recordingsDir, id, "audio.webm");
    if (!audioPath.startsWith(this.recordingsDir + path.sep)) return null;
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

  async renameRecording(recordingId, title) {
    const raw = String(title ?? "").trim();
    const nextTitle = raw ? sanitizeTitle(raw) : "";
    if (nextTitle) {
      const active = this.activeRecordings.get(recordingId);
      if (active) {
        active.meta.title = nextTitle;
        await writeMeta(active.meta.folderPath, active.meta);
      } else {
        const folderPath = path.join(this.recordingsDir, recordingId);
        const meta = await readMeta(folderPath);
        if (meta) {
          meta.title = nextTitle;
          await writeMeta(folderPath, meta);
        }
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

  dispose() {
    this.stopWorker();
    for (const recording of this.activeRecordings.values()) {
      this.powerSessions.release(`recording:${recording.meta.id}`);
      try {
        recording.audioStream.end();
      } catch {
        // shutting down
      }
    }
    this.activeRecordings.clear();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

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

function speakerLabel(speaker) {
  return speaker == null ? null : `Speaker ${speaker + 1}`;
}

export async function writeTranscriptFiles(meta, segments) {
  const folder = meta.folderPath;
  await fsp.writeFile(
    path.join(folder, "transcript.json"),
    JSON.stringify(
      {
        recordingId: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        durationMs: meta.durationMs,
        language: meta.language,
        modelId: meta.modelId,
        sources: meta.sources,
        segments,
      },
      null,
      2,
    ),
  );

  const srt = segments
    .map((segment, index) => {
      const label = speakerLabel(segment.speaker);
      const text = label ? `${label}: ${segment.text}` : segment.text;
      return `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${text}\n`;
    })
    .join("\n");
  await fsp.writeFile(path.join(folder, "transcript.srt"), srt);

  const txt = segments
    .map((segment) => {
      const label = speakerLabel(segment.speaker);
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
    `- Model: ${meta.modelId ?? "—"} (local, on-device)`,
    `- Sources: ${meta.sources.join(", ")}`,
    ...(meta.speakerCount ? [`- Speakers: ${meta.speakerCount} (identified on-device)`] : []),
    "",
    "## Transcript",
    "",
    ...segments.map((segment) => {
      const time = formatClockTime(segment.startMs);
      const label = speakerLabel(segment.speaker);
      const prefix = label ? `**[${time}] ${label}:**` : `**[${time}]**`;
      return `${prefix} ${segment.text}`;
    }),
    "",
  ].join("\n");
  await fsp.writeFile(path.join(folder, "transcript.md"), md);
}
