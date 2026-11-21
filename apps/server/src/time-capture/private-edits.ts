import { z } from "zod";
import { canonicalBackOfficeAudit } from "../back-office/schema.js";
import {
  captureAccountEnabled, captureSettingsSchema, sameCaptureAccount,
  type CaptureSettings, type CaptureState, type PrivateDraftPatch,
  type captureSettingsChangeSchema,
} from "../back-office/timesheet-schema.js";
import { ApiError } from "../errors.js";

export function patchCaptureSettings(settings: CaptureSettings, change: z.infer<typeof captureSettingsChangeSchema>) {
  if (change.field === "model") {
    const next = { ...settings };
    if (change.value) next.model = change.value;
    else delete next.model;
    return next;
  }
  if (change.field !== "account") return { ...settings, [change.field]: change.value };
  const { account, value } = change;
  if (captureAccountEnabled(settings, account) === value) return settings;
  if (settings.connections) {
    const others = settings.connections.filter(item => !sameCaptureAccount(item, account));
    const next = captureSettingsSchema.safeParse({ ...settings, connections: value ? [...others, account] : others });
    if (!next.success) throw new ApiError(400, "private_workday_sources", "Choose up to 16 connected activity sources.");
    return next.data;
  }
  const others = (settings.disabledConnections ?? []).filter(item => !sameCaptureAccount(item, account));
  return { ...settings, disabledConnections: value ? others : [...others, account] };
}

export const draftClockSchema = z.object({
  date: z.iso.date(), proposalDigest: z.string().length(64).optional(),
  fields: z.record(z.string(), z.number().int().nonnegative()),
  removed: z.boolean().optional(),
  guarded: z.boolean().optional(),
  booking: z.object({ revision: z.number().int().nonnegative(), pending: z.boolean(), target: z.enum(["workflow", "record"]) }).optional(),
});
type DraftClock = z.infer<typeof draftClockSchema>;
type Draft = CaptureState["drafts"][string];
export type DraftStore = { drafts: CaptureState["drafts"]; draftClocks: Record<string, DraftClock> };
type AuditValue = Parameters<typeof canonicalBackOfficeAudit>[0];
const equal = (a: AuditValue | undefined, b: AuditValue | undefined) => canonicalBackOfficeAudit(a ?? null) === canonicalBackOfficeAudit(b ?? null);

function draftConflict(draft: Draft | undefined) {
  return new ApiError(409, "private_draft_conflict", "This private draft changed in another window. Review your edits before retrying.", { draft: draft ?? null });
}

export function requireDraftRevision(store: DraftStore, key: string, revision: number | undefined, date: string, proposalDigest?: string) {
  const draft = store.drafts[key];
  if (revision === undefined && !store.draftClocks[key]?.guarded) return;
  if (!draft || draft.date !== date || draft.proposalDigest !== proposalDigest || (draft.revision ?? 0) !== revision)
    throw draftConflict(draft);
}

export function unchangedPrivateDraft(store: DraftStore, key: string, date: string, proposalDigest: string | undefined,
  changes: Draft["values"] | null, patch: boolean) {
  const draft = store.drafts[key];
  return Boolean(changes && draft?.date === date && draft.proposalDigest === proposalDigest &&
    (patch ? Object.entries(changes).every(([field, value]) => equal(draft.values[field], value)) : equal(draft.values, changes)));
}

function draftClock(store: DraftStore, key: string, date: string, proposalDigest?: string): DraftClock {
  const clock = store.draftClocks[key];
  const draft = store.drafts[key];
  if (draft && (draft.date !== date || draft.proposalDigest !== proposalDigest)) throw draftConflict(draft);
  if (clock && clock.date === date && clock.proposalDigest === proposalDigest) return clock;
  return { date, proposalDigest, fields: {} };
}

export function writePrivateDraft(store: DraftStore, date: string, action: {
  key: string; proposalDigest?: string; values: Draft["values"] | null;
}) {
  const { key, proposalDigest, values } = action;
  const draft = store.drafts[key], clock = draftClock(store, key, date, proposalDigest);
  if ((!draft && values === null) || (draft && equal(draft.values, values))) return;
  if (clock.guarded) throw draftConflict(draft);
  if (values === null) {
    delete store.drafts[key];
    store.draftClocks[key] = { ...clock, removed: true };
    return;
  }
  if (clock.removed) throw draftConflict(draft);
  const revision = (draft?.revision ?? 0) + 1;
  const fields = { ...clock.fields };
  for (const field of new Set([...Object.keys(draft?.values ?? {}), ...Object.keys(values)]))
    if (!equal(draft?.values[field], values[field])) fields[field] = revision;
  store.draftClocks[key] = { ...clock, fields };
  store.drafts[key] = { date, proposalDigest, values, revision };
}

export function patchPrivateDraft(store: DraftStore, action: PrivateDraftPatch) {
  const { key, date, proposalDigest, changes } = action;
  const draft = store.drafts[key], clock = draftClock(store, key, date, proposalDigest);
  const revision = draft?.revision ?? 0;
  if (changes === null) {
    if (!draft && clock.removed) return;
    if (revision !== action.revision) throw draftConflict(draft);
    delete store.drafts[key];
    store.draftClocks[key] = { ...clock, guarded: true, removed: true };
    return;
  }
  if (clock.removed || action.revision > revision) throw draftConflict(draft);
  const current = draft?.values ?? action.initial ?? {};
  const edits = Object.entries(changes).filter(([field, value]) => !draft || !equal(current[field], value));
  if (edits.some(([field]) => (clock.fields[field] ?? 0) > action.revision)) throw draftConflict(draft);
  if (draft && !edits.length) {
    store.draftClocks[key] = { ...clock, guarded: true };
    return;
  }
  const nextRevision = revision + 1;
  const fields = { ...clock.fields };
  for (const [field] of edits) fields[field] = nextRevision;
  store.draftClocks[key] = { ...clock, guarded: true, fields };
  store.drafts[key] = { date, proposalDigest, revision: nextRevision, values: { ...current, ...Object.fromEntries(edits) } };
}

export function rebasePrivateDraft(store: DraftStore, key: string, date: string, digest: string,
  nextDigest: string, revision: number | undefined, replaced: string[]) {
  const draft = store.drafts[key];
  if (draft || revision !== undefined)
    requireDraftRevision(store, key, revision ?? (store.draftClocks[key]?.guarded ? undefined : 0), date, digest);
  if (!draft) {
    delete store.drafts[key];
    delete store.draftClocks[key];
    return;
  }
  const nextRevision = (draft.revision ?? 0) + 1;
  const values = { ...draft.values }, fields = { ...store.draftClocks[key]?.fields };
  for (const field of replaced) {
    delete values[field];
    delete fields[field];
  }
  store.drafts[key] = { date, values, revision: nextRevision, proposalDigest: nextDigest };
  store.draftClocks[key] = { date, fields, guarded: true, proposalDigest: nextDigest };
}
