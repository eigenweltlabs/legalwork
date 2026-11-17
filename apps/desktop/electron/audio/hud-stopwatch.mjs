import { randomUUID } from "node:crypto";
import { requestRecorderServer } from "./recorder-server-request.mjs";

/** The system-wide overlay always talks to the private API on the local device. */
export async function requestHudStopwatch(info, action, profileId) {
  if (!info?.running || !info.baseUrl || !info.hostToken) throw Error("Local server unavailable");
  const url = new URL(info.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("The private stopwatch requires a local server");
  const query = action ? "?" + new URLSearchParams({ profileId }) : "";
  const result = await requestRecorderServer(info, "/private-timesheet/stopwatch" + query, action);
  if (!result || typeof result.profileId !== "string" || !result.profileId ||
      (result.active !== null && (!result.active?.id || !Number.isFinite(Date.parse(result.active.startedAt)))))
    throw Error("Invalid stopwatch response");
  return result;
}

export function stopwatchProjectFromUrl(windowUrl, projects) {
  try {
    const url = new URL(windowUrl);
    const route = url.hash.startsWith("#/") ? url.hash.slice(1) : url.pathname;
    const match = /^\/workspace\/([^/?#]+)/.exec(route);
    const id = match && decodeURIComponent(match[1]);
    return projects.some(project => project.id === id) ? id : null;
  } catch { return null; }
}

export class HudStopwatch {
  constructor(request, publish) {
    this.request = request;
    this.publish = publish;
    this.state = null;
    this.retry = null;
    this.reading = null;
    this.mutation = false;
    this.failed = false;
    this.savedUntil = 0;
    this.version = 0;
  }

  update(state) {
    if (state?.profileId !== this.state?.profileId || state?.active?.id !== this.state?.active?.id || state?.active?.projectId !== this.state?.active?.projectId) {
      this.version++;
      this.failed = false;
      this.savedUntil = 0;
    }
    this.state = state;
    if (state && this.retry && (state.profileId !== this.retry.profileId ||
        (this.retry.action.type === "assign"
          ? state.active?.id === this.retry.action.id && state.active?.projectId === this.retry.action.projectId
          : state.active?.id === this.retry.action.id || state.lastStopped?.id === this.retry.action.id)))
      this.retry = null;
  }

  notify() {
    // The renderer gets times and an opaque version, never account IDs or credentials.
    this.publish({
      version: this.version,
      startedAt: this.state?.active?.startedAt ?? null,
      projectId: this.state?.active?.projectId ?? null,
      suggestedProjectId: this.state?.suggestedProjectId ?? null,
      projects: this.state?.projects ?? [],
      unavailable: !this.state,
      busy: this.mutation,
      failed: this.failed,
      savedUntil: this.savedUntil,
    });
  }

  refresh() {
    if (this.mutation) return;
    if (!this.reading) {
      this.reading = this.request().then(state => this.update(state), () => this.update(null)).finally(() => {
        this.reading = null;
        this.notify();
      });
    }
    return this.reading;
  }

  async act(type, version, projectId) {
    if (this.reading) await this.reading;
    if (this.mutation || version !== this.version) return;
    if (type === "retry" || type === "prepare" || !this.state) return this.refresh();
    if (!["start", "stop", "assign"].includes(type)) return;
    if (projectId !== undefined && !this.state.projects?.some(project => project.id === projectId)) return;
    if ((type !== "start") !== Boolean(this.state.active)) return;
    const profileId = this.state.profileId;
    const action = type === "stop" ? { type, id: this.state.active.id }
      : type === "assign" ? { type, id: this.state.active.id, projectId }
      : this.retry?.profileId === profileId && this.retry.action.type === type && this.retry.action.projectId === projectId
        ? this.retry.action : { type, id: randomUUID(), ...(projectId ? { projectId } : {}) };
    this.retry = { profileId, action };
    this.mutation = true;
    this.savedUntil = 0;
    this.failed = false;
    this.notify();
    try {
      this.update(await this.request(action, profileId));
      this.retry = null;
    } catch {
      // Read back before offering a retry. The first write may already have committed.
      try { this.update(await this.request()); } catch { this.update(null); }
      this.failed = this.state?.profileId === profileId &&
        (type === "start" ? this.state.active?.id !== action.id
          : type === "assign" ? this.state.active?.projectId !== action.projectId
          : this.state.lastStopped?.id !== action.id);
    } finally {
      if (type === "stop" && this.state?.profileId === profileId && this.state.lastStopped?.id === action.id)
        this.savedUntil = Date.now() + 5000;
      this.mutation = false;
      this.notify();
    }
  }
}
