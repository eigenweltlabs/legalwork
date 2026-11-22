import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { addDays, zonedInstant } from "../calendar/dates.js";
import { captureProfile, readCaptureSettings } from "./routes.js";
import { backOfficeAccess } from "../back-office/access.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";
import { workdayWorkspaces } from "./workday-context.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { taskStore } from "../task-store.js";
import { ApiError } from "../errors.js";

type Profile = { profileId: string; path: string; captureUser: string };
const observation = z.object({
  projectId: z.string().min(1).max(200),
  kind: z.enum(["foreground", "passive", "agent"]),
  stream: z.string().min(1).max(200),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});
export const observationBatch = z.object({
  profileId: z.string().length(64),
  observations: z.array(observation).max(200),
});
type Observation = z.infer<typeof observation>;
type Activity = Omit<Observation, "projectId" | "kind"> & {
  projectId: string | null;
  kind: Observation["kind"] | "tasks";
  title?: string;
  action?: string;
};
async function readJson<T>(path: string, empty: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
}
async function privateWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomUUID();
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
export async function currentActivityProfile(config: ServerConfig) {
  return captureProfile(config, await backOfficeAccess(config));
}
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const fileFor = (profile: Profile, date: string) =>
  profile.path + ".activity/" + date + ".json";
async function append(
  config: ServerConfig,
  profile: Profile,
  events: Activity[],
) {
  for (const date of new Set(events.map((event) => utcDay(event.start)))) {
    const path = fileFor(profile, date);
    await withFileWriteLock(path, async () => {
      const existing = await readJson<Activity[]>(path, []);
      const incoming = events.filter(row => utcDay(row.start) === date);
      const streams = new Map<string, Activity[]>();
      for (const event of [...existing, ...incoming].sort((a, b) => a.start - b.start)) {
        // A delayed sample can bridge multiple intervals, including reports from a second window.
        const key = JSON.stringify([event.projectId, event.kind, event.stream]);
        const stream = streams.get(key);
        const previous = stream?.at(-1);
        if (previous && previous.end >= event.start) previous.end = Math.max(previous.end, event.end);
        else if (stream) stream.push(event);
        else streams.set(key, [event]);
      }
      const rows = [...streams.values()].flat();
      if (
        (await currentActivityProfile(config)).profileId !== profile.profileId
      )
        throw new ApiError(
          409,
          "profile_changed",
          "The active account changed.",
        );
      await withFileWriteLock(profile.path, async () => {
        const settings = await readCaptureSettings(profile.path);
        const capture = events[0]?.kind === "tasks" ? settings.tasks : settings.workspaceActivity !== false;
        if (settings.enabled !== false && capture) await privateWrite(path, rows);
      });
    });
  }
}
export async function recordWorkspaceObservations(
  config: ServerConfig,
  batch: z.infer<typeof observationBatch>,
) {
  const profile = await currentActivityProfile(config);
  if (batch.profileId !== profile.profileId)
    throw new ApiError(409, "profile_changed", "The active account changed.");
  const settings = await readCaptureSettings(profile.path);
  if (settings.enabled === false || settings.workspaceActivity === false)
    return;
  const now = Date.now();
  const allowed = new Set((await workdayWorkspaces(config)).map((w) => w.id));
  const valid = batch.observations.filter(
    (row) =>
      row.end > row.start &&
      row.end - row.start <= 90_000 &&
      row.start >= now - 180_000 &&
      row.end <= now + 3_000 &&
      allowed.has(row.projectId),
  );
  await append(
    config,
    profile,
    valid.map((row) => ({
      ...row,
      stream: digest([row.kind === "agent" ? "run" : "window", row.stream]),
    })),
  );
}
type ObservedTask = { id: string; title: string; projectId?: string | null; updatedAt: string };
type TaskAction = "Created task" | "Updated task" | "Completed task" | "Added note" | "Attached file";
function taskObservation(task: ObservedTask, action: TaskAction): Activity {
  const at = Date.parse(task.updatedAt);
  return { kind: "tasks", stream: digest(["task", task.id, task.updatedAt, action]), projectId: task.projectId ?? null,
    start: at, end: at, title: task.title.slice(0, 500), action };
}
export async function beginTaskObservation(config: ServerConfig, ctx: { actor?: { type: string }; agentAccess?: unknown }, userId: string | null) {
  if (ctx.actor?.type !== "host" || ctx.agentAccess || config.readOnly || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(config.host)) return;
  const profile = await currentActivityProfile(config).catch(() => undefined);
  if (!profile || (userId && profile.captureUser !== userId)) return;
  const settings = await readCaptureSettings(profile.path).catch(() => undefined);
  if (settings?.enabled === false || !settings?.tasks) return;
  return (task: ObservedTask, action: TaskAction) => append(config, profile, [taskObservation(task, action)]).catch(() => {});
}
export async function recordCompletedTask(config: ServerConfig, profile: Profile, task: ObservedTask) {
  const settings = await readCaptureSettings(profile.path);
  if (settings.enabled !== false && settings.tasks) await append(config, profile, [taskObservation(task, "Completed task")]);
}
/** Focus notifications from two renderers can overlap. The most recently focused window owns that clock span. */
export function exclusiveForeground(records: Activity[]): Activity[] {
  const foreground = records
    .filter((row) => row.kind === "foreground")
    .sort((a, b) => a.start - b.start || a.stream.localeCompare(b.stream));
  const output = records.filter((row) => row.kind !== "foreground");
  const spans: Activity[] = [];
  for (const row of foreground) {
    const prior = spans.at(-1);
    if (prior && prior.end > row.start) prior.end = row.start;
    spans.push({ ...row });
  }
  return output.concat(spans.filter((row) => row.end > row.start));
}
export async function readActivityEvidence(
  config: ServerConfig,
  profile: Profile,
  date: string,
  zone: string,
): Promise<WorkdayEvidence[]> {
  const start = Date.parse(zonedInstant(date, zone)),
    end = Date.parse(zonedInstant(addDays(date, 1), zone));
  const settings = await readCaptureSettings(profile.path);
  if (settings.enabled === false) return [];
  const records = (
    await Promise.all(
      [
        ...new Set([utcDay(start - 90_000), utcDay(start), utcDay(end - 1)]),
      ].map((day) => readJson<Activity[]>(fileFor(profile, day), [])),
    )
  ).flat();
  if (settings.tasks) {
    const account = (await readEigenweltConnection(config)).account;
    if (account && account.userId === profile.captureUser) {
      const notes = (await taskStore(config)).workdayNotes(account.orgId, account.userId, start, end);
      const known = new Set(records.map(row => row.stream));
      for (const note of notes) {
        const row = taskObservation(note, "Added note");
        if (!known.has(row.stream)) records.push(row);
      }
    }
  }
  const allowed = new Set((await workdayWorkspaces(config)).map((w) => w.id));
  return exclusiveForeground(
    records.filter((row) => !row.projectId || allowed.has(row.projectId)),
  ).flatMap((row): WorkdayEvidence[] => {
    const task = row.kind === "tasks";
    if (
      (task ? !settings.tasks : settings.workspaceActivity === false) ||
      row.start >= end ||
      (task ? row.start < start : row.end <= start)
    )
      return [];
    const eventKey = digest([
      profile.profileId,
      date,
      row.kind,
      row.stream,
      row.projectId,
      row.start,
    ]);
    const observedAt = new Date(row.start).toISOString();
    const body = {
      date,
      projectId: row.projectId,
      source: task
        ? ("tasks" as const)
        : row.kind === "agent"
          ? ("agent" as const)
          : ("workspace" as const),
      observation: row.kind === "tasks" ? undefined : row.kind,
      observedAt,
      activity: "",
      ...(row.action ? { changeSummary: row.action } : {}),
      narrative:
        row.title ??
        (row.kind === "agent"
          ? "Agent running in project"
          : row.kind === "passive"
            ? "Project open in background or idle"
            : "Active project window"),
      startAt: task ? null : new Date(Math.max(start, row.start)).toISOString(),
      endAt: task ? null : new Date(Math.min(end, row.end)).toISOString(),
      workedMinutes: null,
      dismissed: false,
    };
    return [
      {
        eventKey,
        proposal: {
          ...body,
          key: randomUUID(),
          digest: digest([eventKey, body]),
        },
      },
    ];
  });
}

export type CaptureFileIdentity = Pick<Stats, "dev" | "ino" | "birthtimeMs">;

/** Bridge only the before and after identities observed in the same atomic editor write. */
export async function localCaptureDocumentId(
  config: ServerConfig,
  profile: Profile,
  projectId: string,
  before: CaptureFileIdentity | null,
  after: CaptureFileIdentity,
) {
  const path = profile.path + ".documents.json";
  const identity = (file: CaptureFileIdentity) => digest([projectId, file.dev, file.ino, file.birthtimeMs]);
  const replaced = before ? identity(before) : undefined;
  const persisted = identity(after);
  return withFileWriteLock(path, async () => {
    const map = await readJson<Record<string, string>>(path, {});
    if ((await currentActivityProfile(config)).profileId !== profile.profileId)
      return;
    const id = (replaced ? map[replaced] : undefined) ?? map[persisted] ?? randomUUID();
    if (replaced) map[replaced] = id;
    map[persisted] = id;
    await privateWrite(path, map);
    return id;
  });
}
