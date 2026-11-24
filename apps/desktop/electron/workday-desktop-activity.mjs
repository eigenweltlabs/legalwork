import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requestRecorderServer } from "./audio/recorder-server-request.mjs";

const run = promisify(execFile);
const idleLimit = 60;

// Consent belongs to the active private profile. Re-resolve it before and
// after a native read so switching accounts cannot transfer an observation.
export async function desktopActivityOwner(info, request = requestRecorderServer) {
  if (!info?.running || !info.hostToken || !info.baseUrl) return;
  const url = new URL(info.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  const state = await request(info, "/private-timesheet/activity", undefined, AbortSignal.timeout(2_500));
  if (state.enabled === true && state.desktopActivity === true && typeof state.profileId === "string" && state.profileId) {
    return JSON.stringify([state.profileId, state.scope, state.principal, state.user]);
  }
}

export async function readMacWorkdayForeground(helper, includeDocument) {
  const args = ["--workday-foreground"];
  if (includeDocument) args.push("--document");
  const { stdout } = await run(helper, args, { timeout: 1_750, maxBuffer: 2048, encoding: "utf8" });
  return JSON.parse(stdout);
}

export async function macWorkdayAccessibility(helper, prompt = false) {
  const args = ["--workday-accessibility"];
  if (prompt) args.push("--request");
  const { stdout } = await run(helper, args, { timeout: 1_750, maxBuffer: 128, encoding: "utf8" });
  const granted = JSON.parse(stdout);
  if (typeof granted !== "boolean") throw Error("Desktop accessibility status unavailable");
  return granted;
}

function safeLabel(raw) {
  if (typeof raw !== "string" || raw.length > 240 || /[\p{Cc}\p{Cf}\\/:]/u.test(raw)) return;
  const value = raw.trim();
  if (value && !value.startsWith(".")) return value;
}

export function createWorkdayDesktopCollector({ platform, available, trusted, helperTrusted, requestPermission, owner,
  power, readForeground, processId = process.pid, now = Date.now }) {
  const os = platform === "darwin" || platform === "win32" ? platform : "unsupported";
  let pending;
  function hostStatus() {
    try {
      if (os !== "unsupported" && available()) {
        return { platform: os, permission: os === "win32" || trusted() ? "granted" : "needed" };
      }
    } catch {}
    return { platform: os, permission: "unavailable" };
  }
  async function status() {
    const auth = hostStatus();
    if (os !== "darwin" || auth.permission !== "granted") return auth;
    try {
      // No native child is launched until this profile enables the source.
      if (!await owner() || await helperTrusted()) return auth;
      return { ...auth, permission: "needed" };
    } catch { return { ...auth, permission: "unavailable" }; }
  }
  function activity() {
    const state = power.getSystemIdleState(idleLimit);
    const seconds = power.getSystemIdleTime();
    const idleSeconds = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
    if (state === "locked") return { state, idleSeconds };
    if (!Number.isFinite(seconds) || seconds < 0 || !["active", "idle"].includes(state)) return { state: "unavailable", idleSeconds };
    return { state: state === "idle" || seconds >= idleLimit ? "idle" : "active", idleSeconds };
  }
  async function sample() {
    const auth = hostStatus();
    const empty = () => ({ ...auth, state: "unavailable", observedAt: now(), idleSeconds: 0 });
    try {
      if (auth.permission === "unavailable") return empty();
      const profile = await owner();
      if (!profile) return empty();
      const before = activity();
      if (before.state !== "active") return { ...auth, ...before, observedAt: now() };
      const withDocument = os === "darwin" && auth.permission === "granted";
      const value = await readForeground(withDocument);
      const observedAt = now();
      if (await owner() !== profile) return empty();
      const current = activity();
      if (current.state !== "active") return { ...auth, ...current, observedAt };
      if (value?.locked === true) return { ...auth, state: "locked", observedAt, idleSeconds: current.idleSeconds };
      const application = safeLabel(value?.application);
      if (!application || !Number.isSafeInteger(value.pid) || value.pid <= 0) return empty();
      const permission = withDocument && (!trusted() || value.accessibility !== true) ? "needed" : auth.permission;
      const documentName = os === "darwin" && permission === "granted" ? safeLabel(value.documentName) : undefined;
      return { platform: os, permission, ...current, observedAt, application,
        ...(documentName ? { documentName } : {}), ...(value.pid === processId ? { isLegalWork: true } : {}) };
    } catch { return empty(); }
  }
  return { status, async requestPermission() {
    if (os === "darwin" && hostStatus().permission !== "unavailable" && await owner()
        && (await status()).permission === "needed") await requestPermission();
    return status();
  }, sample() {
    pending ??= sample().finally(() => { pending = undefined; });
    return pending;
  } };
}
