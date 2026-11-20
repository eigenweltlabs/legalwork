import { connectedWorkdayWording } from "./connected-model.js";
import { workdayModelSchema, type CaptureState, privateEntryDraftSchema } from "../back-office/timesheet-schema.js";
import { BackOfficeValueSchema } from "../back-office/schema.js";
import { backOfficeStore } from "../back-office/store.js";
import { timeWorkspaces } from "../back-office/timesheet-data.js";
import { changeStopwatch, createStopwatchReader, emptyStopwatch, privateStopwatchSchema } from "./stopwatch.js";
import { renameSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { originalBillingComparison, proposalCommitment } from "./original.js";
import { correctWorkday } from "./correct-workday.js";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  captureEnabled,
  stopwatchActionSchema,
  stopwatchStateSchema,
  workdayCorrectionSchema,
  captureProposalSchema,
  captureSettingsSchema,
  reconcileCaptureSchema,
} from "../back-office/timesheet-schema.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "../back-office/access.js";
import { addDays } from "../calendar/dates.js";
import { globalCalendarOccurrences } from "../calendar/service.js";
import { backOfficePrincipalKey } from "../back-office/principal.js";
import { readEigenweltConnection, runtimeDbPath } from "../eigenwelt-connection-store.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { documentEvidence, eligibleDocumentReference } from "./document-workday.js";
import { digest, workdayEvidence, type WorkdayEvidence } from "./private-workday.js";
import { connectedWorkdayAccounts, readConnectedWorkday, sourceAvailable } from "./connected-workday.js";
import { draftWithLocalModel, localModel, previewWorkdayWording } from "./local-model.js";
import { validateReconcileTarget } from "./reconcile.js";

const savedSchema = z.object({
  stopwatch: privateStopwatchSchema.default(emptyStopwatch),
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
  drafts: z.record(z.uuid(), privateEntryDraftSchema).default({}),
  reconciled: z.record(z.uuid(), z.uuid()).default({}),
  bookingTargets: z.record(z.string(), z.enum(["workflow", "record"])).default({}),
});
type Saved = z.infer<typeof savedSchema>;
const defaults = (): Saved => ({
  stopwatch: emptyStopwatch(),
  settings: { calendar: false, tasks: false, intervalMinutes: 0 },
  lastRun: 0,
  days: {},
  originals: {},
  accepted: {},
  bookingTargets: {},
  drafts: {},
  reconciled: {},
  documentSaves: {},
  documentEpoch: 0,
});
export async function captureProfile(
  config: ServerConfig,
  { actor, scope }: Awaited<ReturnType<typeof backOfficeAccess>>,
) {
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
    profileId: owner,
    captureUser: account?.userId ?? actor.userId,
    user: actor.userId,
    principal: actor.principalKey ?? "",
    scope,
    path: join(dirname(runtimeDbPath(config)), "private-timesheets", owner + ".json"),
  };
}
async function profile(config: ServerConfig) {
  return captureProfile(config, await backOfficeAccess(config));
}
async function load(path: string): Promise<Saved> {
  try {
    return savedSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaults();
    throw error;
  }
}
async function save(path: string, s: Saved, beforeCommit?: () => Promise<() => void>) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(s), { mode: 0o600 });
    if (beforeCommit) {
      // Directory mutations are synchronous. Keep the target check and profile commit in the same turn.
      const validate = await beforeCommit();
      validate();
      renameSync(temp, path);
    } else await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
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
/** Resolve only the worker-approved billing fields from this device's accepted private originals. */
export async function submissionOriginals(
  config: ServerConfig,
  profileId: string | null,
  actor: { user: string; scope: string; principal: string },
  refs: { key: string; digest: string }[],
) {
  if (!loopback(config))
    throw new ApiError(403, "private_workday", "Open the original on its local device.");
  const prof = await profile(config);
  if (prof.profileId !== profileId || prof.user !== actor.user ||
      prof.scope !== actor.scope || prof.principal !== actor.principal)
    throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
  const saved = await load(prof.path);
  const originals = new Map<string, { activity: string; narrative: string; workedMinutes: number | null }>();
  for (const { key, digest } of refs) {
    if (saved.accepted[key] !== digest || saved.originals[digest]?.key !== key)
      throw new ApiError(409, "private_workday_changed", "The accepted original is unavailable on this device.");
    const { activity, narrative, workedMinutes } = originalBillingComparison(saved.originals[digest], digest, saved.originals);
    originals.set(digest, { activity, narrative, workedMinutes });
  }
  if ((await profile(config)).path !== prof.path)
    throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
  return originals;
}

/** Serialize acceptance with range edits so a stale composer cannot also bill a split-off interval. */
export async function acceptPrivateProposal<T>(
  config: ServerConfig,
  identity: { user: string; scope: string; principal: string; profileId: string | null },
  key: string,
  hash: string,
  write: () => Promise<T>,
  target: "workflow" | "record" = "workflow",
) {
  if (!loopback(config))
    throw new ApiError(403, "private_workday", "Open the proposal on its local device.");
  const prof = await profile(config),
    path = prof.path;
  if (
    prof.profileId !== identity.profileId ||
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
    if (prior && (saved.bookingTargets[key] ?? "workflow") !== target)
      throw new ApiError(409, "private_workday_changed", "This proposal was already booked through another entry workflow.");
    const original = saved.originals[hash];
    const candidate =
      original && saved.days[original.date]?.find((item) => item.proposal.key === key)?.proposal;
    if (saved.reconciled[key]) throw new ApiError(409, "private_already_booked", "This suggestion is already linked to an entry.");
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
      saved.bookingTargets[key] = target;
      await save(path, saved);
    }
    try {
      return await write();
    } catch (error) {
      if (!prior && error instanceof ApiError && error.status >= 400 && error.status < 500) {
        delete saved.accepted[key];
        delete saved.bookingTargets[key];
        await save(path, saved);
      }
      throw error;
    }
  });
}
const workdaysRunning = new Map<string, AbortController>();
async function prepare(config: ServerConfig, path: string, date: string, withModel: boolean,
  generate?: (proposals: z.infer<typeof captureProposalSchema>[], verify: () => Promise<void>, signal: AbortSignal) => Promise<CaptureState["wording"]>) {
  if (workdaysRunning.has(path))
    throw new ApiError(409, "timesheet_running", "A workday is already being prepared.");
  const controller = new AbortController();
  workdaysRunning.set(path, controller);
  try {
    const initial = await load(path);
    if (!captureEnabled(initial.settings)) return;
    const currentProfile = await profile(config);
    if (currentProfile.path !== path) return;
    const events =
      initial.settings.calendar || initial.settings.tasks
        ? await globalCalendarOccurrences(
            config,
            addDays(date, -1),
            addDays(date, 2),
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
    for (const item of [
      ...imported,
      ...workdayEvidence(events, date, initial.settings, currentProfile.captureUser),
    ])
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
    const candidates = await withFileWriteLock(path, async () => {
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
          if (previous.proposal.parentDigest || current.drafts[previous.proposal.key] || current.reconciled[previous.proposal.key] || current.accepted[previous.proposal.key]) return previous;
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
          (previous.proposal.source === "stopwatch" ||
            previous.proposal.dismissed ||
            previous.proposal.parentDigest ||
            current.drafts[previous.proposal.key] ||
            current.reconciled[previous.proposal.key] ||
            current.accepted[previous.proposal.key])
        )
          current.days[date].push(previous);
      current.lastRun = Date.now();
      await save(path, current);
      if (generate) return current.days[date].filter(({ proposal, eventKey }) => available.has(eventKey)
        && !proposal.dismissed && !proposal.parentDigest && !current.accepted[proposal.key] && !current.reconciled[proposal.key] && !current.drafts[proposal.key]).map(item => item.proposal);
    });
    if (generate && candidates) {
      const verify = async () => {
        controller.signal.throwIfAborted();
        if ((await profile(config)).path !== path || JSON.stringify((await load(path)).settings) !== JSON.stringify(initial.settings))
          throw new ApiError(409, "private_workday_changed", "The account or activity sources changed.");
      };
      return await generate(candidates, verify, controller.signal);
    }
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
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  jsonResponse: (d: unknown) => Response;
  ensureWritable: (config: ServerConfig) => void;
  readJsonBodyLimited: (request: Request, max: number) => Promise<Record<string, unknown>>;
}) {
  const { routes, config } = options;
  const readStopwatch = createStopwatchReader();
  for (const method of ["GET", "POST"])
    addRoute(routes, method, "/private-timesheet/stopwatch", "host-token", async (ctx) => {
      if (!loopback(config) || ctx.agentAccess)
        throw new ApiError(403, "private_workday", "Open the stopwatch on your local LegalWork server.");
      const { path, profileId } = await profile(config);
      const expected = ctx.url.searchParams.get("profileId");
      if ((method === "POST" || expected !== null) && expected !== profileId)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      let timer: Pick<Saved["stopwatch"], "active" | "lastStopped">;
      if (method === "POST") {
        options.ensureWritable(config);
        const action = stopwatchActionSchema.parse(await options.readJsonBodyLimited(ctx.request, 1024));
        if (action.type !== "stop" && action.projectId && !config.workspaces.some((project) => project.id === action.projectId))
          throw new ApiError(404, "stopwatch_project", "Choose an available project.");
        timer = await withFileWriteLock(path, async () => {
          const saved = await load(path);
          if ((await profile(config)).path !== path)
            throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
          changeStopwatch(saved, action, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
          await save(path, saved);
          return saved.stopwatch;
        });
      } else timer = await readStopwatch(path);
      if ((await profile(config)).path !== path)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const projects = config.workspaces.map((project) => ({
        id: project.id, name: project.displayName || project.name,
      }));
      const response = options.jsonResponse(stopwatchStateSchema.parse({ ...timer, profileId, projects }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
  addRoute(routes, "GET", "/private-timesheet/original/:digest", "host", async (ctx) => {
    if (!loopback(config) || ctx.agentAccess)
      throw new ApiError(403, "private_workday", "Open the original on the local device.");
    const { path, user, principal, scope, profileId } = await profile(config);
    if (
      ctx.url.searchParams.get("profileId") !== profileId ||
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
      const { path, user, principal, scope, profileId } = await profile(config);
      if (
        ctx.url.searchParams.get("profileId") !== profileId ||
        ctx.url.searchParams.get("user") !== user ||
        ctx.url.searchParams.get("principal") !== principal ||
        ctx.url.searchParams.get("scope") !== scope
      )
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const date = z.iso.date().parse(ctx.url.searchParams.get("date"));
      let wording: CaptureState["wording"];
      if (method === "POST") {
        options.ensureWritable(config);
        const parsed = z
          .discriminatedUnion("type", [
            z.strictObject({ type: z.literal("settings"), settings: captureSettingsSchema }),
            z.strictObject({ type: z.enum(["run", "calendar"]) }),
            z.strictObject({ type: z.literal("suggest"), model: workdayModelSchema.optional() }),
            z.strictObject({ type: z.literal("dismiss"), key: z.uuid() }),
            z.strictObject({ type: z.literal("draft"), key: z.uuid(), date: z.iso.date().optional(), values: z.record(z.string().max(200), BackOfficeValueSchema).nullable(), proposalDigest: z.string().length(64).optional() }),
            reconcileCaptureSchema,
            workdayCorrectionSchema,
          ])
          .safeParse(await options.readJsonBodyLimited(ctx.request, 8192));
        if (!parsed.success) throw new ApiError(400, "private_workday_input", "Check the workday action and refresh the entry before retrying.");
        const action = parsed.data;
        if (action.type === "suggest") {
          const model = action.model;
          const workspace = model && await options.resolveWorkspace(config, model.workspaceId);
          const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(150_000)]);
          wording = await prepare(config, path, date, false, (proposals, verify, cancel) =>
            model && workspace
              ? connectedWorkdayWording(config, workspace, model, proposals, verify, AbortSignal.any([signal, cancel]))
              : previewWorkdayWording(proposals, verify, AbortSignal.any([signal, cancel])));
        } else if (action.type === "run" || action.type === "calendar")
          await prepare(config, path, date, action.type === "run");
        else
          await withFileWriteLock(path, async () => {
            const s = await load(path);
            let beforeCommit: (() => Promise<() => void>) | undefined;
            async function verifyProfile() {
              if ((await profile(config)).path !== path)
                throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
            }
            if (action.type === "settings") {
              workdaysRunning.get(path)?.abort();
              if (Boolean(s.settings.documents) !== Boolean(action.settings.documents))
                s.documentEpoch++;
              s.settings = action.settings;
            } else if (action.type === "draft") {
              if (action.date && action.date !== date) throw new ApiError(409, "private_workday_changed", "The draft date changed.");
              if (s.accepted[action.key] && action.values !== null) throw new ApiError(409, "private_already_booked", "This entry is already saved.");
              if (action.proposalDigest) {
                const proposal = s.days[date]?.find(item => item.proposal.key === action.key)?.proposal;
                if (!proposal || proposal.dismissed || proposal.digest !== action.proposalDigest) throw new ApiError(409, "private_workday_changed", "The suggestion changed.");
              }
              if (action.values === null) delete s.drafts[action.key];
              else s.drafts[action.key] = { date, values: action.values, proposalDigest: action.proposalDigest };
            } else if (action.type === "reconcile") {
              const proposal = s.days[date]?.find(item => item.proposal.key === action.key)?.proposal;
              const linked = s.reconciled[action.key], accepted = s.accepted[action.key];
              if (!proposal || proposal.date !== date || proposal.dismissed || proposal.digest !== action.digest ||
                  proposalCommitment(proposal) !== action.digest ||
                  (linked ? linked !== action.recordId || accepted !== action.digest : accepted))
                throw new ApiError(409, "private_workday_changed", "The suggestion changed or was already booked.");
              if (linked) return;
              if (!sourceAvailable(proposal, await connectedWorkdayAccounts(config), s.settings)) throw new ApiError(409, "private_workday_changed", "The source is unavailable.");
              const access = await backOfficeAccess(config, scope !== "local"), store = await backOfficeStore(config);
              if (access.scope !== scope || access.actor.userId !== user || (access.actor.principalKey ?? "") !== principal) throw new ApiError(409, "private_workday_changed", "The account changed.");
              const draft = s.drafts[action.key];
              const draftValues = draft?.date === date && draft.proposalDigest === action.digest ? draft.values : undefined;
              const draftMatter = draftValues?.workflow === true ? draftValues.matterId : draftValues?.matter;
              const hasDraftMatter = draftValues && (Object.hasOwn(draftValues, "matter") || Object.hasOwn(draftValues, "matterId"));
              const reviewedMatter = typeof draftMatter === "string" && draftMatter ? draftMatter : hasDraftMatter ? null : undefined;
              const workspaces = reviewedMatter === undefined && !proposal.matterId && proposal.projectId
                ? await timeWorkspaces(config.workspaces.filter((workspace) => workspace.id === proposal.projectId), await backOfficeDirectoryIdentity(config, scope, store))
                : [];
              const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
              beforeCommit = async () => {
                await verifyProfile();
                return () => validateReconcileTarget(store, scope, access.actor, action, proposal, { matter: reviewedMatter, values: draftValues }, workspaces, zone);
              };
              s.accepted[action.key] = action.digest;
              s.bookingTargets[action.key] = "record";
              s.reconciled[action.key] = action.recordId;
              delete s.drafts[action.key];
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
            if (!beforeCommit) await verifyProfile();
            await save(path, s, beforeCommit);
          });
      }
      const s = await load(path);
      const connections = (await connectedWorkdayAccounts(config)).map(({ provider, account }) => ({
        provider,
        account,
      }));
      const result = options.jsonResponse({
        settings: s.settings,
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, draft]) => draft.date === date)),
        connections,
        modelReady: Boolean(await localModel()),
        wording,
        proposals: (s.days[date] ?? [])
          .map((row) => ({
            ...row.proposal,
            versions: Object.values(s.originals)
              .filter((p) => p.key === row.proposal.key)
              .map((p) => p.digest),
          }))
          .filter((p) => sourceAvailable(p, connections, s.settings) && !p.dismissed && !s.reconciled[p.key]),
      });
      if ((await profile(config)).path !== path)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      result.headers.set("Cache-Control", "no-store");
      return result;
    });
}
