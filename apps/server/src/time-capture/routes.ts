import { timeActivities } from "../back-office/timesheet-schema.js";
import { generateConnectedTimeText } from "./connected-model.js";
import { localCaptureDocumentId, readActivityEvidence, type CaptureFileIdentity } from "./activity-workday.js";
import { localWorkdayModel, type WorkdayModel, workdayModelSchema, type CaptureState, privateEntryDraftSchema,
  workdayChatSchema, workdayChatActionSchema, workdayInstructionActionSchema,
  workdayGuidelineActionSchema, workdayGuidelineSchema, workdayStatusSchema } from "../back-office/timesheet-schema.js";
import { BackOfficeValueSchema, canonicalBackOfficeAudit } from "../back-office/schema.js";
import { backOfficeStore } from "../back-office/store.js";
import { timeWorkspaces } from "../back-office/timesheet-data.js";
import { changeStopwatch, createStopwatchReader, emptyStopwatch, privateStopwatchSchema } from "./stopwatch.js";
import { renameSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { originalBillingComparison, proposalCommitment } from "./original.js";
import { correctWorkday } from "./correct-workday.js";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  stopwatchActionSchema,
  stopwatchStateSchema,
  workdayCorrectionSchema,
  captureProposalSchema,
  captureSettingsSchema,
  captureSettingsPatchSchema,
  privateDraftPatchSchema,
  reconcileCaptureSchema,
} from "../back-office/timesheet-schema.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "../back-office/access.js";
import { addDays, dayInZone } from "../calendar/dates.js";
import { globalCalendarOccurrences } from "../calendar/service.js";
import { backOfficePrincipalKey } from "../back-office/principal.js";
import { readEigenweltConnection, runtimeDbPath } from "../eigenwelt-connection-store.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { documentEvidence, eligibleDocumentReference } from "./document-workday.js";
import { claimsFor, claimsOverlap, digest, intervalsOverlap, workdayEvidence, workdayEvidenceSchema, type WorkdayEvidence } from "./private-workday.js";
import { connectedWorkdayAccounts, readConnectedWorkday, sourceAvailable } from "./connected-workday.js";
import { generateLocalTimeText, localModel, workdaySkill } from "./local-model.js";
import { modelInput, proposedWorkdayCharge, remainingEvidence } from "./reconstruct-workday.js";
import { privateInstructionSchema, rememberDocumentWording } from "./document-terminology.js";
import { acceptedDocumentEntry, captureMatter, draftRules, modelEvidence, visibleGuideline, workdayContext, workdayWorkspaces } from "./workday-context.js";
import { generateStructuredWorkday } from "./workday-model-passes.js";
import { guidePdfText } from "./guideline-text.js";
import { extractGuidelineRules } from "./guideline-rules.js";
import { validateReconcileTarget } from "./reconcile.js";
import { draftClockSchema, patchCaptureSettings, patchPrivateDraft, requireDraftRevision, unchangedPrivateDraft, writePrivateDraft } from "./private-edits.js";

const savedSchema = z.object({
  stopwatch: privateStopwatchSchema.default(emptyStopwatch),
  settings: captureSettingsSchema,
  settingsPatched: z.boolean().default(false),
  lastRun: z.number(),
  days: z.record(z.iso.date(), z.array(workdayEvidenceSchema)),
  reconstruction: z.record(z.iso.date(), z.object({ key: z.string(), status: workdayStatusSchema })).default({}),
  reconstructionCache: z.record(z.iso.date(), z.record(z.string(), z.object({
    status: workdayStatusSchema, proposals: z.array(workdayEvidenceSchema).optional(),
  }))).default({}),
  proposalKeys: z.record(z.iso.date(), z.record(z.string(), z.uuid())).default({}),
  lastModel: workdayModelSchema.optional(),
  chat: z.record(z.iso.date(), z.array(workdayChatSchema)).default({}),
  instructions: z.record(z.uuid(), privateInstructionSchema).default({}),
  guidelines: z.record(z.uuid(), z.array(workdayGuidelineSchema)).default({}),
  fileProducts: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  pendingBookings: z.record(z.uuid(), z.boolean()).default({}),
  bookingRequests: z.record(z.uuid(), z.string()).default({}),
  documentEpoch: z.number().int().nonnegative().default(0),
  documentSaves: z.record(z.iso.date(), z.record(z.string(), captureProposalSchema)).default({}),
  originals: z.record(z.string(), captureProposalSchema).default({}),
  accepted: z.record(z.string(), z.string()).default({}),
  drafts: z.record(z.uuid(), privateEntryDraftSchema).default({}),
  draftClocks: z.record(z.uuid(), draftClockSchema).default({}),
  reconciled: z.record(z.uuid(), z.uuid()).default({}),
  bookingTargets: z.record(z.string(), z.enum(["workflow", "record"])).default({}),
});
type Saved = z.infer<typeof savedSchema>;
const defaults = (): Saved => ({
  stopwatch: emptyStopwatch(),
  settings: { calendar: true, tasks: true, documents: true, workspaceActivity: true, stopwatchMode: "always", intervalMinutes: 0 },
  settingsPatched: false,
  lastRun: 0,
  days: {},
  reconstruction: {},
  reconstructionCache: {},
  proposalKeys: {},
  chat: {},
  instructions: {},
  guidelines: {},
  fileProducts: {},
  pendingBookings: {},
  bookingRequests: {},
  originals: {},
  accepted: {},
  bookingTargets: {},
  drafts: {},
  draftClocks: {},
  reconciled: {},
  documentSaves: {},
  documentEpoch: 0,
});
export async function captureProfile(
  config: ServerConfig,
  { actor, scope }: Pick<Awaited<ReturnType<typeof backOfficeAccess>>, "actor" | "scope">,
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
export async function readCaptureSettings(path: string) {
  return (await load(path)).settings;
}
export async function readCaptureGuidelines(path: string) {
  return Object.values((await load(path)).guidelines).flat();
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
    const owner = await profile(config);
    const { path } = owner;
    const snapshot = await load(path);
    if (!snapshot.settings.documents) return;
    return async (before: CaptureFileIdentity | null, after: CaptureFileIdentity) => {
      try {
        await withFileWriteLock(path, async () => {
          if ((await profile(config)).path !== path) return;
          const current = await load(path);
          if (!current.settings.documents || current.documentEpoch !== snapshot.documentEpoch) return;
          const documentId = await localCaptureDocumentId(config, owner, projectId, before, after);
          if (!documentId || (await profile(config)).path !== path) return;
          const evidence = documentEvidence(projectId, reference, !before, new Date(), documentId);
          if (!evidence) return;
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


type BookingIdentity = { user: string; scope: string; principal: string; profileId: string | null };
export type BookingAuthority<T> = { request: unknown; resolve: () => Promise<{ booked: T } | "uncommitted" | "rejected" | undefined> };

function bookingFingerprint<T>(saved: Saved, key: string, authority?: BookingAuthority<T>) {
  const previous = saved.bookingRequests[key];
  const current = authority && digest(canonicalBackOfficeAudit(z.json().parse(JSON.parse(JSON.stringify(authority.request)))));
  if (previous && current !== previous)
    throw new ApiError(409, "private_booking_pending", "Retry this booking with its original values.");
  return current;
}

async function writeBooking<T>(write: () => Promise<T>, phase: "new" | "pending" | "confirmed", exact: boolean,
  authority: BookingAuthority<T> | undefined, release: () => Promise<void>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500 || [408, 425, 429].includes(error.status))
      throw error;
    if (phase === "new") await release();
    else if (authority) {
      const outcome = await authority.resolve().catch(() => undefined);
      if (typeof outcome === "object") return outcome.booked;
      if (phase === "pending" && (outcome === "uncommitted" || (outcome === "rejected" && exact))) await release();
    }
    throw error;
  }
}

async function bookingProfile(config: ServerConfig, identity: BookingIdentity) {
  if (!loopback(config))
    throw new ApiError(403, "private_workday", "Open the proposal on its local device.");
  const prof = await profile(config);
  if (
    prof.profileId !== identity.profileId ||
    prof.user !== identity.user ||
    prof.scope !== identity.scope ||
    prof.principal !== identity.principal
  )
    throw new ApiError(409, "private_workday_changed", "The active account changed.");
  return prof;
}

/** Serialize acceptance with edits to the proposal and the private draft. */
export async function acceptPrivateProposal<T>(config: ServerConfig, identity: BookingIdentity,
  key: string, hash: string, write: () => Promise<T>, target: "workflow" | "record" = "workflow",
  expectedDraft?: { date?: string; revision: number }, authority?: BookingAuthority<T>) {
  const prof = await bookingProfile(config, identity), { path } = prof;
  return withFileWriteLock(path, async () => {
    const saved = await load(path),
      prior = saved.accepted[key];
    if (prior && prior !== hash)
      throw new ApiError(409, "private_workday_changed", "This proposal has already been booked.");
    if (prior && (saved.bookingTargets[key] ?? "workflow") !== target)
      throw new ApiError(409, "private_workday_changed", "This proposal was already booked through another entry workflow.");
    const fingerprint = bookingFingerprint(saved, key, authority);
    const exact = Boolean(saved.bookingRequests[key]);
    const original = saved.originals[hash];
    const candidate = original && saved.days[original.date]?.find((item) => item.proposal.key === key);
    if (saved.reconciled[key]) throw new ApiError(409, "private_already_booked", "This suggestion is already linked to an entry.");
    const accounts = await connectedWorkdayAccounts(config);
    if (
      !candidate ||
      candidate.proposal.dismissed ||
      candidate.proposal.digest !== hash ||
      proposalCommitment(candidate.proposal) !== hash ||
      !eligibleSource(candidate, accounts, saved.settings)
    )
      throw new ApiError(409, "private_workday_changed", "The private suggestion changed. Reopen the workday.");
    const verified = await profile(config);
    if (verified.path !== path)
      throw new ApiError(409, "private_workday_changed", "The active account changed.");
    if (!prior || saved.pendingBookings[key])
      requireDraftRevision(saved, key, expectedDraft?.revision, expectedDraft?.date ?? candidate.proposal.date, hash);
    // A timeout may happen after a firm server commits. Hold the claim, and
    // keep that exact proposal visible for an idempotent retry.
    if (!prior) {
      requireUnbooked(saved, candidate);
      saved.accepted[key] = hash;
      saved.pendingBookings[key] = true;
      saved.bookingTargets[key] = target;
      if (fingerprint) saved.bookingRequests[key] = fingerprint;
      await save(path, saved);
    }
    const phase = prior ? (saved.pendingBookings[key] ? "pending" : "confirmed") : "new";
    const result = await writeBooking(write, phase, exact, authority, async () => {
      delete saved.accepted[key];
      delete saved.pendingBookings[key];
      delete saved.bookingTargets[key];
      delete saved.bookingRequests[key];
      await save(path, saved);
    });
    const { documentId } = candidate.proposal;
    const entry = documentId ? acceptedDocumentEntry(result, key, hash, prof.user) : undefined;
    const newBinding = documentId && entry?.workProductId &&
      saved.fileProducts[documentId]?.[entry.matterId] !== entry.workProductId;
    if (documentId && entry?.workProductId && newBinding)
      (saved.fileProducts[documentId] ??= {})[entry.matterId] = entry.workProductId;
    if (saved.pendingBookings[key] && documentId && entry?.narrative) {
      const title = verifiedDocumentTitle(saved, candidate);
      const clock = saved.draftClocks[key];
      const field = target === "record" ? "billingNarrative" : "narrative";
      const manuallyEdited = clock?.guarded && clock.fields[field] &&
        saved.drafts[key]?.values[field] === entry.narrative;
      let before = candidate.proposal;
      while (before.parentDigest) {
        const previous = saved.originals[before.parentDigest];
        if (!previous || previous.documentId !== documentId || previous.key !== key) break;
        if (previous.narrative !== before.narrative) {
          before = previous;
          break;
        }
        before = previous;
      }
      if (manuallyEdited || (entry.narrative === candidate.proposal.narrative && before.narrative !== entry.narrative))
        rememberDocumentWording(saved.instructions, key, documentId, entry.matterId, before.narrative, entry.narrative, title);
    }
    if (saved.pendingBookings[key] || newBinding) {
      delete saved.pendingBookings[key];
      delete saved.drafts[key];
      await save(path, saved);
    }
    return result;
  });
}

function verifiedDocumentTitle(saved: Saved, item: WorkdayEvidence) {
  if (item.sourceDocumentTitle) return item.sourceDocumentTitle;
  const proposal = item.proposal;
  const savedDocument = Object.values(saved.documentSaves[proposal.date] ?? {})
    .find(source => source.documentId === proposal.documentId);
  const name = savedDocument?.narrative ?? (!item.generated && !proposal.parentDigest && proposal.source === "documents"
    ? proposal.narrative
    : undefined);
  return name?.slice(0, name.length - extname(name).length);
}

export async function rememberAcceptedDocumentEdit(config: ServerConfig,
  access: Pick<Awaited<ReturnType<typeof backOfficeAccess>>, "actor" | "scope">,
  edit: { key: string; digest?: string; matterId: string; before: string; after: string; revision?: number; reconciledOnly?: boolean }) {
  if (!loopback(config) || edit.before === edit.after) return;
  // The billing edit has already committed. Local memory cannot turn it into a failed save.
  try {
    const owner = await captureProfile(config, access);
    await withFileWriteLock(owner.path, async () => {
      const saved = await load(owner.path);
      const target = edit.digest ? "workflow" : "record";
      const matches = target === "record"
        ? Object.keys(saved.reconciled).filter(key => saved.reconciled[key] === edit.key)
        : [];
      const direct = !edit.reconciledOnly && saved.accepted[edit.key] &&
        (saved.bookingTargets[edit.key] ?? "workflow") === target;
      const candidates = [...new Set(direct ? [edit.key, ...matches] : matches)];
      if (candidates.length > 1) return;
      const key = candidates[0];
      if (!key) return;
      const hash = saved.accepted[key];
      if (saved.pendingBookings[key] || (edit.digest && edit.digest !== hash) ||
          (saved.bookingTargets[key] ?? "workflow") !== target) return;
      const origin = hash ? saved.originals[hash] : undefined;
      if (!origin?.documentId || (await profile(config)).path !== owner.path) return;
      const item = saved.days[origin.date]?.find(item => item.proposal.key === key);
      if (rememberDocumentWording(saved.instructions, key, origin.documentId, edit.matterId, edit.before, edit.after,
        item && verifiedDocumentTitle(saved, item), edit.revision))
        await save(owner.path, saved);
    });
  } catch {
    console.warn("Could not update the private workday's document wording.");
  }
}

export async function bookPrivateManualDraft<T>(config: ServerConfig, identity: BookingIdentity,
  key: string, expected: { date: string; revision: number }, write: () => Promise<T>, target: "workflow" | "record",
  authority: BookingAuthority<T>) {
  const { path } = await bookingProfile(config, identity);
  return withFileWriteLock(path, async () => {
    await bookingProfile(config, identity);
    const saved = await load(path);
    const { date, revision } = expected;
    const clock = saved.draftClocks[key];
    if (clock?.booking && clock.booking.target !== target)
      throw new ApiError(409, "private_workday_changed", "This draft was already saved through another entry workflow.");
    const fingerprint = bookingFingerprint(saved, key, authority);
    const exact = Boolean(saved.bookingRequests[key]);
    if (clock?.date === date && clock.booking?.revision === revision && !clock.booking.pending && clock.removed)
      return writeBooking(write, "confirmed", exact, authority, async () => {});
    requireDraftRevision(saved, key, revision, date);
    if (!clock?.booking) {
      saved.draftClocks[key] = { date, guarded: true, fields: clock?.fields ?? {}, booking: { revision, pending: true, target } };
      if (fingerprint) saved.bookingRequests[key] = fingerprint;
      await save(path, saved);
    }
    const result = await writeBooking(write, clock?.booking ? "pending" : "new", exact, authority, async () => {
      delete saved.draftClocks[key].booking;
      delete saved.bookingRequests[key];
      await save(path, saved);
    });
    delete saved.drafts[key];
    saved.draftClocks[key] = { ...saved.draftClocks[key], removed: true, booking: { revision, pending: false, target } };
    await save(path, saved);
    return result;
  });
}

function eligibleSource(item: WorkdayEvidence, accounts: Awaited<ReturnType<typeof connectedWorkdayAccounts>> | CaptureState["connections"], settings: Saved["settings"]) {
  return sourceAvailable(item.proposal, accounts, settings) && claimsFor(item).every(claim => sourceAvailable(claim, accounts, settings));
}

function overlapsEvidence(a: WorkdayEvidence, b: WorkdayEvidence) {
  return claimsFor(a).some(claim => claimsFor(b).some(other => claimsOverlap(claim, other)));
}

function clocks(item: WorkdayEvidence) {
  const { startAt, endAt, workedMinutes } = item.proposal;
  if (startAt && endAt) return [{ from: Date.parse(startAt), to: Date.parse(endAt) }];
  if (!item.generated || workedMinutes === null) return [];
  return claimsFor(item).flatMap(claim => claim.from !== null && claim.to !== null ? [{ from: claim.from, to: claim.to }] : []);
}

function requireUnbooked(saved: Saved, item: WorkdayEvidence) {
  const isBooked = (other: WorkdayEvidence) => other.proposal.key !== item.proposal.key && !!saved.accepted[other.proposal.key];
  if ((saved.days[item.proposal.date] ?? []).some(other => isBooked(other) &&
    (overlapsEvidence(item, other) || clocks(item).some(a => clocks(other).some(b => intervalsOverlap(a, b))))))
    throw new ApiError(409, "private_already_booked", "The source or time overlaps a suggestion already booked or being saved.");
}

type Profile = Awaited<ReturnType<typeof profile>>;
type ResolveWorkspace = (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
type PreparationOptions = {
  signal?: AbortSignal;
  resolveWorkspace?: ResolveWorkspace;
  now?: () => number;
  readConnected?: typeof readConnectedWorkday;
};
const workdaysRunning = new Map<string, Map<string, { controller: AbortController; done: Promise<void> }>>();
type Preparation = { type: "refresh" | "suggest" | "run" | "calendar"; model?: WorkdayModel } | z.infer<typeof workdayChatActionSchema>;

function protectedProposal(s: Saved, item: WorkdayEvidence) {
  const p = item.proposal;
  return p.dismissed || Boolean(p.parentDigest || s.drafts[p.key] || s.accepted[p.key] || s.reconciled[p.key]);
}
function applyProposals(saved: Saved, date: string, proposed: WorkdayEvidence[]) {
  const old = saved.days[date] ?? [];
  const locked = old.filter(item => protectedProposal(saved, item));
  const timers = old.filter(item => !item.generated && item.proposal.source === "stopwatch" && !protectedProposal(saved, item));
  const byKey = new Map(old.map(item => [item.eventKey, item]));
  const stable = saved.proposalKeys[date] ??= {};
  const next = proposed.flatMap(item => {
    if (locked.some(other => overlapsEvidence(item, other))) return [];
    const original = byKey.get(item.eventKey)?.proposal;
    const proposal = { ...item.proposal, key: original?.key ?? stable[item.eventKey] ?? item.proposal.key };
    stable[item.eventKey] = proposal.key;
    proposal.digest = proposalCommitment(proposal);
    if (original) saved.originals[original.digest] = original;
    saved.originals[proposal.digest] = proposal;
    return [{ ...item, proposal }];
  });
  saved.days[date] = [...next, ...locked, ...timers];
}

function rawProposals(evidence: WorkdayEvidence[]) {
  const group = new Map<string, WorkdayEvidence>();
  for (const item of evidence) {
    const p = item.proposal;
    if (p.source === "agent" || p.source === "workspace") continue;
    if (p.source !== "documents" || !p.documentId) { group.set(item.eventKey, item); continue; }
    const eventKey = digest(["document-day", p.date, p.documentId]);
    const previous = group.get(eventKey);
    const proposal = previous && (previous.proposal.observedAt ?? "") <= (p.observedAt ?? "") ? previous.proposal : p;
    group.set(eventKey, { eventKey, proposal, claims: [...(previous?.claims ?? []), ...claimsFor(item)] });
  }
  return [...group.values()];
}

function modelChoice(config: ServerConfig, profile: Pick<Saved, "settings" | "lastModel">, requested?: WorkdayModel): WorkdayModel {
  const { settings, lastModel } = profile;
  // A stale window cannot override an explicitly saved provider choice.
  if (!settings.model) return requested ?? lastModel ?? localWorkdayModel;
  const { workspaceId, providerID, modelID } = settings.model;
  return { workspaceId: workspaceId ?? config.workspaces[0]?.id ?? "local", providerID, modelID };
}
function localChoice(choice: WorkdayModel) {
  return choice.providerID === localWorkdayModel.providerID && choice.modelID === localWorkdayModel.modelID;
}

async function prepare(config: ServerConfig, owner: Profile, date: string, action: Preparation,
  { signal: requestSignal, resolveWorkspace, now = Date.now, readConnected = readConnectedWorkday }: PreparationOptions = {}) {
  const { path } = owner;
  let days = workdaysRunning.get(path);
  if (!days) { days = new Map(); workdaysRunning.set(path, days); }
  let previous;
  while ((previous = days.get(date))) {
    if (requestSignal?.aborted) return;
    await previous.done;
  }
  if (requestSignal?.aborted) return;
  // The previous call can remove an empty map while another window waits.
  workdaysRunning.set(path, days);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(150_000);
  const signal = AbortSignal.any([controller.signal, timeout, ...(requestSignal ? [requestSignal] : [])]);
  const { promise, resolve } = Promise.withResolvers<void>();
  days.set(date, { controller, done: promise });
  const verifyProfile = async () => {
    if ((await profile(config)).path !== path)
      throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
  };
  try {
    const workspaces = await workdayWorkspaces(config);
    const access = await backOfficeAccess(config);
    if ((await captureProfile(config, access)).path !== path) return;
    let state: Awaited<ReturnType<typeof workdayContext>> | undefined;
    const context = async () => state ??= await workdayContext(config, access, workspaces);
    if (action.type === "chat") {
      const usage = action.instruction;
      const directory = usage && usage.scope !== "personal" ? await context() : undefined;
      const alreadyAnswered = await withFileWriteLock(path, async () => {
        const current = await load(path);
        const transcript = current.chat[date] ?? [];
        const message = transcript.find(turn => turn.id === action.id);
        if (message) {
          if (message.role !== "user" || message.text !== action.text || Boolean(message.permanent) !== Boolean(usage))
            throw new ApiError(409, "private_workday_changed", "This message changed. Send it as a new correction.");
          return transcript.some(turn => turn.replyTo === action.id);
        }
        const prior = Object.values(current.chat).some(day => day.some(turn => turn.id === action.id));
        if (prior) throw new ApiError(409, "private_workday_changed", "This message belongs to another workday.");
        if (usage) {
          if (usage.scope !== "personal" && usage.matterId &&
              !directory?.matters.some(matter => matter.id === usage.matterId))
            throw new ApiError(403, "private_workday_scope", "Choose an available matter for this instruction.");
          if (usage.scope === "document" &&
              !(current.days[date] ?? []).some(({ proposal }) => proposal.documentId === usage.documentId &&
                (!usage.matterId || captureMatter(proposal, directory!)?.id === usage.matterId) &&
                (!proposal.projectId || workspaces.some(workspace => workspace.id === proposal.projectId))))
            throw new ApiError(403, "private_workday_scope", "Choose a document from this day's suggestions.");
          current.instructions[action.id] = { ...usage, id: action.id, text: action.text };
        }
        current.chat[date] = [...transcript, { id: action.id, role: "user", text: action.text, permanent: Boolean(usage) }];
        await verifyProfile();
        await save(path, current);
        return false;
      });
      if (alreadyAnswered) return;
    }
    const initial = await load(path);
    const settings = initial.settings;
    const withModel = action.type !== "calendar";
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const choice = modelChoice(config, initial, "model" in action ? action.model : undefined);
    const runtime = withModel && localChoice(choice) ? await localModel() : null;
    const workspacesById = new Set(workspaces.map(workspace => workspace.id));
    const events = settings.calendar
      ? await globalCalendarOccurrences(config, addDays(date, -1), addDays(date, 2), workspaces, { calendar: true, tasks: false })
      : [];
    let sourceFailure = false;
    const imported = await readConnected(config, settings, date, signal).catch(error => {
      if (!withModel || signal.aborted) throw error;
      sourceFailure = true;
      return [];
    });
    const byEvidence = new Map<string, WorkdayEvidence>();
    // Prefer a project-linked local event when the same occurrence appears in both feeds.
    for (const item of [
      ...imported, ...workdayEvidence(events, date, settings, owner.captureUser, zone),
      ...await readActivityEvidence(config, owner, date, zone),
    ]) {
      if (item.proposal.projectId && !workspacesById.has(item.proposal.projectId)) continue;
      byEvidence.set(item.eventKey, item);
    }
    if (settings.documents)
      for (const [eventKey, proposal] of Object.entries(initial.documentSaves[date] ?? {}))
        if (!proposal.projectId || workspacesById.has(proposal.projectId)) byEvidence.set(eventKey, { eventKey, proposal });
    if (withModel && settings.stopwatchMode === "evidence")
      for (const item of initial.days[date] ?? [])
        if (!item.generated && item.proposal.source === "stopwatch" && !protectedProposal(initial, item) &&
            (!item.proposal.projectId || workspacesById.has(item.proposal.projectId))) byEvidence.set(item.eventKey, item);
    const evidence = [...byEvidence.values()].sort((a, b) => a.eventKey.localeCompare(b.eventKey));
    const inputs = (s: Saved) => digest([s.settings, s.chat[date]?.filter(turn => turn.role === "user"), s.instructions, s.guidelines, s.fileProducts]);
    const revision = inputs(initial);
    let key = "";
    const verify = async () => {
      signal.throwIfAborted();
      await verifyProfile();
      if (inputs(await load(path)) !== revision)
        throw new ApiError(409, "private_workday_changed", "The activity sources or draft instructions changed.");
    };
    const commit = async (status: NonNullable<CaptureState["status"]>, proposals?: WorkdayEvidence[]) => {
      await withFileWriteLock(path, async () => {
        if (requestSignal?.aborted || controller.signal.aborted) return;
        const current = await load(path);
        await verifyProfile();
        if (inputs(current) !== revision) return;
        if (proposals) applyProposals(current, date, proposals);
        current.lastRun = now();
        current.reconstruction[date] = { key, status };
        if (key && withModel) {
          const { [key]: previous, ...cache } = current.reconstructionCache[date] ?? {};
          current.reconstructionCache[date] = Object.fromEntries([
            ...Object.entries(cache).slice(-11), [key, { status, proposals: proposals ?? previous?.proposals }],
          ]);
          if (status.type === "ready") current.lastModel = choice;
        }
        if (action.type === "chat" && !current.chat[date]?.some(turn => turn.replyTo === action.id))
          (current.chat[date] ??= []).push({ id: randomUUID(), role: "assistant",
            text: action.instruction ? "Saved this private instruction." : status.message, replyTo: action.id });
        await save(path, current);
      });
    };
    if (!withModel) {
      const raw = rawProposals(evidence);
      await commit({ type: "ready", message: "Activity sources refreshed." }, raw);
      return;
    }
    if (sourceFailure) {
      await commit({ type: "failed", message: "A selected activity source could not be read. Check its connection and retry." });
      return;
    }
    try {
      const skill = await workdaySkill();
      const all = modelEvidence(evidence, await context(), Object.values(initial.guidelines).flat(),
        Object.values(initial.instructions), date, initial.fileProducts);
      const transcript = (initial.chat[date] ?? []).filter(turn => turn.role === "user" && !turn.permanent)
        .slice(-30).map(turn => turn.text);
      key = digest(["workday-reconstruction-v3", date, zone, choice, runtime?.fingerprint, skill, modelInput(all),
        all.map(ref => [claimsFor(ref.item), ref.item.proposal.workProductId]), transcript]);
      const cached = initial.reconstructionCache[date]?.[key];
      if (cached && (cached.status.type === "ready" || action.type === "refresh")) {
        // Identical sources reuse proposals, but the schedule still completed a source check.
        await commit(cached.status, initial.reconstruction[date]?.key === key ? undefined : cached.proposals);
        return;
      }
      if (localChoice(choice) && !runtime) {
        await commit({ type: "unavailable", message: "Choose an available model to prepare workday suggestions." });
        return;
      }
      const excluded = (initial.days[date] ?? []).filter(item => protectedProposal(initial, item));
      const remaining = remainingEvidence(all, excluded);
      const currentDraft = action.type === "chat" ? (initial.days[date] ?? []).flatMap(item => {
        if (protectedProposal(initial, item)) return [];
        const evidenceIds = remaining.filter(ref => overlapsEvidence(ref.item, item)).map(ref => ref.item.eventKey);
        if (!evidenceIds.length) return [];
        const { key, matterId, projectId, documentId, activity, startAt, endAt, workedMinutes } = item.proposal;
        return [{ key, evidenceIds, matterId, projectId, documentId, activity, startAt, endAt, workedMinutes }];
      }) : undefined;
      const workspace = remaining.length && !runtime
        ? resolveWorkspace ? await resolveWorkspace(config, choice.workspaceId) : workspaces.find(entry => entry.id === choice.workspaceId)
        : undefined;
      if (remaining.length && !runtime && (!workspace || !workspacesById.has(workspace.id)))
        throw new ApiError(409, "timesheet_model_unavailable", "Choose a model from an available workspace.");
      const proposals = await generateStructuredWorkday({ skill, evidence: remaining, date, zone, transcript, currentDraft,
        generate: async prompt => {
          await verify();
          if (runtime) return generateLocalTimeText(runtime, prompt, signal);
          if (!workspace) throw new ApiError(409, "timesheet_model_unavailable", "Choose an available model.");
          return generateConnectedTimeText(config, workspace, choice, prompt, verify, signal);
        },
      });
      await verify();
      await commit({ type: "ready", message: proposals.length === 0 ? "No additional suggestions for this day." : "Workday suggestions updated." }, proposals);
    } catch (error) {
      if (controller.signal.aborted || requestSignal?.aborted) return;
      if (error instanceof ApiError && error.code === "private_workday_changed") throw error;
      if (!key) key = digest(["unavailable-context", date, revision]);
      const unavailable = error instanceof ApiError && error.code === "timesheet_model_unavailable";
      await commit(unavailable
        ? { type: "unavailable", message: "Choose an available model to prepare workday suggestions." }
        : { type: "failed", message: timeout.aborted
          ? "Preparing workday suggestions timed out. Retry or choose another model."
          : "The workday model could not prepare valid suggestions. Retry or choose another model." });
    }
  } catch (error) {
    if (controller.signal.aborted || requestSignal?.aborted) return;
    throw error;
  } finally {
    days.delete(date);
    if (!days.size && workdaysRunning.get(path) === days) workdaysRunning.delete(path);
    resolve();
  }
}

export async function checkScheduledWorkday(config: ServerConfig, options: Omit<PreparationOptions, "resolveWorkspace">) {
  if (options.signal?.aborted) return;
  const owner = await profile(config);
  const { settings, lastRun } = await load(owner.path);
  const now = (options.now ?? Date.now)();
  if (settings.intervalMinutes && now - lastRun >= settings.intervalMinutes * 60_000) {
    const date = dayInZone(new Date(now).toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    await prepare(config, owner, date, { type: "refresh" }, options);
  }
}

export function startWorkdaySchedule(config: ServerConfig) {
  if (config.readOnly || !loopback(config)) return () => {};
  let busy = false;
  const controller = new AbortController();
  const timer = setInterval(async () => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      await checkScheduledWorkday(config, { signal: controller.signal });
    } catch {
      // Model inputs, source errors and results stay in the private workday.
    } finally {
      busy = false;
    }
  }, 60_000);
  timer.unref();
  return () => {
    controller.abort();
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
      const owner = await profile(config);
      const { path, user, principal, scope, profileId } = owner;
      if (
        ctx.url.searchParams.get("profileId") !== profileId ||
        ctx.url.searchParams.get("user") !== user ||
        ctx.url.searchParams.get("principal") !== principal ||
        ctx.url.searchParams.get("scope") !== scope
      )
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const date = z.iso.date().parse(ctx.url.searchParams.get("date"));
      let sourcePreview = false;
      if (method === "POST") {
        options.ensureWritable(config);
        if (ctx.url.searchParams.get("preview") === "guideline-pdf") {
          const preview = await guidePdfText(ctx.request);
          if ((await profile(config)).path !== path)
            throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
          const response = options.jsonResponse(preview);
          response.headers.set("Cache-Control", "no-store");
          return response;
        }
        if (ctx.url.searchParams.get("preview") === "guideline-rules") {
          const input = z.strictObject({ text: z.string().trim().min(1).max(20_000), model: workdayModelSchema.optional() })
            .parse(await options.readJsonBodyLimited(ctx.request, 100_000));
          const initial = await load(path);
          const choice = modelChoice(config, initial, input.model);
          const runtime = localChoice(choice) ? await localModel() : null;
          const workspaces = await workdayWorkspaces(config);
          const workspace = workspaces.find(item => item.id === choice.workspaceId);
          if ((localChoice(choice) && !runtime) || (!localChoice(choice) && !workspace))
            throw new ApiError(409, "timesheet_model_unavailable", "Choose an available model in timekeeping settings to extract billing rules.");
          const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(150_000)]);
          const verify = async () => {
            signal.throwIfAborted();
            if ((await profile(config)).path !== path || digest([(await load(path)).settings.model]) !== digest([initial.settings.model]))
              throw new ApiError(409, "private_workday_changed", "The active account or model changed. Retry with the current settings.");
          };
          await verify();
          const result = await extractGuidelineRules(input.text, async prompt => {
            if (runtime) return generateLocalTimeText(runtime, prompt, signal);
            if (!workspace) throw new ApiError(409, "timesheet_model_unavailable", "Choose an available model.");
            return generateConnectedTimeText(config, workspace, choice, prompt, verify, signal);
          });
          await verify();
          const response = options.jsonResponse(result);
          response.headers.set("Cache-Control", "no-store");
          return response;
        }
        const parsed = z
          .discriminatedUnion("type", [
            z.strictObject({ type: z.literal("settings"), settings: captureSettingsSchema }),
            captureSettingsPatchSchema,
            z.strictObject({ type: z.enum(["run", "calendar"]) }),
            z.strictObject({ type: z.enum(["suggest", "refresh"]), model: workdayModelSchema.optional() }),
            z.strictObject({ type: z.literal("dismiss"), key: z.uuid(), digest: z.string().length(64).optional() }),
            z.strictObject({ type: z.literal("draft"), key: z.uuid(), date: z.iso.date().optional(), values: z.record(z.string().max(200), BackOfficeValueSchema).nullable(), proposalDigest: z.string().length(64).optional() }),
            privateDraftPatchSchema,
            reconcileCaptureSchema,
            workdayCorrectionSchema,
            workdayChatActionSchema,
            workdayInstructionActionSchema,
            workdayGuidelineActionSchema,
          ])
          .safeParse(await options.readJsonBodyLimited(ctx.request, 100_000));
        if (!parsed.success) throw new ApiError(400, "private_workday_input", "Check the workday action and refresh the entry before retrying.");
        const action = parsed.data;
        sourcePreview = action.type === "calendar";
        if (action.type === "suggest" || action.type === "refresh" || action.type === "run" ||
            action.type === "calendar" || action.type === "chat")
          await prepare(config, owner, date, action, { signal: ctx.request.signal, resolveWorkspace: options.resolveWorkspace });
        else
          await withFileWriteLock(path, async () => {
            const s = await load(path);
            let beforeCommit: (() => Promise<() => void>) | undefined;
            async function verifyProfile() {
              if ((await profile(config)).path !== path)
                throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
            }
            if (action.type === "settings" || action.type === "settings-patch") {
              const next = action.type === "settings-patch" ? patchCaptureSettings(s.settings, action.change) : action.settings;
              if (action.type === "settings" && s.settingsPatched && digest(s.settings) !== digest(next))
                throw new ApiError(409, "private_workday_changed", "Reopen the settings before changing activity sources.");
              if (digest(s.settings) !== digest(next))
                for (const job of workdaysRunning.get(path)?.values() ?? []) job.controller.abort();
              if (Boolean(s.settings.documents) !== Boolean(next.documents))
                s.documentEpoch++;
              if (digest([s.settings.model]) !== digest([next.model])) s.reconstruction = {};
              if (s.settings.model && !next.model) delete s.lastModel;
              s.settings = next;
              if (action.type === "settings-patch") s.settingsPatched = true;
            } else if (action.type === "instruction") {
              const rule = s.instructions[action.id];
              if (!rule) throw new ApiError(404, "private_workday_scope", "This saved instruction is unavailable.");
              if (action.text === null) delete s.instructions[action.id];
              else {
                rule.text = action.text;
                delete rule.replacement;
              }
            } else if (action.type === "guideline") {
              const g = action.guideline;
              const access = await backOfficeAccess(config);
              const state = await workdayContext(config, access, await workdayWorkspaces(config));
              if (!visibleGuideline(g, state) ||
                  (g.rules.minimumMinutes && g.rules.maxMinutes && g.rules.minimumMinutes > g.rules.maxMinutes))
                throw new ApiError(400, "private_workday_guideline", "Choose an available scope and a valid minimum and maximum.");
              const versions = s.guidelines[g.id] ?? [];
              const latest = versions.at(-1);
              if (g.revision !== (latest?.revision ?? 0) ||
                  (latest && (g.scope !== latest.scope || g.targetId !== latest.targetId)))
                throw new ApiError(409, "private_workday_changed", "This guideline changed. Reopen it before updating.");
              if (Object.values(s.guidelines).flat().some(version => version.id !== g.id && version.scope === g.scope &&
                  version.targetId === g.targetId && version.effectiveFrom === g.effectiveFrom))
                throw new ApiError(409, "private_workday_guideline", "A guideline already applies to this scope and effective date.");
              s.guidelines[g.id] = [...versions, { ...g, revision: g.revision + 1 }];
            } else if (action.type === "draft" || action.type === "draft-patch") {
              if (action.date && action.date !== date) throw new ApiError(409, "private_workday_changed", "The draft date changed.");
              const changes = action.type === "draft-patch" ? action.changes : action.values;
              if (s.pendingBookings[action.key] || s.draftClocks[action.key]?.booking?.pending) {
                if (unchangedPrivateDraft(s, action.key, date, action.proposalDigest, changes, action.type === "draft-patch")) return;
                throw new ApiError(409, "private_booking_pending", "This time entry is being saved. Retry the booking before making more changes.");
              }
              if (s.accepted[action.key] && !s.pendingBookings[action.key] && changes !== null) throw new ApiError(409, "private_already_booked", "This entry is already saved.");
              if (action.proposalDigest) {
                const proposal = s.days[date]?.find(item => item.proposal.key === action.key)?.proposal;
                if (!proposal || proposal.dismissed || proposal.digest !== action.proposalDigest) throw new ApiError(409, "private_workday_changed", "The suggestion changed.");
              }
              if (action.type === "draft-patch") patchPrivateDraft(s, action);
              else writePrivateDraft(s, date, action);
            } else if (action.type === "reconcile") {
              const item = s.days[date]?.find(row => row.proposal.key === action.key);
              const proposal = item?.proposal;
              const linked = s.reconciled[action.key], accepted = s.accepted[action.key];
              if (!item || !proposal || proposal.date !== date || proposal.dismissed || proposal.digest !== action.digest ||
                  proposalCommitment(proposal) !== action.digest ||
                  (linked ? linked !== action.recordId || accepted !== action.digest : accepted))
                throw new ApiError(409, "private_workday_changed", "The suggestion changed or was already booked.");
              if (linked) return;
              requireDraftRevision(s, action.key, action.draftRevision, date, action.digest);
              if (!eligibleSource(item, await connectedWorkdayAccounts(config), s.settings)) throw new ApiError(409, "private_workday_changed", "The source is unavailable.");
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
              if (!current || !eligibleSource(current, accounts, s.settings))
                throw new ApiError(409, "source_disabled", "This source is no longer enabled.");
              const access = await backOfficeAccess(config);
              const workspaces = await workdayWorkspaces(config);
              const state = await workdayContext(config, access, workspaces);
              const scopedRules = (matterId: string | null, projectId: string | null) => {
                if (projectId && !workspaces.some(workspace => workspace.id === projectId))
                  throw new ApiError(403, "private_workday_scope", "Choose an available project.");
                const matter = captureMatter({ ...current.proposal, projectId, matterId: matterId ?? undefined }, state);
                if (!matter && matterId) throw new ApiError(403, "private_workday_scope", "Choose an available matter for this project.");
                if (!matter) return;
                return draftRules(state, Object.values(s.guidelines).flat(), matter, date, projectId ?? undefined);
              };
              const first = scopedRules(action.matterId, action.projectId);
              const second = action.split ? scopedRules(action.split.matterId, action.split.projectId) : undefined;
              if (action.activity && !Object.hasOwn(timeActivities, action.activity) &&
                  (!Object.hasOwn(first?.activityLabels ?? {}, action.activity) || (action.split && !Object.hasOwn(second?.activityLabels ?? {}, action.activity))))
                throw new ApiError(400, "private_workday_input", "Choose an available activity code.");
              correctWorkday(s, date, action, Intl.DateTimeFormat().resolvedOptions().timeZone,
                (proposal, split) => proposedWorkdayCharge(proposal, split ? second : first),
                proposal => captureMatter(proposal, state)?.id);
            } else if (action.type === "dismiss") {
              const p = s.days[date]?.find((row) => row.proposal.key === action.key);
              if (!p || (action.digest && p.proposal.digest !== action.digest) || s.accepted[action.key])
                throw new ApiError(409, "private_workday_changed", "Refresh the proposal before dismissing it.");
              p.proposal.dismissed = true;
              delete s.drafts[action.key];
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
      const status = s.reconstruction[date]?.status;
      const generatedReady = Boolean(s.reconstruction[date]?.key) && status?.type === "ready";
      const day = s.days[date] ?? [];
      const workspaceIds = day.some(item => item.proposal.projectId)
        ? new Set((await workdayWorkspaces(config)).map(workspace => workspace.id)) : undefined;
      const proposals = day.filter(item => {
        const p = item.proposal;
        if (p.projectId && !workspaceIds?.has(p.projectId)) return false;
        if ((s.accepted[p.key] && !s.pendingBookings[p.key]) || p.dismissed || !eligibleSource(item, connections, s.settings)) return false;
        if (p.source !== "stopwatch") return item.generated || sourcePreview || protectedProposal(s, item);
        if (item.generated) return s.settings.stopwatchMode === "evidence" || protectedProposal(s, item);
        const covered = day.some(other => other.generated && other !== item && overlapsEvidence(item, other) &&
          (protectedProposal(s, other) || (s.settings.stopwatchMode === "evidence" && generatedReady)));
        return !covered && (protectedProposal(s, item) ||
          !(s.settings.stopwatchMode === "evidence" && generatedReady));
      });
      const result = options.jsonResponse({
        settings: s.settings,
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, draft]) => draft.date === date)),
        connections,
        modelReady: Boolean(await localModel()),
        chat: s.chat[date] ?? [],
        instructions: Object.values(s.instructions).map(({ entryKey, entryRevision, replacement, ...instruction }) => instruction),
        guidelines: Object.values(s.guidelines).flatMap(versions => versions.slice(-1)),
        status,
        proposals: proposals.map(({ proposal, generated }) => ({
          ...proposal,
          suggested: generated || undefined,
          versions: Object.values(s.originals).filter(p => p.key === proposal.key).map(p => p.digest),
        })),
      });
      if ((await profile(config)).path !== path)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      result.headers.set("Cache-Control", "no-store");
      return result;
    });
}
