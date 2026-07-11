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
   * }} options
   */
  constructor(options) {
    this.userDataDir = options.userDataDir;
    this.modelsDir = path.join(options.userDataDir, "stt-models");
    this.recordingsDir = path.join(options.userDataDir, "recordings");
    this.appAudioAvailable = options.appAudioAvailable ?? (() => false);
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
     *   audioStream: import('node:fs').WriteStream,
     *   resolveFinalized: (() => void) | null,
     * }>}
     */
    this.activeRecordings = new Map();
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

  bootstrap() {
    return {
      models: this.modelManager.listModelStates(),
      capabilities: this.capabilities(),
      engine: this.engineStatus(),
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
        if (recording && segment.final) recording.segments.push(segment);
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
    };

    const audioStream = fs.createWriteStream(audioPath);
    const recording = {
      meta,
      segments: [],
      sizeBytes: 0,
      startedAt: Date.now(),
      audioStream,
      resolveFinalized: null,
    };
    // Without a listener a disk-full/unlink error would crash the main
    // process as an uncaught 'error' event mid-call.
    audioStream.on("error", (error) => {
      meta.status = "error";
      meta.error = error instanceof Error ? error.message : String(error);
      this.broadcast({ type: "recording-error", recordingId: id, error: meta.error });
    });
    this.activeRecordings.set(id, recording);
    await writeMeta(folderPath, meta);
    this.broadcast({ type: "recording-started", recordingId: id });
    return meta;
  }

  async stopRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    if (!recording) throw new Error(`Unknown recording: ${recordingId}`);
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
    if (this.worker && this.workerReady) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 15_000);
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
    await writeTranscriptFiles(meta, segments);
    await writeMeta(meta.folderPath, meta);
    return meta;
  }

  async cancelRecording(recordingId) {
    const recording = this.activeRecordings.get(recordingId);
    this.pendingPcm.delete(recordingId);
    if (!recording) return;
    this.activeRecordings.delete(recordingId);
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: "drop", streamId: recordingId });
    }
    await new Promise((resolve) => recording.audioStream.end(resolve));
    await fsp.rm(recording.meta.folderPath, { recursive: true, force: true });
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
      if (meta) metas.push(meta);
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

  async deleteRecording(recordingId) {
    await this.cancelRecording(recordingId).catch(() => {});
    await fsp.rm(path.join(this.recordingsDir, recordingId), { recursive: true, force: true });
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
    .map(
      (segment, index) =>
        `${index + 1}\n${formatSrtTime(segment.startMs)} --> ${formatSrtTime(segment.endMs)}\n${segment.text}\n`,
    )
    .join("\n");
  await fsp.writeFile(path.join(folder, "transcript.srt"), srt);

  const txt = segments.map((segment) => segment.text).join("\n");
  await fsp.writeFile(path.join(folder, "transcript.txt"), txt);

  const md = [
    `# ${meta.title}`,
    "",
    `- Recorded: ${new Date(meta.createdAt).toISOString()}`,
    `- Duration: ${formatClockTime(meta.durationMs)}`,
    `- Language: ${meta.language}`,
    `- Model: ${meta.modelId ?? "—"} (local, on-device)`,
    `- Sources: ${meta.sources.join(", ")}`,
    "",
    "## Transcript",
    "",
    ...segments.map((segment) => `**[${formatClockTime(segment.startMs)}]** ${segment.text}`),
    "",
  ].join("\n");
  await fsp.writeFile(path.join(folder, "transcript.md"), md);
}
