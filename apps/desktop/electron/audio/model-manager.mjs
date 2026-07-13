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

import os from "node:os";

import { AUDIO_MODEL_CATALOG, DIARIZATION_MODELS, VAD_MODEL, findAudioModel } from "./model-catalog.mjs";

const DIARIZATION_ID = "__diarization__";

const COMPLETE_MARKER = ".complete";

/**
 * Hugging Face repo name per catalog model — used to find already-downloaded
 * copies in local HF caches so users don't re-download gigabytes.
 */
function hfRepoDirName(entry) {
  const match = entry.files[0]?.url.match(/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\//);
  if (!match) return null;
  return `models--${match[1]}--${match[2]}`;
}

/**
 * Model files inside HF snapshots / sherpa release folders often carry a
 * prefix (e.g. `tiny-encoder.int8.onnx`); map any candidate file in `dir`
 * to the catalog's canonical name.
 */
function locateModelFile(dir, canonicalName) {
  const direct = path.join(dir, canonicalName);
  if (isCompleteFile(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const suffixed = entries.find((name) => name.endsWith(`-${canonicalName}`) || name.endsWith(`_${canonicalName}`));
  if (suffixed && isCompleteFile(path.join(dir, suffixed))) return path.join(dir, suffixed);
  // tokens.txt may also appear as <model>-tokens.txt
  return null;
}

function candidateDirsForEntry(entry) {
  const home = os.homedir();
  const dirs = [];
  const repo = hfRepoDirName(entry);
  const cacheRoots = [
    path.join(home, ".cache", "huggingface", "hub"),
    path.join(home, "Library", "Caches", "huggingface", "hub"),
    process.env.HF_HOME ? path.join(process.env.HF_HOME, "hub") : null,
  ].filter(Boolean);
  if (repo) {
    for (const root of cacheRoots) {
      const snapshots = path.join(root, repo, "snapshots");
      try {
        for (const snap of fs.readdirSync(snapshots)) {
          dirs.push(path.join(snapshots, snap));
        }
      } catch {
        // cache root or repo not present
      }
    }
  }
  // Common manual-download location used by sherpa-onnx docs.
  const downloads = path.join(home, "Downloads");
  const repoShort = repo?.replace(/^models--[^-]+.*?--/, "") ?? null;
  if (repoShort) {
    const guess = path.join(downloads, repoShort);
    if (fs.existsSync(guess)) dirs.push(guess);
  }
  return dirs;
}

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

  /**
   * Find models already on this machine (Hugging Face caches, common
   * download folders) that match catalog entries and are not yet installed.
   * @returns {Array<{ modelId: string, sourcePath: string, sizeBytes: number }>}
   */
  scanExistingModels() {
    const found = [];
    for (const entry of AUDIO_MODEL_CATALOG) {
      if (this.isModelInstalled(entry.id) || this.activeDownloads.has(entry.id)) continue;
      for (const dir of candidateDirsForEntry(entry)) {
        const files = entry.files.map((file) => locateModelFile(dir, file.name));
        if (files.some((file) => !file)) continue;
        const sizeBytes = files.reduce((sum, file) => sum + (statOrNull(file)?.size ?? 0), 0);
        found.push({ modelId: entry.id, sourcePath: dir, sizeBytes });
        break;
      }
    }
    return found;
  }

  /**
   * Install a model from a local folder (an HF snapshot, an extracted
   * sherpa-onnx archive, or a MacWhisper-style models directory). Files may
   * carry prefixes; they are copied under their canonical names.
   * @returns {Promise<{ ok: boolean, modelId: string | null, error: string | null }>}
   */
  async importFromFolder(folderPath, expectedModelId = null) {
    const dir = String(folderPath ?? "").trim();
    if (!dir || !fs.existsSync(dir)) return { ok: false, modelId: null, error: "Folder not found." };

    const candidates = expectedModelId
      ? [findAudioModel(expectedModelId)].filter(Boolean)
      : AUDIO_MODEL_CATALOG;
    for (const entry of candidates) {
      const files = entry.files.map((file) => ({
        name: file.name,
        source: locateModelFile(dir, file.name),
      }));
      if (files.some((file) => !file.source)) continue;
      const targetDir = this.modelDir(entry.id);
      await fsp.mkdir(targetDir, { recursive: true });
      for (const file of files) {
        await fsp.copyFile(file.source, path.join(targetDir, file.name));
      }
      await fsp.writeFile(path.join(targetDir, COMPLETE_MARKER), String(Date.now()));
      // A local silero_vad.onnx rides along when present.
      if (!this.isVadInstalled()) {
        const vad = locateModelFile(dir, VAD_MODEL.fileName);
        if (vad) {
          await fsp.mkdir(path.dirname(this.vadModelPath()), { recursive: true });
          await fsp.copyFile(vad, this.vadModelPath());
        }
      }
      this.lastErrors.delete(entry.id);
      return { ok: true, modelId: entry.id, error: null };
    }
    return {
      ok: false,
      modelId: null,
      error:
        "No compatible model found in this folder. LegalWork needs sherpa-onnx ONNX exports (encoder/decoder int8 + tokens.txt) — ggml/CoreML models from other apps are a different format.",
    };
  }

  /** Fetch just the Silero VAD model (~2 MB) — used when a model was
   * imported from disk without one. */
  async ensureVadInstalled() {
    if (this.isVadInstalled()) return;
    await fsp.mkdir(path.dirname(this.vadModelPath()), { recursive: true });
    await downloadFile(VAD_MODEL.url, this.vadModelPath(), new AbortController().signal, () => {});
  }

  cancelDownload(modelId) {
    const active = this.activeDownloads.get(modelId);
    if (!active) return;
    active.controller.abort();
    this.activeDownloads.delete(modelId);
  }

  // ── speaker diarization models (shared, downloaded on demand) ────────────

  diarizationDir() {
    return path.join(this.modelsDir, "diarization");
  }

  diarizationModelPaths() {
    return {
      segmentation: path.join(this.diarizationDir(), DIARIZATION_MODELS.segmentation.fileName),
      embedding: path.join(this.diarizationDir(), DIARIZATION_MODELS.embedding.fileName),
    };
  }

  isDiarizationInstalled() {
    const paths = this.diarizationModelPaths();
    return isCompleteFile(paths.segmentation) && isCompleteFile(paths.embedding);
  }

  /** @returns {import("@legalwork/types/audio").AudioDiarizationState} */
  diarizationState() {
    const active = this.activeDownloads.get(DIARIZATION_ID);
    return {
      installed: this.isDiarizationInstalled(),
      downloading: Boolean(active),
      downloadedBytes: active?.downloadedBytes ?? 0,
      totalBytes: active?.totalBytes ?? DIARIZATION_MODELS.approxSizeBytes,
      error: this.lastErrors.get(DIARIZATION_ID) ?? null,
    };
  }

  async downloadDiarization() {
    if (this.activeDownloads.has(DIARIZATION_ID) || this.isDiarizationInstalled()) {
      return this.diarizationState();
    }
    const controller = new AbortController();
    const progress = { controller, downloadedBytes: 0, totalBytes: DIARIZATION_MODELS.approxSizeBytes };
    this.activeDownloads.set(DIARIZATION_ID, progress);
    this.lastErrors.delete(DIARIZATION_ID);
    const dir = this.diarizationDir();
    await fsp.mkdir(dir, { recursive: true });
    const files = [DIARIZATION_MODELS.segmentation, DIARIZATION_MODELS.embedding];
    let lastEmit = 0;
    try {
      const sizes = await Promise.all(files.map((file) => fetchContentLength(file.url, controller.signal)));
      const knownTotal = sizes.reduce((sum, size) => sum + (size ?? 0), 0);
      if (knownTotal > 0) progress.totalBytes = knownTotal;

      let downloadedSoFar = 0;
      for (const file of files) {
        const target = path.join(dir, file.fileName);
        if (isCompleteFile(target)) {
          downloadedSoFar += statOrNull(target)?.size ?? 0;
          continue;
        }
        const base = downloadedSoFar;
        await downloadFile(file.url, target, controller.signal, (bytes) => {
          progress.downloadedBytes = base + bytes;
          const now = Date.now();
          if (now - lastEmit < 250) return;
          lastEmit = now;
          this.emitEvent({
            type: "diarization-download-progress",
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
          });
        });
        downloadedSoFar += statOrNull(target)?.size ?? 0;
      }
      this.activeDownloads.delete(DIARIZATION_ID);
      this.emitEvent({ type: "diarization-download-done" });
      return this.diarizationState();
    } catch (error) {
      this.activeDownloads.delete(DIARIZATION_ID);
      if (controller.signal.aborted) return this.diarizationState();
      const message = error instanceof Error ? error.message : String(error);
      this.lastErrors.set(DIARIZATION_ID, message);
      this.emitEvent({ type: "diarization-download-error", error: message });
      return this.diarizationState();
    }
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
