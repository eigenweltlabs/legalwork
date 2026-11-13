import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveKeyMonitorPath } from "./system-key-monitor.mjs";
import { WindowsMeetingProbe } from "./windows-meeting-probe.mjs";
import { macOsAtLeast } from "./mac-version.mjs";

const NATIVE_APPS = [
  ["us.zoom.xos", "Zoom"], ["com.microsoft.teams2", "Microsoft Teams"],
  ["com.microsoft.teams", "Microsoft Teams"], ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.cisco.webexmeetingsapp", "Webex"], ["com.cisco.webex", "Webex"],
];
const BROWSERS = ["com.google.Chrome", "com.microsoft.edgemac", "company.thebrowser.Browser", "company.thebrowser.dia", "com.apple.Safari", "org.mozilla.firefox", "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium"];

/** Match metadata only; never open a microphone or read meeting conversation. */
export function meetingCandidate(processes) {
  let browserCall = null;
  for (const process of processes) {
    if (!process || typeof process.bundleId !== "string") continue;
    const native = NATIVE_APPS.find(([id]) => process.bundleId === id || process.bundleId.startsWith(id + "."));
    if (native && process.inputActive) return { id: native[0], app: native[1], title: native[1] };
    if (!BROWSERS.some(id => process.bundleId === id || process.bundleId.startsWith(id + "."))) continue;
    for (const document of process.documents ?? []) {
      if (!document || typeof document !== "object") continue;
      let url;
      try { url = new URL(document.url); } catch { /* Some apps expose titles only. */ }
      const host = url?.hostname.toLowerCase();
      let provider = null;
      if (host === "meet.google.com" && /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/|$)/.test(url.pathname)) provider = "Google Meet";
      else if (host && (host === "teams.microsoft.com" || host === "teams.live.com") && /\/meet(?:ing|up-join)?\//.test(url.pathname)) provider = "Microsoft Teams";
      else if (host && (host === "zoom.us" || host.endsWith(".zoom.us")) && /\/(?:wc|j)\//.test(url.pathname)) provider = "Zoom";
      else if ((!host || host === "meet.google.com") && /^(?:Google Meet(?:$| [–-] )|Meet [–-] [a-z]{3}-[a-z]{4}-[a-z]{3}\b)/i.test(document.title ?? "")) provider = "Google Meet";
      // The prompt is an offer to record, not an automatic recording. A
      // meeting page is enough, including joining muted or listening silently.
      if (provider) return { id: `${process.bundleId}:${url ? url.origin + url.pathname : provider}`, app: provider, title: provider };
    }
    // Browser metadata may be unavailable without Accessibility permission.
    // Sustained browser microphone activity can still offer a recording.
    if (process.inputActive) browserCall ??= { id: process.bundleId, app: "Browser call", title: "Browser call" };
  }
  return browserCall;
}

export class MeetingMonitor {
  /** @param {{app: Pick<import('electron').App, 'getPath'>, onChange: (status: import('@legalwork/types/audio').AudioMeetingStatus) => void, onStart: (title?: string) => void, probe?: () => Promise<{supported: boolean, processes: object[]}>, platform?: string, now?: () => number}} options */
  constructor({ app, onChange, onStart, probe, platform = process.platform, now = Date.now }) {
    this.settingsPath = path.join(app.getPath("userData"), "meeting-detection.json");
    this.onChange = onChange;
    this.onStart = onStart;
    this.now = now;
    this.windowsProbe = platform === "win32" && !probe ? new WindowsMeetingProbe() : null;
    this.probe = probe ?? (this.windowsProbe ? () => this.windowsProbe.poll() : () => new Promise(resolve => {
      if (platform !== "darwin") { resolve({ supported: false, processes: [] }); return; }
      execFile(resolveKeyMonitorPath(app), ["--meeting-activity"], { timeout: 2500, maxBuffer: 128 * 1024 }, (error, stdout) => {
        if (error) { resolve({ supported: false, processes: [] }); return; }
        try {
          const value = JSON.parse(stdout);
          resolve({ supported: value.supported === true, processes: Array.isArray(value.processes) ? value.processes : [] });
        } catch { resolve({ supported: false, processes: [] }); }
      });
    }));
    // Capability must be known even when the saved opt-out prevents polling.
    // Checking the OS does not inspect meeting activity or launch a helper.
    const detectionSupported = platform === "win32" || (platform === "darwin" && macOsAtLeast(14, 2));
    /** @type {import('@legalwork/types/audio').AudioMeetingStatus} */
    this.value = { detectionEnabled: true, detectionSupported, detected: null, state: "idle", recordingId: null, startedAt: null, error: null };
    this.timer = null;
    this.polling = false;
    this.generation = 0;
    this.signalId = null;
    this.signalSince = 0;
    this.lastSignalAt = 0;
    this.dismissedId = null;
    this.writeQueue = Promise.resolve();
  }

  status() { return { ...this.value }; }
  publish() { this.onChange(this.status()); }

  async initialize() {
    try {
      const settings = JSON.parse(await readFile(this.settingsPath, "utf8"));
      this.value.detectionEnabled = settings.detectionEnabled !== false;
    } catch { /* First launch uses detection with a manual Record action. */ }
    await this.poll();
    this.timer = setInterval(() => { void this.poll(); }, 3000);
    this.timer.unref?.();
  }

  async setDetection(enabled) {
    this.generation += 1;
    this.value.detectionEnabled = enabled;
    if (!enabled) this.windowsProbe?.dispose();
    this.clearSignal();
    this.publish();
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.settingsPath), { recursive: true });
      await writeFile(this.settingsPath, JSON.stringify({ detectionEnabled: enabled }));
    });
    await this.writeQueue;
    return this.status();
  }

  clearSignal() {
    this.value.detected = null;
    this.signalId = null;
    this.signalSince = 0;
    this.lastSignalAt = 0;
    this.dismissedId = null;
  }

  async poll() {
    if (this.polling || !this.value.detectionEnabled) return;
    this.polling = true;
    const generation = this.generation;
    try {
      const result = await this.probe();
      if (generation !== this.generation) return;
      const before = JSON.stringify(this.value);
      this.value.detectionSupported = result.supported;
      const candidate = result.supported ? meetingCandidate(result.processes) : null;
      const now = this.now();
      if (candidate) {
        this.lastSignalAt = now;
        if (this.signalId !== candidate.id) { this.signalId = candidate.id; this.signalSince = now; this.value.detected = null; }
        if (now - this.signalSince >= 3000 && candidate.id !== this.dismissedId) this.value.detected = candidate;
      } else if (now - this.lastSignalAt >= 15000) {
        this.clearSignal();
      }
      if (before !== JSON.stringify(this.value)) this.publish();
    } finally { this.polling = false; }
  }

  dismiss() {
    this.dismissedId = this.signalId;
    this.value.detected = null;
    this.publish();
  }

  requestStart() {
    if (this.value.state !== "idle" && this.value.state !== "error") return;
    const title = this.value.detected?.title;
    this.setRecording({ state: "starting", error: null });
    this.onStart(title);
  }

  /** @param {Partial<import('@legalwork/types/audio').AudioMeetingStatus>} update */
  setRecording(update) {
    Object.assign(this.value, update);
    if (update.state === "idle") { this.value.recordingId = null; this.value.startedAt = null; }
    if (update.state === "recording") this.dismissedId = this.signalId;
    if (this.dismissedId === this.signalId && this.signalId) this.value.detected = null;
    this.publish();
    return this.status();
  }

  reset() { this.generation += 1; this.windowsProbe?.dispose(); this.clearSignal(); this.publish(); }
  dispose() { this.generation += 1; clearInterval(this.timer); this.windowsProbe?.dispose(); }
}
