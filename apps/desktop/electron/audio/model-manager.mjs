/**
 * Local speech-model store for the Recorder.
 *
 * Models live under `<userData>/stt-models/<modelId>/`. A model counts as
 * installed when every catalog file exists with a nonzero size and the
 * `.complete` marker is present (so a killed download never looks installed).
 *
 * Downloads stream to `<file>.part` and rename on completion. Progress is
 * pushed through the injected `emitEvent` callback (fan-out to windows is
 * the recorder service's job).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AUDIO_MODEL_CATALOG, VAD_MODEL, findAudioModel } from "./model-catalog.mjs";

const COMPLETE_MARKER = ".complete";

export class AudioModelManager {
  /**
   * @param {{ modelsDir: string, emitEvent: (event: object) => void }} options
   */
  constructor(options) {
    this.modelsDir = options.modelsDir;
    this.emitEvent = options.emitEvent;
    /** @type {Map<string, { controller: AbortController, downloadedBytes: number, totalBytes: number }>} */
    this.activeDownloads = new Map();
    /** @type {Map<string, string>} */
    this.lastErrors = new Map();
  }

  modelDir(modelId) {
    return path.join(this.modelsDir, modelId);
  }

  vadModelPath() {
    return path.join(this.modelsDir, "vad", VAD_MODEL.fileName);
  }

  isVadInstalled() {
    return isCompleteFile(this.vadModelPath());
  }

  isModelInstalled(modelId) {
    const entry = findAudioModel(modelId);
    if (!entry) return false;
    const dir = this.modelDir(modelId);
    if (!fs.existsSync(path.join(dir, COMPLETE_MARKER))) return false;
    return entry.files.every((file) => isCompleteFile(path.join(dir, file.name)));
  }

  /** Absolute paths of a model's files, or null when not installed. */
  installedModelPaths(modelId) {
    const entry = findAudioModel(modelId);
    if (!entry || !this.isModelInstalled(modelId)) return null;
    const dir = this.modelDir(modelId);
    const paths = {};
    for (const file of entry.files) {
      paths[file.name] = path.join(dir, file.name);
    }
    return paths;
  }

  installedSizeBytes(modelId) {
    const entry = findAudioModel(modelId);
    if (!entry) return null;
    const dir = this.modelDir(modelId);
    let total = 0;
    for (const file of entry.files) {
      const stat = statOrNull(path.join(dir, file.name));
      if (!stat) return null;
      total += stat.size;
    }
    return total;
  }

  /** @returns {import("@legalwork/types/audio").AudioModelState[]} */
  listModelStates() {
    return AUDIO_MODEL_CATALOG.map((entry) => {
      const active = this.activeDownloads.get(entry.id);
      const installed = this.isModelInstalled(entry.id);
      const error = this.lastErrors.get(entry.id) ?? null;
      return {
        ...entry,
        state: active ? "downloading" : installed ? "installed" : error ? "error" : "not-installed",
        downloadedBytes: active?.downloadedBytes ?? 0,
        totalBytes: active?.totalBytes ?? 0,
        installedSizeBytes: installed ? this.installedSizeBytes(entry.id) : null,
        error,
      };
    });
  }

  /**
   * Download a model (and the VAD model if missing). Resolves when done;
   * progress + terminal events are emitted along the way.
   */
  async download(modelId) {
    const entry = findAudioModel(modelId);
    if (!entry) throw new Error(`Unknown audio model: ${modelId}`);
    if (this.activeDownloads.has(modelId) || this.isModelInstalled(modelId)) return;

    const controller = new AbortController();
    const progress = { controller, downloadedBytes: 0, totalBytes: entry.approxSizeBytes };
    this.activeDownloads.set(modelId, progress);
    let lastProgressEmit = 0;
    this.lastErrors.delete(modelId);

    const dir = this.modelDir(modelId);
    await fsp.mkdir(dir, { recursive: true });

    try {
      // The VAD model rides along with the first model download.
      if (!this.isVadInstalled()) {
        await fsp.mkdir(path.dirname(this.vadModelPath()), { recursive: true });
        await downloadFile(VAD_MODEL.url, this.vadModelPath(), controller.signal, () => {});
      }

      // Resolve real total size first so progress is meaningful across files.
      const sizes = await Promise.all(
        entry.files.map((file) => fetchContentLength(file.url, controller.signal)),
      );
      const knownTotal = sizes.reduce((sum, size) => sum + (size ?? 0), 0);
      if (knownTotal > 0) progress.totalBytes = knownTotal;

      let downloadedSoFar = 0;
      for (const file of entry.files) {
        const target = path.join(dir, file.name);
        if (isCompleteFile(target)) {
          downloadedSoFar += statOrNull(target)?.size ?? 0;
          continue;
        }
        const baseBytes = downloadedSoFar;
        await downloadFile(file.url, target, controller.signal, (bytes) => {
          progress.downloadedBytes = baseBytes + bytes;
          // Chunks arrive hundreds of times per second — cap event fan-out.
          const now = Date.now();
          if (now - lastProgressEmit < 250) return;
          lastProgressEmit = now;
          this.emitEvent({
            type: "model-download-progress",
            modelId,
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
        });
        downloadedSoFar += statOrNull(target)?.size ?? 0;
      }

      await fsp.writeFile(path.join(dir, COMPLETE_MARKER), String(Date.now()));
      this.activeDownloads.delete(modelId);
      this.emitEvent({ type: "model-download-done", modelId });
    } catch (error) {
      this.activeDownloads.delete(modelId);
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.lastErrors.set(modelId, message);
      this.emitEvent({ type: "model-download-error", modelId, error: message });
      throw error;
    }
  }

  cancelDownload(modelId) {
    const active = this.activeDownloads.get(modelId);
    if (!active) return;
    active.controller.abort();
    this.activeDownloads.delete(modelId);
  }

  async delete(modelId) {
    this.cancelDownload(modelId);
    this.lastErrors.delete(modelId);
    await fsp.rm(this.modelDir(modelId), { recursive: true, force: true });
  }
}

function statOrNull(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function isCompleteFile(filePath) {
  const stat = statOrNull(filePath);
  return Boolean(stat && stat.isFile() && stat.size > 0);
}

async function fetchContentLength(url, signal) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal });
    if (!response.ok) return null;
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

async function downloadFile(url, target, signal, onProgress) {
  const partPath = `${target}.part`;
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  let written = 0;
  const progressCounter = new Transform({
    transform(chunk, _encoding, done) {
      written += chunk.length;
      onProgress(written);
      done(null, chunk);
    },
  });
  try {
    // pipeline handles backpressure, abort, and stream errors (disk full,
    // folder removed) without leaving dangling awaits or unhandled 'error's.
    await pipeline(Readable.fromWeb(response.body), progressCounter, fs.createWriteStream(partPath), {
      signal,
    });
    await fsp.rename(partPath, target);
  } catch (error) {
    await fsp.rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}
