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
  async listApps(getFileIcon) {
    if (!this.isAvailable()) return [];
    const helper = resolveHelperPath(this.app);
    const stdout = await new Promise((resolve) => {
      execFile(helper, ["list"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, out) => {
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
    return Promise.all(
      apps.map(async (item) => {
        let icon = "";
        try {
          if (item.path) {
            const image = await getFileIcon(item.path);
            icon = image?.toDataURL?.() ?? "";
          }
        } catch {
          // icon is cosmetic
        }
        return {
          pid: Number(item.pid) || 0,
          name: String(item.name ?? ""),
          bundleId: String(item.bundleId ?? ""),
          icon,
        };
      }),
    );
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
        if (this.child === child) this.child = null;
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
    const target = this.getTargetWebContents();
    if (!target || target.isDestroyed()) return;
    // Copy into a standalone ArrayBuffer (Buffer views share pooled memory).
    const buffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    target.send(APP_PCM_CHANNEL, { sampleRate: this.sampleRate, buffer });
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}
