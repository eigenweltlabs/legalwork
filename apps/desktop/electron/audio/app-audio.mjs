/**
 * Per-app / system audio capture on macOS via the native
 * `LegalWorkAudioTap` helper (Core Audio process taps, macOS 14.4+).
 *
 * The helper streams mono Float32 PCM on stdout after a one-line JSON header
 * with the sample rate. Main relays the PCM to the main window renderer
 * (`legalwork:audio:app-pcm`), which mixes it into the recording graph —
 * so app audio flows through the exact same file + transcription pipeline
 * as microphone and system audio.
 */

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { macOsAtLeast } from "./mac-version.mjs";

const APP_PCM_CHANNEL = "legalwork:audio:app-pcm";
const HELPER_NAME = "LegalWorkAudioTap";

const BYTES_PER_SAMPLE = 4; // Float32
/**
 * Renderer IPC frame size: ~50 ms of mono Float32 at 48 kHz. Pipe chunks
 * arrive at arbitrary sizes and boundaries (they even split mid-float), so
 * we re-frame before webContents.send: coalesce dribbles, cap bursts, and
 * only ever forward whole samples.
 */
const FRAME_BYTES = 2400 * BYTES_PER_SAMPLE;

export function resolveHelperPath(app) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "helpers", HELPER_NAME);
  }
  const candidates = [
    path.resolve(__dirname, "../../resources/helpers", HELPER_NAME),
    path.resolve(__dirname, "../../native/audiotap/.build/release", HELPER_NAME),
    path.resolve(__dirname, "../../native/audiotap/.build/arm64-apple-macosx/release", HELPER_NAME),
    path.resolve(__dirname, "../../native/audiotap/.build/x86_64-apple-macosx/release", HELPER_NAME),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export class AppAudioTap {
  /** @param {{ app: import('electron').App, getTargetWebContents: () => import('electron').WebContents | null }} options */
  constructor(options) {
    this.app = options.app;
    this.getTargetWebContents = options.getTargetWebContents;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null;
    this.sampleRate = 0;
    /** Unforwarded stdout bytes: sub-frame dribbles plus any split sample. */
    this.pcmBacklog = Buffer.alloc(0);
  }

  isAvailable() {
    // Core Audio process taps need macOS 14.4+; the helper must be built
    // (dev: `pnpm run build:audiotap`; packaged: shipped in resources/helpers).
    return (
      process.platform === "darwin" &&
      macOsAtLeast(14, 4) &&
      fs.existsSync(resolveHelperPath(this.app))
    );
  }

  /** @returns {Promise<import("@legalwork/types/audio").AudioTapApp[]>} */
  async listApps() {
    if (!this.isAvailable()) return [];
    const helper = resolveHelperPath(this.app);
    const stdout = await new Promise((resolve) => {
      // 15s: the helper renders a 32px PNG icon per app (~40 apps).
      execFile(helper, ["list"], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
        resolve(error ? "[]" : String(out));
      });
    });
    let apps = [];
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) apps = parsed;
    } catch {
      return [];
    }
    // Icons come pre-rendered from the helper as data URLs. Never call
    // app.getFileIcon here: it SIGTRAPs the main process on
    // macOS 15.6 / Electron 35 (deterministic, even for a single call).
    return apps.map((item) => ({
      pid: Number(item.pid) || 0,
      name: String(item.name ?? ""),
      bundleId: String(item.bundleId ?? ""),
      icon: typeof item.icon === "string" && item.icon.startsWith("data:image/") ? item.icon : "",
    }));
  }

  /**
   * Start tapping the given pids (empty = whole system mixdown).
   * @returns {Promise<{ ok: boolean, sampleRate: number, error: string | null }>}
   */
  start(pids) {
    this.stop();
    if (!this.isAvailable()) {
      return Promise.resolve({ ok: false, sampleRate: 0, error: "App audio capture is not available on this system." });
    }
    const helper = resolveHelperPath(this.app);
    const args = ["tap"];
    if (Array.isArray(pids) && pids.length > 0) {
      args.push("--pids", pids.map((pid) => Math.floor(pid)).join(","));
    }
    const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    return new Promise((resolve) => {
      let headerParsed = false;
      let headerBuffer = Buffer.alloc(0);
      let stderrText = "";
      const timeout = setTimeout(() => {
        if (!headerParsed) {
          this.stop();
          resolve({ ok: false, sampleRate: 0, error: stderrText.trim() || "App audio helper did not start." });
        }
      }, 8000);

      child.stderr?.on("data", (chunk) => {
        stderrText += String(chunk);
      });
      child.stdout?.on("data", (chunk) => {
        if (!headerParsed) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          const newline = headerBuffer.indexOf(0x0a);
          if (newline === -1) return;
          try {
            const header = JSON.parse(headerBuffer.subarray(0, newline).toString("utf8"));
            this.sampleRate = Number(header.sampleRate) || 48000;
          } catch {
            this.sampleRate = 48000;
          }
          headerParsed = true;
          clearTimeout(timeout);
          resolve({ ok: true, sampleRate: this.sampleRate, error: null });
          const rest = headerBuffer.subarray(newline + 1);
          if (rest.byteLength > 0) this.forwardPcm(rest);
          return;
        }
        this.forwardPcm(chunk);
      });
      child.on("exit", () => {
        clearTimeout(timeout);
        if (this.child === child) {
          this.child = null;
          this.flushPcm();
        }
        if (!headerParsed) {
          resolve({ ok: false, sampleRate: 0, error: stderrText.trim() || "App audio helper exited." });
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        if (!headerParsed) resolve({ ok: false, sampleRate: 0, error: String(error?.message ?? error) });
      });
    });
  }

  forwardPcm(chunk) {
    this.pcmBacklog = this.pcmBacklog.byteLength === 0 ? chunk : Buffer.concat([this.pcmBacklog, chunk]);
    // Fixed-size frames keep the renderer's structured-clone traffic bounded
    // and sample-aligned; the remainder waits for the next stdout chunk.
    while (this.pcmBacklog.byteLength >= FRAME_BYTES) {
      this.sendFrame(this.pcmBacklog.subarray(0, FRAME_BYTES));
      this.pcmBacklog = this.pcmBacklog.subarray(FRAME_BYTES);
    }
  }

  flushPcm() {
    const whole = this.pcmBacklog.byteLength - (this.pcmBacklog.byteLength % BYTES_PER_SAMPLE);
    if (whole > 0) this.sendFrame(this.pcmBacklog.subarray(0, whole));
    this.pcmBacklog = Buffer.alloc(0);
  }

  sendFrame(frame) {
    const target = this.getTargetWebContents();
    if (!target || target.isDestroyed()) return;
    // Copy into a standalone ArrayBuffer (Buffer views share pooled memory).
    const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    target.send(APP_PCM_CHANNEL, { sampleRate: this.sampleRate, buffer });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.pcmBacklog = Buffer.alloc(0);
    if (!child) return;
    try {
      child.stdin?.end();
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}
