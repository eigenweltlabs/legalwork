import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { originalBillingComparison, proposalCommitment } from "./original.js";
import { correctWorkday } from "./correct-workday.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  captureEnabled,
  workdayCorrectionSchema,
  captureProposalSchema,
  captureSettingsSchema,
} from "@legalwork/types/time-capture";
import { backOfficeAccess } from "../back-office/access.js";
import { addDays } from "../calendar/dates.js";
import { globalCalendarOccurrences } from "../calendar/service.js";
import { backOfficePrincipalKey } from "../back-office/principal.js";
import { readEigenweltConnection, runtimeDbPath } from "../eigenwelt-connection-store.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig } from "../types.js";
import { documentEvidence, eligibleDocumentReference } from "./document-workday.js";
import { digest, workdayEvidence, type WorkdayEvidence } from "./private-workday.js";
import { connectedWorkdayAccounts, readConnectedWorkday, sourceAvailable } from "./connected-workday.js";
import { draftWithLocalModel, localModel } from "./local-model.js";

const savedSchema = z.object({
  settings: captureSettingsSchema,
  lastRun: z.number(),
  days: z.record(
    z.iso.date(),
    z.array(z.object({ eventKey: z.string(), proposal: captureProposalSchema })),
  ),
  documentEpoch: z.number().int().nonnegative().default(0),
  documentSaves: z.record(z.iso.date(), z.record(z.string(), captureProposalSchema)).default({}),
  originals: z.record(z.string(), captureProposalSchema).default({}),
  accepted: z.record(z.string(), z.string()).default({}),
});
type Saved = z.infer<typeof savedSchema>;
const defaults = (): Saved => ({
  settings: { calendar: false, tasks: false, intervalMinutes: 0 },
  lastRun: 0,
  days: {},
  originals: {},
  accepted: {},
  documentSaves: {},
  documentEpoch: 0,
});
async function profile(config: ServerConfig) {
  const { actor, scope } = await backOfficeAccess(config);
  const connection = scope === "local" ? await readEigenweltConnection(config) : undefined;
  // The local directory uses one finance identity even when different firm
  // users sign in. Private opt-ins and document names belong to the actual account.
  const account = connection?.account;
  const identity = account
    ? connection.platformURL
      ? backOfficePrincipalKey(connection.platformURL, account.orgId, account.userId)
      : digest(["account", account.orgId, account.userId])
    : (actor.principalKey ?? actor.userId);
  const owner = digest([scope, identity]);
  return {
    user: actor.userId,
    principal: actor.principalKey ?? "",
    scope,
    path: join(dirname(runtimeDbPath(config)), "private-timesheets", owner + ".json"),
  };
}
async function load(path: string): Promise<Saved> {
  try {
    return savedSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaults();
    throw error;
  }
}
async function save(path: string, s: Saved) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  await writeFile(temp, JSON.stringify(s), { mode: 0o600 });
  await rename(temp, path);
}
const loopback = (config: ServerConfig) =>
  ["127.0.0.1", "localhost", "::1", "[::1]"].includes(config.host);
// A save can span a prompt or an account change. Capture only when the same
// local profile has consent both before the save and after it succeeds.
export async function beginDocumentCapture(
  config: ServerConfig,
  ctx: { actor?: { type: string }; agentAccess?: unknown },
  projectId: string,
  reference: string,
) {
  if (
    config.readOnly ||
    !loopback(config) ||
    ctx.agentAccess ||
    ctx.actor?.type !== "host" ||
    !eligibleDocumentReference(reference)
  )
    return;
  try {
    const { path } = await profile(config);
    const before = await load(path);
    if (!before.settings.documents) return;
    return async (created: boolean) => {
      try {
        const evidence = documentEvidence(projectId, reference, created, new Date());
        if (!evidence) return;
        await withFileWriteLock(path, async () => {
          if ((await profile(config)).path !== path) return;
          const current = await load(path);
          if (!current.settings.documents || current.documentEpoch !== before.documentEpoch) return;
          const records = (current.documentSaves[evidence.proposal.date] ??= {});
          if (Object.hasOwn(records, evidence.eventKey)) return;
          records[evidence.eventKey] = evidence.proposal;
          await save(path, current);
        });
      } catch {
        /* A private capture failure must not turn a successful document save into a failed write. */
      }
    };
  } catch {
    return;
  }
}
/** Serialize acceptance with range edits so a stale composer cannot also bill a split-off interval. */
export async function acceptPrivateProposal<T>(
  config: ServerConfig,
  identity: { user: string; scope: string; principal: string },
  key: string,
  hash: string,
  write: () => Promise<T>,
) {
  if (!loopback(config))
    throw new ApiError(403, "private_workday", "Open the proposal on its local device.");
  const prof = await profile(config),
    path = prof.path;
  if (
    prof.user !== identity.user ||
    prof.scope !== identity.scope ||
    prof.principal !== identity.principal
  )
    throw new ApiError(409, "private_workday_changed", "The active account changed.");
  return withFileWriteLock(path, async () => {
    const saved = await load(path),
      prior = saved.accepted[key];
    if (prior && prior !== hash)
      throw new ApiError(409, "private_workday_changed", "This proposal has already been booked.");
    const original = saved.originals[hash];
    const candidate =
      original && saved.days[original.date]?.find((item) => item.proposal.key === key)?.proposal;
    const accounts = await connectedWorkdayAccounts(config);
    if (
      !candidate ||
      candidate.dismissed ||
      candidate.digest !== hash ||
      proposalCommitment(candidate) !== hash ||
      !sourceAvailable(candidate, accounts, saved.settings)
    )
      throw new ApiError(
        409,
        "private_workday_changed",
        "The private suggestion changed. Reopen the workday.",
      );
    const verified = await profile(config);
    if (verified.path !== path)
      throw new ApiError(409, "private_workday_changed", "The active account changed.");
    // Reserve before the asynchronous write. A timeout can happen after a firm server already committed it.
    // Retrying the same proposal uses its idempotent request key. Keep the reservation on ambiguous failures.
    if (!prior) {
      saved.accepted[key] = hash;
      await save(path, saved);
    }
    try {
      return await write();
    } catch (error) {
      if (!prior && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        delete saved.accepted[key];
        await save(path, saved);
      }
      throw error;
    }
  });
}
const workdaysRunning = new Map<string, AbortController>();
async function prepare(config: ServerConfig, path: string, date: string, withModel: boolean) {
  if (workdaysRunning.has(path))
    throw new ApiError(409, "timesheet_running", "A workday is already being prepared.");
  const controller = new AbortController();
  workdaysRunning.set(path, controller);
  try {
    const initial = await load(path);
    if (!captureEnabled(initial.settings)) return;
    const events =
      initial.settings.calendar || initial.settings.tasks
        ? await globalCalendarOccurrences(
            config,
            date,
            addDays(date, 1),
            config.workspaces,
            initial.settings,
          )
        : [];
    const imported = await readConnectedWorkday(
      config,
      initial.settings.connections ?? [],
      date,
      controller.signal,
    );
    const byEvidence = new Map<string, WorkdayEvidence>();
    // Prefer a project-linked local event when the same iCalendar occurrence appears in both feeds.
    for (const item of [...imported, ...workdayEvidence(events, date, initial.settings)])
      byEvidence.set(item.eventKey, item);
    if (initial.settings.documents)
      for (const [eventKey, proposal] of Object.entries(initial.documentSaves[date] ?? {}))
        byEvidence.set(eventKey, { eventKey, proposal });
    const evidence = [...byEvidence.values()];
    const proposed: WorkdayEvidence[] = [];
    if (withModel) {
      for (let i = 0; i < evidence.length; i += 20)
        proposed.push(...(await draftWithLocalModel(evidence.slice(i, i + 20), controller.signal)));
    } else proposed.push(...evidence);
    await withFileWriteLock(path, async () => {
      const current = await load(path);
      if (
        controller.signal.aborted ||
        (await profile(config)).path !== path ||
        JSON.stringify(current.settings) !== JSON.stringify(initial.settings)
      )
        return;
      const old = current.days[date] ?? [];
      // The evidence key survives regeneration. Each actually presented version stays available on device by digest.
      const available = new Map(proposed.map((x) => [x.eventKey, x]));
      current.days[date] = proposed.map((next) => {
        const previous = old.find((prev) => prev.eventKey === next.eventKey);
        if (previous) {
          current.originals[previous.proposal.digest] = previous.proposal;
          if (previous.proposal.parentDigest || current.accepted[previous.proposal.key]) return previous;
          if (
            !withModel &&
            previous.proposal.source === next.proposal.source &&
            previous.proposal.account === next.proposal.account
          )
            return previous;
          next.proposal.key = previous.proposal.key;
          next.proposal.dismissed = previous.proposal.dismissed;
        }
        next.proposal.digest = proposalCommitment(next.proposal);
        current.originals[next.proposal.digest] = next.proposal;
        return next;
      });
      for (const previous of old)
        if (
          !available.has(previous.eventKey) &&
          (previous.proposal.dismissed || previous.proposal.parentDigest)
        )
          current.days[date].push(previous);
      current.lastRun = Date.now();
      await save(path, current);
    });
  } finally {
    workdaysRunning.delete(path);
  }
}
function localDay() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}
export function startWorkdaySchedule(config: ServerConfig) {
  if (config.readOnly || !loopback(config)) return () => {};
  let busy = false,
    closed = false;
  const timer = setInterval(async () => {
    if (busy || closed) return;
    busy = true;
    try {
      const { path } = await profile(config),
        state = await load(path),
        interval = state.settings.intervalMinutes;
      if (
        !closed &&
        interval &&
        Date.now() - state.lastRun >= interval * 60000 &&
        captureEnabled(state.settings) &&
        (await localModel())
      )
        await prepare(config, path, localDay(), true);
    } catch {
      /* Private evidence and model output never enter logs. The manual run reports errors. */
    } finally {
      busy = false;
    }
  }, 60000);
  timer.unref();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
export function registerWorkdayRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (d: unknown) => Response;
  ensureWritable: (config: ServerConfig) => void;
  readJsonBodyLimited: (request: Request, max: number) => Promise<Record<string, unknown>>;
}) {
  const { routes, config } = options;
  addRoute(routes, "GET", "/private-timesheet/original/:digest", "host", async (ctx) => {
    if (!loopback(config) || ctx.agentAccess)
      throw new ApiError(403, "private_workday", "Open the original on the local device.");
    const { path, user, principal, scope } = await profile(config);
    if (
      ctx.url.searchParams.get("user") !== user ||
      ctx.url.searchParams.get("principal") !== principal ||
      ctx.url.searchParams.get("scope") !== scope
    )
      throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
    const hash = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .safeParse(ctx.params.digest);
    if (!hash.success) throw new ApiError(400, "private_original", "Choose a saved revision reference.");
    const saved = await load(path),
      comparison = originalBillingComparison(saved.originals[hash.data], hash.data, saved.originals);
    if ((await profile(config)).path !== path)
      throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
    const response = options.jsonResponse(comparison);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  for (const method of ["GET", "POST"])
    addRoute(routes, method, "/private-timesheet/workday", "host", async (ctx) => {
      if (!loopback(config) || ctx.agentAccess)
        throw new ApiError(403, "private_workday", "Open the workday on your local LegalWork server.");
      const { path, user, principal, scope } = await profile(config);
      if (
        ctx.url.searchParams.get("user") !== user ||
        ctx.url.searchParams.get("principal") !== principal ||
        ctx.url.searchParams.get("scope") !== scope
      )
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const date = z.iso.date().parse(ctx.url.searchParams.get("date"));
      if (method === "POST") {
        options.ensureWritable(config);
        const action = z
          .discriminatedUnion("type", [
            z.strictObject({ type: z.literal("settings"), settings: captureSettingsSchema }),
            z.strictObject({ type: z.enum(["run", "calendar"]) }),
            z.strictObject({ type: z.literal("dismiss"), key: z.uuid() }),
            workdayCorrectionSchema,
          ])
          .parse(await options.readJsonBodyLimited(ctx.request, 8192));
        if (action.type === "run" || action.type === "calendar")
          await prepare(config, path, date, action.type === "run");
        else
          await withFileWriteLock(path, async () => {
            const s = await load(path);
            if (action.type === "settings") {
              workdaysRunning.get(path)?.abort();
              if (Boolean(s.settings.documents) !== Boolean(action.settings.documents))
                s.documentEpoch++;
              s.settings = action.settings;
            } else if (action.type === "correct") {
              const current = s.days[date]?.find((item) => item.proposal.key === action.key);
              const accounts = await connectedWorkdayAccounts(config);
              if (s.accepted[action.key])
                throw new ApiError(
                  409,
                  "private_already_booked",
                  "This proposal has already been booked.",
                );
              if (!current || !sourceAvailable(current.proposal, accounts, s.settings))
                throw new ApiError(409, "source_disabled", "This source is no longer enabled.");
              correctWorkday(s, date, action, Intl.DateTimeFormat().resolvedOptions().timeZone);
            } else if (action.type === "dismiss") {
              const p = s.days[date]?.find((row) => row.proposal.key === action.key);
              if (p) p.proposal.dismissed = true;
            }
            await save(path, s);
          });
      }
      const current = await profile(config);
      if (current.path !== path)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const s = await load(path);
      const connections = (await connectedWorkdayAccounts(config)).map(({ provider, account }) => ({
        provider,
        account,
      }));
      const result = options.jsonResponse({
        settings: s.settings,
        connections,
        modelReady: Boolean(await localModel()),
        proposals: (s.days[date] ?? [])
          .map((row) => ({
            ...row.proposal,
            versions: Object.values(s.originals)
              .filter((p) => p.key === row.proposal.key)
              .map((p) => p.digest),
          }))
          .filter((p) => sourceAvailable(p, connections, s.settings) && !p.dismissed),
      });
      result.headers.set("Cache-Control", "no-store");
      return result;
    });
}
