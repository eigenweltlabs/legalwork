import { BackOfficeRecordSchema, BackOfficeValueSchema, canonicalBackOfficeAudit, z, type BackOfficeField, type BackOfficeRecord, type BackOfficeValue } from "@legalwork/types/back-office";
import type { CaptureProposal } from "@legalwork/types/time-capture";
import { privateEntryDraftSchema } from "@legalwork/types/time-capture";
import { LegalworkServerError } from "@/app/lib/legalwork-server";
import { timeRecordDate } from "./time-record-values";

export type TimeRecordValues = Record<string, BackOfficeValue>;
export type ProposalOrigin = Pick<CaptureProposal, "key" | "digest" | "date">;
export type TimeRowDraft = {
  record: BackOfficeRecord; date: string; proposal?: ProposalOrigin; privateSaved?: boolean;
  privateRevision?: number; changes?: TimeRecordValues; latestDraft?: z.infer<typeof privateEntryDraftSchema> | null;
};
const privateDraftConflictSchema = z.object({ draft: privateEntryDraftSchema.nullable() });
export function privateDraftConflict(error: unknown) {
  if (error instanceof LegalworkServerError && error.code === "private_draft_conflict")
    return privateDraftConflictSchema.safeParse(error.details).data?.draft;
}
export const timeRecordConflictSchema = z.object({ record: BackOfficeRecordSchema, fields: z.array(z.string()) });
export type TimeRecordEdit = {
  base: BackOfficeRecord;
  values: TimeRecordValues;
  error?: string;
  conflict?: z.infer<typeof timeRecordConflictSchema>;
};

function createEdits(scope: string) {
  const listeners = new Set<() => void>();
  let version = 0;
  const edits = {
    drafts: new Map<string, TimeRowDraft>(),
    updates: new Map<string, TimeRecordEdit[]>(),
    confirmed: new Map<string, BackOfficeRecord>(),
    memberContacts: new Map<string, string>(),
    queues: new Map<string, Promise<void>>(),
    saving: new Set<string>(),
    draftErrors: new Map<string, string>(),
    changed: () => { version++; for (const listener of listeners) listener(); },
    snapshot: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); queueMicrotask(edits.prune); };
    },
    prune: () => {
      if (!listeners.size && !edits.drafts.size && !edits.updates.size && !edits.queues.size && sheetEdits.get(scope) === edits)
        sheetEdits.delete(scope);
    },
  };
  return edits;
}

const sheetEdits = new Map<string, ReturnType<typeof createEdits>>();
export function timeRecordEdits(scope: string) {
  let edits = sheetEdits.get(scope);
  if (!edits) { edits = createEdits(scope); sheetEdits.set(scope, edits); }
  return edits;
}

function hasUnsavedEdits() {
  return [...sheetEdits.values()].some(edits => edits.updates.size > 0 ||
    [...edits.drafts.values()].some(draft => !draft.privateSaved && (!draft.proposal || Object.keys(draft.changes ?? {}).length > 0)));
}

if (typeof window !== "undefined") {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedEdits()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  import.meta.hot?.dispose(() => window.removeEventListener("beforeunload", beforeUnload));
}

export const timeRowClipboardSchema = z.object({
  legalworkTimeRow: z.literal(1),
  values: z.record(z.string(), BackOfficeValueSchema),
});

export function copyTimeRecordValues(input: TimeRecordValues, fields: readonly BackOfficeField[], date: string, self: string, finance: boolean): TimeRecordValues {
  const excluded = new Set(["invoice", "endedAt", "startedAt", "serviceDate", "timekeeper", "status"]);
  const values = Object.fromEntries(fields.filter(field =>
    field.type !== "file" && !excluded.has(field.id) && (finance || field.visibility !== "finance") && Object.hasOwn(input, field.id),
  ).map(field => [field.id, input[field.id]]));
  return { ...values, startedAt: date, serviceDate: date, endedAt: null, invoice: null, timekeeper: self, status: "Draft" };
}

export function differentTimeValues(before: TimeRecordValues, after: TimeRecordValues): TimeRecordValues {
  return Object.fromEntries(Object.entries(after).filter(([id, value]) =>
    canonicalBackOfficeAudit(before[id] ?? null) !== canonicalBackOfficeAudit(value)));
}

export function timeCellChanges(base: TimeRecordValues, changes: TimeRecordValues, date: string, memberLabel: BackOfficeValue | undefined, clientForMatter: (id: string) => BackOfficeValue) {
  const patch = { ...changes };
  if (Object.hasOwn(patch, "startedAt")) {
    const target = timeRecordDate(patch.startedAt) || date;
    if (target === timeRecordDate(base.startedAt, base.serviceDate)) delete patch.startedAt;
    else Object.assign(patch, { startedAt: target, serviceDate: target, endedAt: null });
  }
  if (typeof patch.billingNarrative === "string" && patch.billingNarrative !== base.billingNarrative) patch.name = patch.billingNarrative.slice(0, 240);
  if (Object.hasOwn(patch, "matter") && patch.matter !== base.matter) patch.client = typeof patch.matter === "string" ? clientForMatter(patch.matter) : null;
  if (Object.hasOwn(patch, "timekeeper") && patch.timekeeper === memberLabel) delete patch.timekeeper;
  return differentTimeValues(base, patch);
}

export function conflictingTimeFields(values: TimeRecordValues, fields: string[]) {
  const conflicts = new Set(fields);
  for (const group of [["name", "billingNarrative"], ["startedAt", "serviceDate", "endedAt"], ["matter", "client"]]) {
    if (group.some(id => conflicts.has(id))) for (const id of group) if (Object.hasOwn(values, id)) conflicts.add(id);
  }
  return conflicts;
}
