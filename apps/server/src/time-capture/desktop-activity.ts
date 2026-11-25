import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopActivitySample } from "@legalwork/types/time-capture";
import { addDays, zonedInstant } from "../calendar/dates.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import type { ServerConfig } from "../types.js";
import { claimsFor, digest, humanInterval, type WorkdayEvidence } from "./private-workday.js";
import { activeCaptureProfile } from "./profile.js";
import { readCaptureSettings } from "./routes.js";

type Profile = Awaited<ReturnType<typeof activeCaptureProfile>>;
const runSchema = z.object({
  start: z.number().int(), end: z.number().int(), platform: z.enum(["darwin", "win32"]), application: z.string().min(1).max(240),
  documentName: z.string().min(1).max(240).optional(),
});
type Run = z.infer<typeof runSchema>;
type Context = Omit<Run, "start" | "end">;
const cursors = new WeakMap<ServerConfig, { path: string; at: number; context?: Context }>();
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const file = (path: string, day: string) => join(path + ".desktop-activity", day + ".json");

export function resetDesktopSampling(config: ServerConfig) { cursors.delete(config); }
export function syncDesktopProfile(config: ServerConfig, path: string) {
  const last = cursors.get(config);
  if (last && last.path !== path) resetDesktopSampling(config);
}

async function runs(path: string, day: string) {
  try { return z.array(runSchema).parse(JSON.parse(await readFile(file(path, day), "utf8"))); }
  catch (error) { if (missingFile(error)) return []; throw error; }
}

// Native transports send application names and explicit document basenames. Reject paths, URLs and control characters at the storage boundary.
function safeName(value?: string) {
  if (!value || /[/\\\u0000-\u001f\u007f]/u.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return;
  return value;
}
function sampleContext(s: DesktopActivitySample): Context | undefined {
  const application = safeName(s.application);
  if (s.state !== "active" || s.platform === "unsupported" || s.idleSeconds >= 60 || !application || s.isLegalWork) return;
  const documentName = s.permission === "granted" ? safeName(s.documentName) : undefined;
  return { platform: s.platform, application, ...(documentName && { documentName }) };
}
function matches(a: Context, b: Context) {
  return a.platform === b.platform && a.application === b.application && a.documentName === b.documentName;
}

export async function recordDesktopSample(config: ServerConfig, owner: Profile, sample: DesktopActivitySample, now = Date.now()) {
  if (sample.observedAt < now - 90_000 || sample.observedAt > now + 5_000)
    throw new ApiError(400, "desktop_sample_time", "This desktop activity sample is outside the collection window.");
  await withFileWriteLock(owner.path, async () => {
    if ((await activeCaptureProfile(config)).path !== owner.path) throw new ApiError(409, "private_workday_changed", "The active account changed.");
    const settings = await readCaptureSettings(owner.path);
    if (settings.enabled === false || !settings.desktopActivity) {
      resetDesktopSampling(config);
      throw new ApiError(409, "desktop_capture_disabled", "Enable desktop activity in Time tracking settings.");
    }
    const last = cursors.get(config);
    if (last?.path === owner.path && sample.observedAt <= last.at) return;
    const context = sampleContext(sample);
    // One device cursor suppresses delayed or duplicated renderer reports. Nothing before the first observed sample is reconstructed.
    if (last?.path === owner.path && last.context && context && matches(last.context, context) && sample.observedAt - last.at <= 45_000) {
      let start = last.at;
      while (start < sample.observedAt) {
        const day = utcDay(start), end = Math.min(sample.observedAt, Date.parse(addDays(day, 1) + "T00:00:00Z"));
        const records = await runs(owner.path, day), previous = records.at(-1);
        if (previous && matches(previous, context) && previous.start <= start && previous.end >= start) previous.end = Math.max(previous.end, end);
        else records.push({ ...context, start, end });
        await atomicPrivateFile(file(owner.path, day), JSON.stringify(records));
        start = end;
      }
    }
    cursors.set(config, { path: owner.path, at: sample.observedAt, context });
  });
}

export async function readDesktopEvidence(owner: Profile, date: string, zone: string): Promise<WorkdayEvidence[]> {
  const settings = await readCaptureSettings(owner.path);
  if (settings.enabled === false || !settings.desktopActivity) return [];
  const from = Date.parse(zonedInstant(date, zone)), to = Date.parse(zonedInstant(addDays(date, 1), zone));
  const days = new Set([utcDay(from), utcDay(to - 1)]);
  const records = (await Promise.all([...days].map(day => runs(owner.path, day)))).flat();
  return records.flatMap(run => {
    const start = Math.max(run.start, from), end = Math.min(run.end, to);
    if (end <= start) return [];
    const { platform, application, documentName } = run;
    const desktopContext = { platform, application, ...(documentName && { documentName }) };
    const eventKey = digest([owner.profileId, "desktop", date, run.start, desktopContext]);
    const body = { date, projectId: null, source: "desktop" as const, observation: "foreground" as const,
      desktopContext, narrative: [application, documentName].filter(Boolean).join(" · "), activity: "", startAt: new Date(start).toISOString(),
      endAt: new Date(end).toISOString(), workedMinutes: null, dismissed: false };
    return [{ eventKey, proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]) } }];
  });
}

/** Only one app can occupy the device foreground. Independently observed meetings, timers and agent jobs can still overlap. */
export function resolveDesktopForeground(rows: WorkdayEvidence[]): WorkdayEvidence[] {
  const desktop = rows.filter(row => row.proposal.source === "desktop").flatMap(row => {
    const span = humanInterval(row.proposal);
    return span ? [span] : [];
  }).sort((a, b) => a.from - b.from);
  if (!desktop.length) return rows;
  return rows.flatMap(row => {
    if (row.proposal.source !== "workspace" || row.proposal.observation !== "foreground") return [row];
    const span = humanInterval(row.proposal);
    if (!span) return [row];
    let cursor = span.from;
    const remaining = [];
    for (const other of desktop) {
      if (other.to <= cursor || other.from >= span.to) continue;
      if (other.from > cursor) remaining.push({ from: cursor, to: other.from });
      cursor = Math.max(cursor, other.to);
      if (cursor >= span.to) break;
    }
    if (cursor === span.from) return [row];
    if (cursor < span.to) remaining.push({ from: cursor, to: span.to });
    return remaining.map(({ from, to }) => ({ ...row, eventKey: digest([row.eventKey, from]),
      proposal: { ...row.proposal, startAt: new Date(from).toISOString(), endAt: new Date(to).toISOString() },
      claims: claimsFor(row).map(claim => ({ ...claim, from, to })) }));
  });
}
