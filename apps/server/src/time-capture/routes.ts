import { activeCaptureProfile as profile, captureProfile, timekeepingPreset } from "./profile.js";
export { captureProfile } from "./profile.js";
import { timeActivities } from "../back-office/timesheet-schema.js";
import { connectedWorkdayModel, generateConnectedTimeText } from "./connected-model.js";
import { localCaptureDocumentId, readActivityEvidence, type CaptureFileIdentity } from "./activity-workday.js";
import { desktopActivitySampleSchema, captureAccountEnabled, localWorkdayModel, type CaptureAccount, type WorkdayModel, type WorkdayGenerationProgress, workdayModelSchema, type CaptureState, privateEntryDraftSchema,
  workdayGuidelineActionSchema, workdayGuidelineSchema, workdayStatusSchema } from "../back-office/timesheet-schema.js";
import { BackOfficeValueSchema, canonicalBackOfficeAudit } from "../back-office/schema.js";
import { backOfficeStore } from "../back-office/store.js";
import { timeWorkspaces } from "../back-office/timesheet-data.js";
import { changeStopwatch, createStopwatchReader, emptyStopwatch, privateStopwatchSchema } from "./stopwatch.js";
import { renameSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { originalBillingComparison, originalCaptureProposal, proposalCommitment } from "./original.js";
import { correctWorkday } from "./correct-workday.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import {
  stopwatchActionSchema,
  stopwatchStateSchema,
  workdayCorrectionSchema,
  captureProposalSchema,
  captureSettingsSchema,
  workdaySchedule,
  captureSettingsPatchSchema,
  privateDraftPatchSchema,
  reconcileCaptureSchema,
} from "../back-office/timesheet-schema.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "../back-office/access.js";
import { nextOccurrence, wallTime } from "../scheduled-tasks/schedule.js";
import { addDays, dayInZone, zonedInstant } from "../calendar/dates.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { globalCalendarOccurrences } from "../calendar/service.js";
import { ApiError, findApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { addRoute, type Route } from "../routes/registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { documentEvidence, eligibleDocumentReference, eligibleFileReference } from "./document-workday.js";
import { claimsFor, claimsOverlap, digest, elapsedEvidence, workdayEvidence, workdayEvidenceSchema, type WorkdayEvidence } from "./private-workday.js";
import { connectedWorkdayAccounts, readConnectedWorkday, sourceAvailable } from "./connected-workday.js";
import { generateLocalTimeText, localModel, workdaySkill } from "./local-model.js";
import { modelInput, proposedWorkdayCharge, remainingEvidence } from "./reconstruct-workday.js";
import { acceptedDocumentEntry, captureMatter, draftRules, effectiveWorkdayGuidelines, modelEvidence, visibleGuideline, workdayContext, workdayWorkspaces } from "./workday-context.js";
import { readFileHistory, fileHistoryInput, importFileHistory } from "./desktop-file-history.js";
import { recordingEvidence, recordingInput } from "./meeting-recording.js";
import { readDesktopEvidence, recordDesktopSample, resetDesktopSampling, resolveDesktopForeground } from "./desktop-activity.js";
import { announceSyncChange } from "../app-sync-events.js";
import { chatSuggestions, workdayChatInstructions } from "./chat-workday.js";
import { chatWorkdayAction } from "./chat-workday-schema.js";
import { readWorkdayLog, saveWorkdayLog } from "./day-log.js";
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
  lastScheduledSlot: z.number().default(0),
  connectionNames: z.record(z.string(), z.string().max(320)).default({}),
  checkedThrough: z.record(z.iso.date(), z.iso.datetime()).default({}),
  days: z.record(z.iso.date(), z.array(workdayEvidenceSchema)),
  reconstruction: z.record(z.iso.date(), z.object({ key: z.string(), status: workdayStatusSchema })).default({}),
  reconstructionCache: z.record(z.iso.date(), z.record(z.string(), z.object({
    status: workdayStatusSchema, proposals: z.array(workdayEvidenceSchema).optional(),
  }))).default({}),
  proposalKeys: z.record(z.iso.date(), z.record(z.string(), z.uuid())).default({}),
  lastModel: workdayModelSchema.optional(),
  guidelines: z.record(z.uuid(), z.array(workdayGuidelineSchema)).default({}),
  fileProducts: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  pendingBookings: z.record(z.uuid(), z.boolean()).default({}),
  bookingRequests: z.record(z.uuid(), z.string()).default({}),
  fileHistoryRevision: z.record(z.iso.date(), z.string()).default({}),
  recordings: z.record(z.iso.date(), z.record(z.string(), workdayEvidenceSchema)).default({}),
  recordingEpoch: z.number().int().nonnegative().default(0),
  desktopHistoryEpoch: z.number().int().nonnegative().default(0),
  personalDriveEpoch: z.number().int().nonnegative().default(0),
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
  settings: { calendar: true, tasks: true, documents: true, workspaceActivity: true, stopwatchMode: "always" },
  settingsPatched: false,
  lastRun: 0,
  lastScheduledSlot: 0,
  connectionNames: {},
  checkedThrough: {},
  days: {},
  reconstruction: {},
  reconstructionCache: {},
  proposalKeys: {},
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
  personalDriveEpoch: 0,
  fileHistoryRevision: {},
  desktopHistoryEpoch: 0,
  recordings: {},
  recordingEpoch: 0,
});
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
export async function personalDriveConsent(config: ServerConfig, account: CaptureAccount) {
  const owner = await profile(config);
  const saved = await load(owner.path);
  if (saved.settings.enabled === false || !captureAccountEnabled(saved.settings, account)) throw new ApiError(409, "private_workday_changed", "The personal drive source changed.");
  return { path: owner.path, epoch: saved.personalDriveEpoch };
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
async function beginDocumentObservation(
  config: ServerConfig,
  ctx: { actor?: { type: string }; agentAccess?: unknown },
) {
  if (
    config.readOnly ||
    !loopback(config) ||
    ctx.agentAccess ||
    ctx.actor?.type !== "host"
  )
    return;
  try {
    const owner = await profile(config);
    const { path } = owner;
    const snapshot = await load(path);
    if (snapshot.settings.enabled === false || !snapshot.settings.documents) return;
    return async (observation: (owner: Awaited<ReturnType<typeof profile>>) => Promise<ReturnType<typeof documentEvidence>>) => {
      try {
        await withFileWriteLock(path, async () => {
          if ((await profile(config)).path !== path) return;
          const current = await load(path);
          if (current.settings.enabled === false || !current.settings.documents || current.documentEpoch !== snapshot.documentEpoch) return;
          const evidence = await observation(owner);
          if (!evidence || (await profile(config)).path !== path) return;
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

export async function beginDocumentCapture(
  config: ServerConfig, ctx: { actor?: { type: string }; agentAccess?: unknown }, projectId: string, reference: string,
) {
  if (!eligibleDocumentReference(reference)) return;
  const record = await beginDocumentObservation(config, ctx);
  if (record) return (before: CaptureFileIdentity | null, after: CaptureFileIdentity) =>
    record(async owner => {
      const id = await localCaptureDocumentId(config, owner, projectId, before, after);
      return id ? documentEvidence(projectId, reference, !before, new Date(), id) : undefined;
    });
}

/** Use only at a successful explicit host action. Reading, syncing, aborted writes and agent actions do not qualify. */
export async function beginFileAction(
  config: ServerConfig, ctx: { actor?: { type: string }; agentAccess?: unknown }, projectId: string,
  reference: string, scope: string, action: "Attached" | "Imported" | "Copied" | "Uploaded" | "Saved",
) {
  if (!eligibleFileReference(reference)) return;
  const record = await beginDocumentObservation(config, ctx);
  if (record) return () => record(async () => documentEvidence(projectId, reference, false, new Date(),
    digest([projectId, scope, reference]), action));
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
    if (saved.pendingBookings[key] || newBinding) {
      delete saved.pendingBookings[key];
      delete saved.drafts[key];
      await save(path, saved);
    }
    return result;
  });
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

function requireUnbooked(saved: Saved, item: WorkdayEvidence) {
  const conflict = (saved.days[item.proposal.date] ?? []).some(other =>
    other.proposal.key !== item.proposal.key && saved.accepted[other.proposal.key] && overlapsEvidence(item, other));
  if (conflict)
    throw new ApiError(409, "private_already_booked", "This source was already used for a saved time entry.");
}

type Profile = Awaited<ReturnType<typeof profile>>;
type ResolveWorkspace = (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
type StartChat = (profileId: string, date: string, requestId: string, model?: Pick<WorkdayModel, "providerID" | "modelID">) => Promise<void>;
type PreparationOptions = {
  signal?: AbortSignal;
  resolveWorkspace?: ResolveWorkspace;
  now?: () => number;
  scheduledSlot?: number;
  startChat?: StartChat;
  readConnected?: typeof readConnectedWorkday;
};
type RunningWorkday = {
  controller: AbortController; signal: AbortSignal; done: Promise<void>;
  progress?: Omit<WorkdayGenerationProgress, "proposals">;
  completedRows: WorkdayEvidence[];
  current?: (saved: Saved) => boolean;
};
const workdaysRunning = new Map<string, Map<string, RunningWorkday>>();
type Preparation = { type: "suggest" | "calendar"; model?: WorkdayModel; revisionRequest?: string; runId?: string };

function protectedProposal(s: Saved, item: WorkdayEvidence) {
  const p = item.proposal;
  return p.dismissed || Boolean(p.parentDigest || s.drafts[p.key] || s.accepted[p.key] || s.reconciled[p.key]);
}
/** Project the same keys and commitments for a read-only live preview and its eventual atomic save. */
function matchProposals(saved: Saved, date: string, proposed: WorkdayEvidence[]) {
  const old = saved.days[date] ?? [];
  const locked = old.filter(item => protectedProposal(saved, item));
  const byKey = new Map(old.map(item => [item.eventKey, item.proposal]));
  const stable = saved.proposalKeys[date] ?? {};
  return proposed.flatMap(item => {
    if (locked.some(other => overlapsEvidence(item, other))) return [];
    const proposal = { ...item.proposal, key: byKey.get(item.eventKey)?.key ?? stable[item.eventKey] ?? item.proposal.key };
    proposal.digest = proposalCommitment(proposal);
    return [{ ...item, proposal }];
  });
}

function applyProposals(saved: Saved, date: string, proposed: WorkdayEvidence[]) {
  const old = saved.days[date] ?? [];
  const locked = old.filter(item => protectedProposal(saved, item));
  const timers = old.filter(item => !item.generated && item.proposal.source === "stopwatch" && !protectedProposal(saved, item));
  const next = matchProposals(saved, date, proposed);
  const stable = saved.proposalKeys[date] ??= {};
  const byKey = new Map(old.map(item => [item.eventKey, item.proposal]));
  for (const { eventKey, proposal } of next) {
    stable[eventKey] = proposal.key;
    const original = byKey.get(eventKey);
    if (original) saved.originals[original.digest] = original;
    saved.originals[proposal.digest] = proposal;
  }
  saved.days[date] = [...next, ...locked, ...timers];
}

/** Retain both feeds in the local log but give inference one occurrence, preferring the LegalWork calendar's project link. */
function uniqueOccurrences(observations: WorkdayEvidence[]) {
  const seen = new Map<string, WorkdayEvidence>();
  for (const observation of observations) {
    const previous = seen.get(observation.eventKey);
    if (!previous || observation.proposal.source === "calendar" || observation.proposal.mailDirection === "sent") seen.set(observation.eventKey, observation);
  }
  return [...seen.values()];
}

function rawProposals(evidence: WorkdayEvidence[]) {
  const group = new Map<string, WorkdayEvidence>();
  for (const item of evidence) {
    const p = item.proposal;
    if (p.source === "agent" || p.source === "workspace" || p.source === "desktop" || p.mailDirection === "received") continue;
    if (p.source !== "documents" || !p.documentId) { group.set(item.eventKey, item); continue; }
    const eventKey = digest(["document-day", p.date, p.documentId]);
    const previous = group.get(eventKey);
    const proposal = previous && (previous.proposal.observedAt ?? "") <= (p.observedAt ?? "") ? previous.proposal : p;
    group.set(eventKey, { eventKey, proposal, claims: [...(previous?.claims ?? []), ...claimsFor(item)] });
  }
  return [...group.values()];
}

async function modelChoice(config: ServerConfig, owner: Profile, profile: Pick<Saved, "settings" | "lastModel">,
  workspaces: WorkspaceInfo[], signal: AbortSignal, requested?: WorkdayModel, passive = false): Promise<WorkdayModel> {
  const { settings, lastModel } = profile;
  const explicit = settings.model ?? requested;
  if (explicit && localChoice(explicit)) return localWorkdayModel;
  // Older empty-day runs could record llama.cpp as their last model despite
  // never using it. Only a current user preference may pin an unavailable runtime.
  if (!explicit && lastModel && localChoice(lastModel) && await localModel()) return localWorkdayModel;
  const choices = [settings.model, requested, lastModel].filter(choice => !!choice).filter(choice =>
    !localChoice(choice) && (!explicit || choice.providerID === explicit.providerID));
  const privateProject = workspaces.find(item => item.preset === timekeepingPreset(owner.profileId));
  if (explicit) {
    // The same provider ID can refer to different private endpoints in two
    // projects. Only a new composer choice authorizes re-binding a saved one.
    const id = explicit.workspaceId ?? (lastModel?.providerID === explicit.providerID ? lastModel.workspaceId : undefined);
    const workspace = id ? workspaces.find(item => item.id === id)
      : privateProject ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (!workspace) return localWorkdayModel;
    return await connectedWorkdayModel(config, [workspace], choices, signal, passive, explicit.providerID) ?? localWorkdayModel;
  }
  const candidates = [
    privateProject,
    ...choices.map(choice => workspaces.find(item => item.id === choice.workspaceId)),
  ].filter(workspace => !!workspace);
  const assistant = workspaces.find(item => item.preset === "main-assistant");
  const initialProject = !candidates.length && workspaces.find(item => item !== assistant);
  if (assistant) candidates.push(assistant);
  if (initialProject) candidates.push(initialProject);
  return await connectedWorkdayModel(config, [...new Set(candidates)], choices, signal, passive) ?? localWorkdayModel;
}
function localChoice(choice: Pick<WorkdayModel, "providerID" | "modelID">) {
  return choice.providerID === localWorkdayModel.providerID && choice.modelID === localWorkdayModel.modelID;
}

/** Store only application-owned reasons. Native/provider errors may contain the original private request. */
export function workdayModelFailure(error: unknown, deadlineExpired: boolean): NonNullable<CaptureState["status"]> {
  const api = findApiError(error);
  const upstream = api?.code === "opencode_request_failed" ? z.object({ status: z.number() }).safeParse(api.details).data?.status : undefined;
  const status = upstream ?? api?.status;
  if (deadlineExpired || (error instanceof DOMException && error.name === "TimeoutError") || status === 408 || status === 504) {
    return { type: "failed", reason: "timeout", message: "Preparing workday suggestions timed out. Retry or choose another model." };
  }
  if (api?.code === "timesheet_model_unavailable" || api?.code === "assistant_subscription_required")
    return { type: "unavailable", reason: "model_unavailable", message: "Choose an available model in the timekeeping chat composer." };
  if (api?.code === "timesheet_model_format")
    return { type: "failed", reason: "invalid_output", message: "The model's suggestions did not match the recorded activity or the required format." };
  if (api && ["timesheet_model_request", "timesheet_model_failed", "opencode_unavailable", "opencode_request_failed"].includes(api.code))
    return { type: "failed", reason: "provider_failed", message: "The selected model could not complete the request. Check its connection and retry." };
  return { type: "failed", message: "The workday could not be prepared. Retry the suggestion run." };
}

async function collectDay(config: ServerConfig, owner: Profile, date: string, zone: string, initial: Saved,
  workspaces: WorkspaceInfo[], signal: AbortSignal, withModel: boolean, readConnected = readConnectedWorkday) {
  const settings = initial.settings;
  const workspacesById = new Set(workspaces.map(workspace => workspace.id));
  const account = settings.calendar ? (await readEigenweltConnection(config)).account : null;
  const events = settings.calendar
    ? await globalCalendarOccurrences(config, addDays(date, -1), addDays(date, 2), workspaces, { calendar: true, tasks: false,
      worker: { userId: owner.captureUser, email: account?.userId === owner.captureUser ? account.userEmail : null } })
    : [];
  let sourceFailure = false;
  const failedAccounts: (CaptureAccount & { reason: string })[] = [];
  const names: Record<string, string> = {};
  const scannedAccounts: CaptureAccount[] = [];
  const imported = await readConnected(config, settings, date, signal, {
    onFailed: ({ provider, account }, reason) => { failedAccounts.push({ provider, account, reason }); },
    onName: ({ account }, name) => { names[account] = name; },
    onRead: ({ provider, account }) => { scannedAccounts.push({ provider, account }); },
  }).catch(error => {
    if (!withModel || signal.aborted) throw error;
    sourceFailure = true;
    return [];
  });
  const evidence = [...imported, ...workdayEvidence(events, date, settings, owner.captureUser, zone),
    ...await readActivityEvidence(config, owner, date, zone, signal),
    ...(settings.desktopActivity ? await readDesktopEvidence(owner, date, zone) : []),
    ...(settings.desktopActivity ? await readFileHistory(owner.path, date) : [])];
  if (settings.recordings) evidence.push(...Object.values(initial.recordings[date] ?? {}));
  if (settings.documents)
    for (const [eventKey, proposal] of Object.entries(initial.documentSaves[date] ?? {})) evidence.push({ eventKey, proposal });
  if (withModel) {
    for (const item of initial.days[date] ?? []) {
      if (item.generated || item.proposal.source !== "stopwatch") continue;
      const proposal = originalCaptureProposal(item.proposal, item.proposal.digest, initial.originals);
      evidence.push({ eventKey: item.eventKey, proposal });
    }
  }
  const from = (item: WorkdayEvidence) => item.proposal.startAt ?? item.proposal.observedAt ?? "";
  const eligible = evidence.filter(item => !item.proposal.projectId || workspacesById.has(item.proposal.projectId))
    .sort((a, b) => from(a).localeCompare(from(b)) || a.eventKey.localeCompare(b.eventKey));
  return { eligible, sourceFailure, failedAccounts, scannedAccounts, names };
}

async function prepare(config: ServerConfig, owner: Profile, date: string, action: Preparation,
  { signal: requestSignal, resolveWorkspace, now = Date.now, scheduledSlot, readConnected = readConnectedWorkday }: PreparationOptions = {}) {
  const { path } = owner;
  let days = workdaysRunning.get(path);
  if (!days) { days = new Map(); workdaysRunning.set(path, days); }
  let previous;
  while ((previous = days.get(date))) {
    if (requestSignal?.aborted) return;
    const same = action.runId && action.runId === previous.progress?.runId;
    await previous.done;
    if (same) return;
  }
  if (requestSignal?.aborted) return;
  // The previous call can remove an empty map while another window waits.
  workdaysRunning.set(path, days);
  const controller = new AbortController();
  const timeout = AbortSignal.timeout(150_000);
  const signal = AbortSignal.any([controller.signal, timeout, ...(requestSignal ? [requestSignal] : [])]);
  const { promise, resolve } = Promise.withResolvers<void>();
  const job: RunningWorkday = { controller, signal, done: promise, completedRows: [],
    progress: action.runId ? { runId: action.runId, date, phase: "collecting", completed: 0, total: null } : undefined };
  days.set(date, job);
  const verifyProfile = async () => {
    if ((await profile(config)).path !== path)
      throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
  };
  try {
    const started = now();
    const initial = await load(path);
    if (initial.settings.enabled === false) {
      if (scheduledSlot !== undefined) return;
      throw new ApiError(409, "time_tracking_disabled", "Turn on Time tracking in Settings.");
    }
    if (scheduledSlot !== undefined && initial.lastScheduledSlot >= scheduledSlot) return;
    const workspaces = await workdayWorkspaces(config);
    const access = await backOfficeAccess(config);
    if ((await captureProfile(config, access)).path !== path) return;
    let state: Awaited<ReturnType<typeof workdayContext>> | undefined;
    const context = async () => state ??= await workdayContext(config, access, workspaces);
    const settings = initial.settings;
    const withModel = action.type !== "calendar";
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let choice = localWorkdayModel;
    if (withModel && date > dayInZone(new Date(started).toISOString(), zone))
      throw new ApiError(400, "future_workday", "Choose today or an earlier date to generate suggestions.");
    const workspacesById = new Set(workspaces.map(workspace => workspace.id));
    const { eligible, sourceFailure, failedAccounts, scannedAccounts, names } = await collectDay(
      config, owner, date, zone, initial, workspaces, signal, withModel, readConnected);
    const inputs = (s: Saved) => digest([s.settings, s.guidelines, s.fileProducts, s.fileHistoryRevision[date], s.settings.recordings ? Object.keys(s.recordings[date] ?? {}) : []]);
    const revision = inputs(initial);
    job.current = saved => inputs(saved) === revision;
    let key = "";
    let usedModel = false;
    const verify = async () => {
      signal.throwIfAborted();
      await verifyProfile();
      if (inputs(await load(path)) !== revision)
        throw new ApiError(409, "private_workday_changed", "The activity sources or draft instructions changed.");
    };
    const commit = async (status: NonNullable<CaptureState["status"]>, proposals?: WorkdayEvidence[]) => {
      await withFileWriteLock(path, async () => {
        if (requestSignal?.aborted || controller.signal.aborted) return;
        if (status.type === "ready") timeout.throwIfAborted();
        if (job.progress && status.type === "ready") job.progress.phase = "saving";
        const current = await load(path);
        await verifyProfile();
        if (inputs(current) !== revision) return;
        Object.assign(current.connectionNames, names);
        if (failedAccounts.length) {
          // The journal keeps successful observations. Previously reviewed drafts stay authoritative until a complete run.
          proposals = undefined;
          const failedSources = failedAccounts.map(({ provider, account }) => ({ provider, account, name: current.connectionNames[account] }));
          const labels = failedSources.map(item => item.provider + (item.name ? " (" + item.name + ")" : ""));
          const failedModel = status.type !== "ready" && status.message ? " " + status.message : "";
          status = { type: "failed", reason: status.type === "ready" ? "sources_failed" : status.reason, failedSources,
            message: "Could not check " + labels.join(", ") + ". Retry to complete this day." + failedModel };
        }
        if (proposals) applyProposals(current, date, proposals);
        current.lastRun = now();
        if (scheduledSlot !== undefined) current.lastScheduledSlot = scheduledSlot;
        if (status.type === "ready" && withModel)
          current.checkedThrough[date] = new Date(started).toISOString();
        current.reconstruction[date] = { key, status };
        if (key && withModel && !failedAccounts.length) {
          const { [key]: previous, ...cache } = current.reconstructionCache[date] ?? {};
          current.reconstructionCache[date] = Object.fromEntries([
            ...Object.entries(cache).slice(-11), [key, { status, proposals: proposals ?? previous?.proposals }],
          ]);
          if (status.type === "ready" && usedModel) current.lastModel = choice;
        }
        await save(path, current, async () => {
          await verifyProfile();
          return () => {
            requestSignal?.throwIfAborted();
            controller.signal.throwIfAborted();
            if (status.type === "ready") timeout.throwIfAborted();
          };
        });
      });
    };
    if (sourceFailure) {
      await commit(timeout.aborted ? workdayModelFailure(undefined, true)
        : { type: "failed", reason: "sources_failed", message: "A selected activity source could not be read. Check its connection and retry." });
      return;
    }
    if (!withModel) {
      const raw = rawProposals(uniqueOccurrences(eligible));
      await commit({ type: "ready", message: "Activity sources refreshed." }, raw);
      return;
    }
    // Save new observations before inference. A failed feed preserves its own prior observations.
    const observed = await withFileWriteLock(path, async () => {
      await verify();
      return saveWorkdayLog(path, date, zone, new Date(started).toISOString(), eligible, failedAccounts, scannedAccounts);
    });
    if (failedAccounts.length) {
      await commit({ type: "failed", reason: "sources_failed", message: "" });
      return;
    }
    try {
      choice = await modelChoice(config, owner, initial, workspaces, signal, "model" in action ? action.model : undefined);
      const runtime = localChoice(choice) ? await localModel() : null;
      const skill = await workdaySkill(workspaces.find(item => item.preset === timekeepingPreset(owner.profileId)));
      const elapsed = resolveDesktopForeground(elapsedEvidence(uniqueOccurrences(observed), date, zone, started));
      // Delivery alone establishes no human action. Give the model inbound context only for a thread the worker replied to.
      const sentThreads = new Set(elapsed.filter(row => row.proposal.mailDirection === "sent").map(row => row.proposal.threadKey));
      const actionable = elapsed.filter(({ proposal }) =>
        (proposal.source !== "stopwatch" || settings.stopwatchMode === "evidence") &&
        (proposal.mailDirection !== "received" || !!proposal.threadKey && sentThreads.has(proposal.threadKey)));
      const all = modelEvidence(actionable, await context(), Object.values(initial.guidelines).flat(),
        date, initial.fileProducts);
      const transcript = action.revisionRequest ? [action.revisionRequest] : [];
      key = digest(["workday-reconstruction-v8", date, zone, choice, runtime?.fingerprint, skill, modelInput(all),
        all.map(ref => [claimsFor(ref.item), ref.item.proposal.workProductId]), transcript]);
      const cached = initial.reconstructionCache[date]?.[key];
      if (!failedAccounts.length && cached?.status.type === "ready") {
        // Identical sources reuse proposals, but the schedule still completed a source check.
        await commit(cached.status, initial.reconstruction[date]?.key === key ? undefined : cached.proposals);
        return;
      }
      const excluded = (initial.days[date] ?? []).filter(item => protectedProposal(initial, item));
      const remaining = remainingEvidence(all, excluded);
      if (remaining.length && localChoice(choice) && !runtime) {
        await commit({ type: "unavailable", reason: "model_unavailable", message: "Choose an available model in the timekeeping chat composer." });
        return;
      }
      const currentDraft = action.revisionRequest ? (initial.days[date] ?? []).flatMap(item => {
        if (protectedProposal(initial, item)) return [];
        const evidenceIds = remaining.filter(ref => overlapsEvidence(ref.item, item)).map(ref => ref.item.eventKey);
        if (!evidenceIds.length) return [];
        const { key, matterId, projectId, documentId, activity, startAt, endAt, workedMinutes, estimatedMinutes, estimateReason } = item.proposal;
        return [{ key, evidenceIds, matterId, projectId, documentId, activity, startAt, endAt, workedMinutes, estimatedMinutes, estimateReason }];
      }) : undefined;
      const workspace = remaining.length && !runtime
        ? resolveWorkspace ? await resolveWorkspace(config, choice.workspaceId) : workspaces.find(entry => entry.id === choice.workspaceId)
        : undefined;
      if (remaining.length && !runtime && (!workspace || !workspacesById.has(workspace.id)))
        throw new ApiError(409, "timesheet_model_unavailable", "Choose a model from an available workspace.");
      if (job.progress) job.progress.phase = "grouping";
      const proposals = await generateStructuredWorkday({ skill, evidence: remaining, date, zone, transcript, currentDraft,
        onWording: job.progress ? async (total, batch) => {
          await verify();
          job.completedRows.push(...batch);
          Object.assign(job.progress!, { phase: "wording", completed: job.completedRows.length, total });
        } : undefined,
        generate: async prompt => {
          await verify();
          usedModel = true;
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
      await commit(workdayModelFailure(error, timeout.aborted));
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
  if (options.signal?.aborted || config.readOnly || !loopback(config)) return;
  const owner = await profile(config);
  const { settings, lastScheduledSlot } = await load(owner.path);
  if (settings.enabled === false) return;
  const now = (options.now ?? Date.now)();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = wallTime(new Date(now).toISOString(), timeZone);
  const date = local.slice(0, 10);
  const schedule = workdaySchedule(settings);
  let slot: number;
  if (schedule.frequency === "hourly") {
    slot = now - Number(local.slice(14, 16)) * 60_000 - now % 60_000;
  } else {
    const startAt = zonedInstant(date, timeZone);
    const after = Date.parse(startAt) - 1;
    // Use Scheduled Tasks' wall-clock recurrence, including its DST gap/fold rules.
    const slots = schedule.times.map(time => nextOccurrence({
      kind: "rrule", startAt, timeZone,
      rrule: `FREQ=DAILY;BYHOUR=${Number(time.slice(0, 2))};BYMINUTE=${Number(time.slice(3))}`,
    }, after)).flatMap(instant => instant ? [Date.parse(instant)] : []).filter(slot => slot <= now);
    if (!slots.length) return;
    slot = Math.max(...slots);
  }
  if (slot <= lastScheduledSlot) return;
  if (options.startChat) {
    await options.startChat(owner.profileId, date, "timekeeping-schedule-" + slot, settings.model);
    await withFileWriteLock(owner.path, async () => {
      const saved = await load(owner.path);
      saved.lastScheduledSlot = Math.max(saved.lastScheduledSlot, slot);
      await save(owner.path, saved);
    });
  } else await prepare(config, owner, date, { type: "suggest" }, { ...options, scheduledSlot: slot });
}

async function visibleProposals(config: ServerConfig, s: Saved, date: string, connections: CaptureState["connections"], sourcePreview: boolean) {
  const status = s.reconstruction[date]?.status;
  const generatedReady = Boolean(s.reconstruction[date]?.key) && status?.type === "ready";
  const day = s.days[date] ?? [];
  const workspaceIds = day.some(item => item.proposal.projectId)
    ? new Set((await workdayWorkspaces(config)).map(workspace => workspace.id)) : undefined;
  return day.filter(item => {
    const p = item.proposal;
    if (s.settings.enabled === false && (p.source !== "stopwatch" || item.generated)) return false;
    if (p.projectId && !workspaceIds?.has(p.projectId)) return false;
    if ((s.accepted[p.key] && !s.pendingBookings[p.key]) || p.dismissed || !eligibleSource(item, connections, s.settings)) return false;
    if (p.source !== "stopwatch") return item.generated || sourcePreview || protectedProposal(s, item);
    if (item.generated) return s.settings.stopwatchMode === "evidence" || protectedProposal(s, item);
    const covered = day.some(other => other.generated && other !== item && overlapsEvidence(item, other) &&
      (protectedProposal(s, other) || (s.settings.stopwatchMode === "evidence" && generatedReady)));
    return !covered && (protectedProposal(s, item) ||
      !(s.settings.stopwatchMode === "evidence" && generatedReady));
  });
}

async function readWorkdayProgress(config: ServerConfig, owner: Profile, date: string, runId: string): Promise<WorkdayGenerationProgress | null> {
  const running = () => workdaysRunning.get(owner.path)?.get(date);
  const job = running();
  if (!job?.progress || job.progress.runId !== runId || job.signal.aborted) return null;
  const saved = await load(owner.path);
  if (saved.settings.enabled === false || (job.current && !job.current(saved))) return null;
  const snapshot = { ...job.progress };
  const batch = [...job.completedRows];
  let proposals: WorkdayGenerationProgress["proposals"] = [];
  if (batch.length) {
    const accounts = await connectedWorkdayAccounts(config);
    const workspaces = new Set((await workdayWorkspaces(config)).map(workspace => workspace.id));
    const existing = await visibleProposals(config, saved, date, accounts, false);
    proposals = matchProposals(saved, date, batch).filter(item =>
      (!item.proposal.projectId || workspaces.has(item.proposal.projectId)) && eligibleSource(item, accounts, saved.settings) &&
      !existing.some(prior => prior.proposal.key !== item.proposal.key && overlapsEvidence(prior, item)))
      .map(({ proposal }) => ({ ...proposal, suggested: true }));
  }
  if ((await profile(config)).path !== owner.path || job.signal.aborted || running() !== job) return null;
  return { ...snapshot, proposals };
}

export function registerWorkdayRoutes(options: {
  startChat?: StartChat;
  routes: Route[];
  config: ServerConfig;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  jsonResponse: (d: unknown) => Response;
  ensureWritable: (config: ServerConfig) => void;
  readJsonBodyLimited: (request: Request, max: number) => Promise<Record<string, unknown>>;
}) {
  const { routes, config } = options;
  const readStopwatch = createStopwatchReader();
  for (const method of ["GET", "POST"]) addRoute(routes, method, "/private-timesheet/meeting-recording", "host-token", async ctx => {
    if (!loopback(config) || ctx.agentAccess) throw new ApiError(403, "private_activity", "Open your local desktop.");
    const owner = await profile(config);
    const input = method === "POST" ? recordingInput.safeParse(await options.readJsonBodyLimited(ctx.request, 4096)) : undefined;
    if (input && !input.success) throw new ApiError(400, "invalid_recording", "Invalid recording times or title.");
    return withFileWriteLock(owner.path, async () => {
      const saved = await load(owner.path);
      const enabled = saved.settings.enabled !== false && saved.settings.recordings === true;
      const consent = { profileId: owner.profileId, enabled, epoch: saved.recordingEpoch };
      if ((await profile(config)).path !== owner.path) throw new ApiError(409, "private_workday_changed", "The active account changed.");
      if (!input) return options.jsonResponse(consent);
      options.ensureWritable(config);
      if (!enabled || input.data.profileId !== consent.profileId || input.data.epoch !== consent.epoch)
        throw new ApiError(409, "private_workday_changed", "Meeting recording consent changed.");
      const row = input.data;
      const projectId = row.projectId && (await workdayWorkspaces(config)).some(project => project.id === row.projectId) ? row.projectId : null;
      let added = 0;
      for (const item of recordingEvidence({ ...row, projectId }, Intl.DateTimeFormat().resolvedOptions().timeZone)) {
        const date = item.proposal.date;
        const items = saved.recordings[date] ??= {};
        if (items[item.eventKey]) continue;
        items[item.eventKey] = item;
        delete saved.checkedThrough[date];
        added++;
      }
      if (added) await save(owner.path, saved);
      return options.jsonResponse({ added });
    });
  });
  for (const method of ["GET", "POST"]) addRoute(routes, method, "/private-timesheet/desktop-history", "host-token", async ctx => {
    if (!loopback(config) || ctx.agentAccess) throw new ApiError(403, "private_activity", "Open your local desktop.");
    const owner = await profile(config);
    if (owner.profileId !== ctx.url.searchParams.get("profileId")) throw new ApiError(409, "private_workday_changed", "The active account changed.");
    return withFileWriteLock(owner.path, async () => {
      const saved = await load(owner.path);
      if (saved.settings.enabled === false || !saved.settings.desktopActivity) throw new ApiError(403, "desktop_activity_disabled", "Turn on desktop activity in Time tracking.");
      if ((await profile(config)).path !== owner.path) throw new ApiError(409, "private_workday_changed", "The active account changed.");
      if (method === "GET") return options.jsonResponse({ epoch: saved.desktopHistoryEpoch });
      options.ensureWritable(config);
      const input = fileHistoryInput.safeParse(await options.readJsonBodyLimited(ctx.request, 256_000));
      if (!input.success) throw new ApiError(400, "invalid_desktop_history", "Invalid file-use records.");
      if (input.data.epoch !== saved.desktopHistoryEpoch) throw new ApiError(409, "private_workday_changed", "Desktop activity settings changed.");
      const { imported, revision } = await importFileHistory(owner.path, input.data, Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (revision && revision !== saved.fileHistoryRevision[input.data.date]) {
        saved.fileHistoryRevision[input.data.date] = revision;
        delete saved.checkedThrough[input.data.date];
        await save(owner.path, saved);
      }
      return options.jsonResponse({ imported });
    });
  });
  addRoute(routes, "POST", "/private-timesheet/desktop-activity", "host-token", async ctx => {
    if (!loopback(config) || ctx.agentAccess) throw new ApiError(403, "private_activity", "Open your local desktop.");
    options.ensureWritable(config);
    const owner = await profile(config);
    if ((["profileId", "scope", "principal", "user"] as const).some(field => ctx.url.searchParams.get(field) !== owner[field]))
      throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
    const sample = desktopActivitySampleSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 4096));
    if (!sample.success) throw new ApiError(400, "invalid_desktop_sample", "Invalid desktop activity sample.");
    if (!ctx.request.signal.aborted) await recordDesktopSample(config, owner, sample.data);
    return options.jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/workspace/:id/timekeeping/workday", "client", async ctx => {
    const owner = await profile(config);
    const workspace = config.workspaces.find(item => item.id === ctx.params.id);
    if (!loopback(config) || !workspace || workspace.preset !== timekeepingPreset(owner.profileId)
      || !ctx.agentAccess || ctx.agentAccess.workspace?.id !== workspace.id || ctx.actor?.scope !== "owner")
      throw new ApiError(403, "private_workday", "Use this tool from your local Timekeeping project chat.");
    const input = chatWorkdayAction.parse(await options.readJsonBodyLimited(ctx.request, 160_000));
    const { date } = input;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    if (date > dayInZone(now.toISOString(), zone)) throw new ApiError(400, "future_workday", "Choose today or an earlier date.");
    const initial = await load(owner.path);
    if (initial.settings.enabled === false) throw new ApiError(403, "timekeeping_disabled", "Turn on time tracking in Settings.");
    const workspaces = await workdayWorkspaces(config);
    const workspaceIds = new Set(workspaces.map(item => item.id));
    const state = await workdayContext(config, await backOfficeAccess(config), workspaces);
    const accounts = await connectedWorkdayAccounts(config);
    const visibleInputs = (s: Saved) => digest([s.settings, s.guidelines, s.fileProducts, s.fileHistoryRevision[date],
      s.documentEpoch, s.desktopHistoryEpoch, s.recordingEpoch, s.personalDriveEpoch]);
    const collection = input.action === "read" ? await collectDay(config, owner, date, zone, initial, workspaces,
      ctx.request.signal, true) : undefined;
    const result = await withFileWriteLock(owner.path, async () => {
      const saved = await load(owner.path);
      if ((await profile(config)).path !== owner.path || visibleInputs(saved) !== visibleInputs(initial))
        throw new ApiError(409, "private_workday_changed", "The account or activity sources changed. Read the day again.");
      const versions = Object.values(saved.guidelines).flat();
      const guidance = (matterId: string) => {
        const matter = state.matters.find(m => m.id === matterId);
        if (!matter) throw new ApiError(404, "unknown_matter", "Choose an accessible matter.");
        const clientId = matter.clientIds.length === 1 ? matter.clientIds[0] : "";
        const guidelines = effectiveWorkdayGuidelines(state, versions, { clientId, matterId, date })
          .map(({ name, scope, effectiveFrom, revision, rules }) => ({ name, scope, effectiveFrom, revision, rules }));
        const projects = state.projects.filter(p => p.matterIds.includes(matter.id) && workspaceIds.has(p.id));
        const rules = draftRules(state, versions, matter, date);
        const projectRules = projects.map(p => ({ projectId: p.id, rules: draftRules(state, versions, matter, date, p.id) }));
        return { matter: matter.name, guidelines, rules, projectRules, receipt: digest([owner.profileId, date, matterId, guidelines, rules, projectRules]) };
      };
      if (input.action === "guidelines") return guidance(input.matterId);
      if (collection) {
        if (collection.sourceFailure) throw new ApiError(503, "sources_failed", "A selected source could not be read. Retry the day.");
        await saveWorkdayLog(owner.path, date, zone, now.toISOString(), collection.eligible, collection.failedAccounts, collection.scannedAccounts);
      }
      const log = await readWorkdayLog(owner.path, date);
      const sourceRows = resolveDesktopForeground(elapsedEvidence(uniqueOccurrences(log.observations), date, zone, Date.parse(log.collectedAt)));
      const sent = new Set(sourceRows.filter(row => row.proposal.mailDirection === "sent").map(row => row.proposal.threadKey));
      const all = modelEvidence(sourceRows.filter(row => eligibleSource(row, accounts, saved.settings) &&
        (!row.proposal.projectId || workspaceIds.has(row.proposal.projectId)) &&
        (row.proposal.source !== "stopwatch" || saved.settings.stopwatchMode === "evidence") &&
        (row.proposal.mailDirection !== "received" || Boolean(row.proposal.threadKey && sent.has(row.proposal.threadKey)))),
        state, versions, date, saved.fileProducts);
      const day = saved.days[date] ?? [];
      const available = remainingEvidence(all, day.filter(i => protectedProposal(saved, i)));
      const entries = state.entries.filter(e => e.date === date && e.workerId === state.userId).map(e => ({
        id: e.id, matterId: e.matterId, narrative: e.narrative, recordedMinutes: e.workedMinutes, billableMinutes: e.billableMinutes,
        startAt: e.startAt, endAt: e.endAt, status: e.status,
      }));
      const revision = () => digest([visibleInputs(saved), log.collectedAt, entries, available.map(ref => [ref.item.eventKey, claimsFor(ref.item), ref.matter?.id]),
        (saved.days[date] ?? []).map(i => [i.eventKey, i.proposal.digest, protectedProposal(saved, i)])]);
      if (input.action === "read") {
        const rows = await visibleProposals(config, saved, date, accounts, false);
        const availableKeys = new Set(available.map(ref => ref.item.eventKey));
        return { date, zone, revision: revision(), failedSources: log.failedAccounts, instructions: workdayChatInstructions,
          activityCodes: timeActivities,
          observations: modelInput(available).map(({rules, priorDescriptions, ...facts}, i) => ({ ...facts, id: "e" + (i + 1) })),
          claimedObservations: modelInput(all.filter(ref => !availableKeys.has(ref.item.eventKey))).map(ref => ({ source: ref.source, title: ref.title, status: ref.status, agentVisibility: ref.agentVisibility, startAt: ref.startAt, endAt: ref.endAt })),
          existingEntries: entries, suggestions: rows.map(i => ({ key: i.proposal.key, matterId: i.proposal.matterId, narrative: i.proposal.narrative,
            startAt: i.proposal.startAt, endAt: i.proposal.endAt, recordedMinutes: i.proposal.workedMinutes, billableMinutes: i.proposal.chargeMinutes,
            editable: Boolean(i.generated && !protectedProposal(saved, i)), draft: saved.drafts[i.proposal.key]?.values,
            evidence: available.flatMap((ref,j) => overlapsEvidence(ref.item, i) ? ["e" + (j+1)] : []) })) };
      }
      options.ensureWritable(config);
      if (input.revision !== revision()) throw new ApiError(409, "private_workday_changed", "The day changed. Read the day again before publishing.");
      if (log.failedAccounts.length && input.complete) throw new ApiError(409, "sources_failed", "Some selected sources could not be checked. Refresh the day before marking it complete.");
      const added = chatSuggestions(input.suggestions, available, date, zone);
      for (const id of new Set(added.flatMap(i => i.proposal.matterId ?? [])))
        if (!input.guidelineReceipts?.includes(guidance(id).receipt)) throw new ApiError(409, "workday_guidelines", "Read the guidelines for each assigned matter and include its current receipt.");
      const removable = day.filter(i => i.generated && !protectedProposal(saved, i));
      const remove = new Set(input.remove ?? []);
      if ([...remove].some(key => !removable.some(i => i.proposal.key === key)))
        throw new ApiError(409, "private_workday_changed", "Only unedited suggestions from this day can be replaced.");
      const keep = removable.filter(old => !remove.has(old.proposal.key) && !added.some(row => overlapsEvidence(row, old)));
      applyProposals(saved, date, [...keep, ...added]);
      if (input.complete) {
        saved.checkedThrough[date] = log.collectedAt;
        saved.reconstruction[date] = { key: digest(["chat", date, log.collectedAt]), status: { type: "ready", message: "Workday suggestions updated." } };
      }
      await save(owner.path, saved);
      announceSyncChange(config, "backOffice");
      return { published: added.length, complete: Boolean(input.complete), revision: revision() };
    });
    return options.jsonResponse(result);
  });
  for (const method of ["GET", "POST"])
    addRoute(routes, method, "/private-timesheet/stopwatch", "host-token", async (ctx) => {
      if (!loopback(config) || ctx.agentAccess)
        throw new ApiError(403, "private_workday", "Open the stopwatch on your local LegalWork server.");
      const access = await backOfficeAccess(config);
      const { path, profileId } = await captureProfile(config, access);
      const expected = ctx.url.searchParams.get("profileId");
      if ((method === "POST" || expected !== null) && expected !== profileId)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const command = method === "POST" ? stopwatchActionSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 16_384)) : undefined;
      if (command && !command.success)
        throw new ApiError(400, "stopwatch_action", "Start or reassign the stopwatch with a matter, or stop the current timer.");
      const action = command?.data;
      const snapshot = await readStopwatch(path);
      const requireEnabled = (enabled: boolean, active: typeof snapshot.active) => {
        if (!enabled && (action?.type === "start" || (action?.type === "assign" && active?.matterId)))
          throw new ApiError(409, "time_tracking_disabled", "Time tracking is turned off.");
      };
      requireEnabled(snapshot.enabled, snapshot.active);
      // Polling the clock must not repeatedly fetch the firm's directory.
      const listMatters = ctx.url.searchParams.get("includeMatters") === "1";
      const matters = (listMatters && (snapshot.enabled || snapshot.active)) || (action && action.type !== "stop")
        ? (await workdayContext(config, access, [])).matters.map(({ id, name, reference }) => ({
            id, name: reference ? name + " · " + reference : name,
          }))
        : undefined;
      let timer = snapshot;
      if (action) {
        options.ensureWritable(config);
        if (action.type !== "stop" && !matters?.some(matter => matter.id === action.matterId))
          throw new ApiError(404, "stopwatch_matter", "Choose an available matter.");
        timer = await withFileWriteLock(path, async () => {
          const saved = await load(path);
          if ((await profile(config)).path !== path)
            throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
          requireEnabled(saved.settings.enabled !== false, saved.stopwatch.active);
          changeStopwatch(saved, action, new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
          await save(path, saved);
          return { ...saved.stopwatch, enabled: saved.settings.enabled !== false };
        });
      }
      if ((await profile(config)).path !== path)
        throw new ApiError(409, "private_workday_changed", "The active Back Office account changed.");
      const response = options.jsonResponse(stopwatchStateSchema.parse({ ...timer, profileId, matters: listMatters ? matters : undefined }));
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
      if (method === "GET" && ctx.url.searchParams.has("progress")) {
        const runId = z.uuid().parse(ctx.url.searchParams.get("progress"));
        const progress = await readWorkdayProgress(config, owner, date, runId);
        const result = options.jsonResponse(progress);
        result.headers.set("Cache-Control", "no-store");
        return result;
      }
      let sourcePreview = false;
      if (method === "POST") {
        options.ensureWritable(config);
        if (ctx.url.searchParams.get("preview") === "guideline-pdf") {
          if ((await readCaptureSettings(path)).enabled === false)
            throw new ApiError(409, "time_tracking_disabled", "Turn on Time tracking in Settings.");
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
          if (initial.settings.enabled === false) throw new ApiError(409, "time_tracking_disabled", "Turn on Time tracking in Settings.");
          const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(150_000)]);
          const workspaces = await workdayWorkspaces(config);
          const choice = await modelChoice(config, owner, initial, workspaces, signal, input.model);
          const runtime = localChoice(choice) ? await localModel() : null;
          const workspace = workspaces.find(item => item.id === choice.workspaceId);
          if ((localChoice(choice) && !runtime) || (!localChoice(choice) && !workspace))
            throw new ApiError(409, "timesheet_model_unavailable", "Choose an available model in the timekeeping chat composer to extract billing rules.");
          const verify = async () => {
            signal.throwIfAborted();
            const settings = await readCaptureSettings(path);
            if (settings.enabled === false || (await profile(config)).path !== path || digest([settings.model]) !== digest([initial.settings.model]))
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
            z.strictObject({ type: z.literal("calendar") }),
            z.strictObject({ type: z.literal("suggest"), model: workdayModelSchema.optional(), runId: z.uuid().optional() }),
            z.strictObject({ type: z.literal("dismiss"), key: z.uuid(), digest: z.string().length(64).optional() }),
            z.strictObject({ type: z.literal("draft"), key: z.uuid(), date: z.iso.date().optional(), values: z.record(z.string().max(200), BackOfficeValueSchema).nullable(), proposalDigest: z.string().length(64).optional() }),
            privateDraftPatchSchema,
            reconcileCaptureSchema,
            workdayCorrectionSchema,
            workdayGuidelineActionSchema,
          ])
          .safeParse(await options.readJsonBodyLimited(ctx.request, 100_000));
        if (!parsed.success) throw new ApiError(400, "private_workday_input", "Check the workday action and refresh the entry before retrying.");
        const action = parsed.data;
        sourcePreview = action.type === "calendar";
        if (action.type === "suggest" && options.startChat) {
          const current = await load(path);
          if (current.settings.enabled === false) throw new ApiError(409, "time_tracking_disabled", "Turn on Time tracking in Settings.");
          if (date > dayInZone(new Date().toISOString(), Intl.DateTimeFormat().resolvedOptions().timeZone))
            throw new ApiError(400, "future_workday", "Choose today or an earlier date.");
          await options.startChat(profileId, date, action.runId ?? randomUUID(), current.settings.model);
        } else if (action.type === "suggest" || action.type === "calendar")
          await prepare(config, owner, date, action, { signal: ctx.request.signal, resolveWorkspace: options.resolveWorkspace });
        else
          await withFileWriteLock(path, async () => {
            const s = await load(path);
            if (action.type !== "settings" && action.type !== "settings-patch" && s.settings.enabled === false)
              throw new ApiError(409, "time_tracking_disabled", "Turn on Time tracking in Settings.");
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
              if ((next.enabled !== false && Boolean(next.recordings)) !== (s.settings.enabled !== false && Boolean(s.settings.recordings)))
                s.recordingEpoch = Math.max(Date.now(), s.recordingEpoch + 1);
              if (next.enabled !== s.settings.enabled || next.desktopActivity !== s.settings.desktopActivity) { resetDesktopSampling(config); s.desktopHistoryEpoch++; }
              const evidenceSettings = ({ schedule, enabled, intervalMinutes, ...sources }: Saved["settings"]) => digest(sources);
              if (evidenceSettings(next) !== evidenceSettings(s.settings)) s.checkedThrough = {};
              const personalAccounts = (settings: Saved["settings"]) => (settings.connections ?? settings.fileConnections ?? [])
                .filter(account => account.provider === "onedrive-personal").map(account => account.account).sort();
              if (s.settings.enabled !== next.enabled || digest(personalAccounts(s.settings)) !== digest(personalAccounts(next)))
                s.personalDriveEpoch++;
              if (Boolean(s.settings.documents) !== Boolean(next.documents) || s.settings.enabled !== next.enabled)
                s.documentEpoch++;
              if (digest([s.settings.model]) !== digest([next.model])) s.reconstruction = {};
              if (s.settings.model && !next.model) delete s.lastModel;
              s.settings = next;
              if (action.type === "settings-patch") s.settingsPatched = true;
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
      const connections = (await connectedWorkdayAccounts(config, true)).map(({ provider, account, id }) => ({
        provider, account, name: s.connectionNames[account] ?? (z.email().safeParse(id).success ? id : account.slice(0, 8)),
      }));
      const status = s.reconstruction[date]?.status;
      const proposals = await visibleProposals(config, s, date, connections, sourcePreview);
      const available = s.settings.enabled !== false && await modelChoice(config, owner, s, await workdayWorkspaces(config), ctx.request.signal, undefined, true);
      const result = options.jsonResponse({
        settings: s.settings,
        drafts: Object.fromEntries(Object.entries(s.drafts).filter(([, draft]) => draft.date === date)),
        connections,
        modelReady: Boolean(available && (!localChoice(available) || await localModel())),
        guidelines: Object.values(s.guidelines).flatMap(versions => versions.slice(-1)),
        status,
        checkedThrough: s.checkedThrough[date],
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
