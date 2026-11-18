import { adjustTime, decideAdjustment, invoiceLines } from "./timesheet-adjustment.js";
import { authorizeIncrement } from "./timesheet-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  currencyScale,
  timeFeeMinor,
  renderInvoice,
  standardInvoice,
  suggestBillingNarrative,
  timeActivities,
  resolveTimePolicy,
  timePolicyError,
  timeEntryError,
  TimeDraftSchema,
  nonBillableWork,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  hasTimeEntryPrice,
  timeEntryPrice,
  TimesheetCommandSchema,
  type TimeDraft,
  type TimeEntry,
  type TimeInvoice,
  type TimesheetCommand,
  type TimesheetState,
} from "./timesheet-schema.js";
import { BackOfficeRecordSchema, backOfficeMoneyFromMinor, canonicalBackOfficeAudit, type BackOfficeActor } from "./schema.js";
import {
  readTimesheet,
  readTimeDocument,
  writeTimeDocument,
  writeEntry,
  projectBillingRecord,
  ensureProduct,
  timeError,
  type TimeDirectory,
} from "./timesheet-data.js";
import type { BackOfficeStore } from "./store.js";

const digest = (v: unknown) =>
  createHash("sha256")
    .update(canonicalBackOfficeAudit(z.json().parse(JSON.parse(JSON.stringify(v)))))
    .digest("hex");
const policyFor = (s: TimesheetState, d: TimeDraft) =>
  resolveTimePolicy(s.policies, d.clientId, d.matterId, d.date, d.projectId);
// Product identity is resolved before comparison. Its current display title may have changed.
const editableFields = TimeDraftSchema.omit({ createWorkProduct: true, workProductTitle: true, nonBillableMinutes: true }).keyof().options;
function validateReferences(state: TimesheetState, draft: TimeDraft) {
  const matter = state.matters.find((m) => m.id === draft.matterId);
  if (!matter) timeError("Choose an accessible matter.", 404);
  if (
    draft.clientId
      ? !matter.clientIds.includes(draft.clientId) || !state.clients.some((c) => c.id === draft.clientId)
      : draft.billable
  )
    timeError("Choose a billing client associated with this matter.");
  if (
    draft.projectId &&
    !state.projects.some((p) => p.id === draft.projectId && p.matterIds.includes(draft.matterId))
  )
    timeError("Choose a linked project.");
}
function validateDraft(state: TimesheetState, draft: TimeDraft, final = false) {
  validateReferences(state, draft);
  const policy = policyFor(state, draft);
  const error = final ? timePolicyError(draft, policy) : timeEntryError(draft, policy);
  if (error) timeError(error);
}
// Date or duration alone cannot identify a meeting. Compare exact instants, also across offsets.
function meetingSlot(entry: TimeDraft) {
  if (!["EXM", "INM"].includes(entry.activity) || !entry.startAt || !entry.endAt) return null;
  return JSON.stringify([entry.matterId, entry.clientId, Date.parse(entry.startAt), Date.parse(entry.endAt)]);
}
function suggestion(state: TimesheetState, entry: TimeEntry) {
  return suggestBillingNarrative(entry, policyFor(state, entry));
}
function requireReviewer(state: TimesheetState, e: TimeEntry, actor: BackOfficeActor) {
  const p = policyFor(state, e);
  if (
    !actor.finance ||
    !actor.edit ||
    (p.reviewerId !== actor.userId && !(p.soloApproval && state.scope === "local" && !p.reviewerId)) ||
    (e.workerId === actor.userId && !(p.soloApproval && state.scope === "local"))
  )
    timeError("An assigned independent billing reviewer must perform this action.", 403);
}
function requireEntry(state: TimesheetState, ref: { id: string; revision: number }) {
  const e = state.entries.find((v) => v.id === ref.id);
  if (!e) timeError("This entry is unavailable.", 404);
  if (e.revision !== ref.revision) timeError("This entry has changed. Refresh before saving.", 409);
  return e;
}
function snapshotRate(state: TimesheetState, e: TimeEntry, p = policyFor(state, e)) {
  return {
    activityLabel:
      p.activityLabels[e.activity] ??
      (Object.hasOwn(timeActivities, e.activity) ? timeActivities[e.activity] : e.activity),
    ...timeEntryPrice(p, e.workerId),
    policyDigest: digest(p),
  };
}
function issue(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  originals: TimeEntry[],
  adjustmentVersions: { id: string; revision: number }[],
) {
  if (!actor.finance) timeError("Billing access is required.", 403);
  const entries = invoiceLines(originals, state.adjustments ?? [], adjustmentVersions).map((e) => {
    validateReferences(state, e);
    if (e.legacy || e.status !== "approved" || !e.billable || e.nonHourlyApproval || !hasTimeEntryPrice(e))
      timeError("Issuance requires approved, priced billing lines.", 409);
    return e;
  });
  for (const e of entries) {
    if (
      e.clientId !== entries[0].clientId ||
      e.currency !== entries[0].currency ||
      e.matterId !== entries[0].matterId
    )
      timeError("Select one client, matter and currency for an invoice.");
  }
  const currency = entries[0].currency,
    scope = state.scope;
  // The sequence spans the entire directory, including matters the issuer cannot open.
  const numbers = new Set<number>(
    store.db
      .all(
        "SELECT json_extract(data,'$.value.number') AS number FROM bo_timesheets WHERE scope=? AND json_extract(data,'$.kind')='invoice'",
        [scope],
      )
      .map((r) => Number(r.number)),
  );
  const legacy = store.db.all("SELECT data FROM bo_records WHERE scope=? AND object_id='invoices'", [
    scope,
  ]);
  for (const row of legacy) {
    const r = BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
    if (readTimeDocument(store, scope, r.id)?.kind === "invoice") continue;
    if (r.values.status === "Draft" && !r.values.invoiceNumber) continue;
    const raw = String(r.values.invoiceNumber || "").trim(),
      n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0 || numbers.has(n))
      timeError(
        "Reconcile missing, duplicate or ambiguous existing invoice numbers before issuing.",
        409,
      );
    numbers.add(n);
  }
  let number = 1;
  for (const n of numbers) number = Math.max(number, n + 1);
  if (!Number.isSafeInteger(number)) timeError("The invoice sequence is exhausted.", 409);
  const scale = currencyScale(currency),
    totalMinor = entries.reduce((sum, e) => sum + timeFeeMinor(e.billableMinutes, e.hourlyRate, scale), 0),
    invoice: TimeInvoice = {
      id: randomUUID(),
      number,
      currency,
      clientId: entries[0].clientId,
      templateRevision: state.template?.revision ?? 0,
      issuedAt: new Date().toISOString(),
      entries: entries.map((e) => ({
        ...e,
        history: [],
        proposalDigest: undefined,
        sharedOriginal: undefined,
        suggestion: undefined,
      })),
      total: totalMinor / scale,
    };
  writeTimeDocument(store, scope, {
    id: invoice.id,
    kind: "invoice",
    value: invoice,
    document: renderInvoice(state.template ?? standardInvoice, {
      number,
      date: invoice.issuedAt.slice(0, 10),
      currency,
      client: state.clients.find((c) => c.id === invoice.clientId)?.name ?? invoice.clientId,
      entries: invoice.entries,
    }),
  });
  projectBillingRecord(store, scope, invoice.id, "invoices", actor.userId, {
    name: "Invoice " + number,
    invoiceNumber: String(number),
    status: "Issued",
    issuedOn: invoice.issuedAt.slice(0, 10),
    matter: entries[0].matterId,
    client: invoice.clientId,
    netTotal: backOfficeMoneyFromMinor(totalMinor, currency, scale),
  });
  for (const e of originals) {
    writeEntry(store, scope, actor, e, { ...e, status: "invoiced" }, "invoice");
    projectBillingRecord(store, scope, e.id, "timeEntries", e.workerId, {
      invoice: invoice.id,
    });
  }
}
type Originals = ReadonlyMap<string, Omit<NonNullable<TimeEntry["sharedOriginal"]>, "submittedRevision">>;
function apply(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  command: TimesheetCommand,
  originals: Originals,
) {
  const scope = state.scope;
  if (!actor.edit) timeError("Directory edit permission is required.", 403);
  if (command.type === "productDetails") {
    if (!state.canManage) timeError("Billing configuration access is required.", 403);
    const product = state.products.find((p) => p.id === command.id);
    if (!product) timeError("This work product is unavailable.", 404);
    if (product.productType !== command.expectedType || product.reference !== command.expectedReference)
      timeError("This work product has changed.", 409);
    writeTimeDocument(store, scope, {
      kind: "product",
      id: product.id,
      value: {
        ...product,
        productType: command.productType,
        reference: command.reference || undefined,
      },
    });
    return;
  }
  if (command.type === "renameProduct") {
    if (!state.canManage) timeError("Billing configuration access is required.", 403);
    const product = state.products.find((p) => p.id === command.id);
    if (!product) timeError("This work product is unavailable.", 404);
    if (product.name !== command.expectedName) timeError("This work product has changed.", 409);
    writeTimeDocument(store, scope, {
      kind: "product",
      id: product.id,
      value: { ...product, name: command.name },
    });
    return;
  }
  if (command.type === "adjust") {
    const e = requireEntry(state, command);
    if (e.workerId !== actor.userId) timeError("Only the worker can request a correction.", 403);
    validateDraft(state, {
      ...e,
      narrative: command.narrative,
      billableMinutes: command.billableMinutes,
    });
    adjustTime(store, state, actor, e, command);
    return;
  }
  if (command.type === "decideAdjustment") {
    const a = state.adjustments?.find((a) => a.id === command.id);
    if (!a || a.status !== "pending" || a.revision !== command.revision)
      timeError("This correction is no longer pending.", 409);
    const e = requireEntry(state, { id: a.entryId, revision: a.baseRevision });
    requireReviewer(state, e, actor);
    if (command.approve)
      validateDraft(
        state,
        {
          ...e,
          narrative: a.narrative,
          billableMinutes: a.toMinutes,
        },
        true,
      );
    decideAdjustment(store, state, actor, e, a, command.approve);
    return;
  }
  if (command.type === "template") {
    if (!state.canManage) timeError("Billing configuration access is required.", 403);
    if (command.template.revision !== (state.template?.revision ?? 0))
      timeError("The invoice template changed. Reopen it before saving.", 409);
    writeTimeDocument(store, scope, {
      id: "invoice-template",
      kind: "template",
      value: { ...command.template, revision: command.template.revision + 1 },
    });
    return;
  }
  if (command.type === "policy") {
    const p = command.policy;
    if (!state.canManage) timeError("Billing configuration access is required.", 403);
    const target =
      p.scope === "firm"
        ? p.targetId === "firm"
        : state[p.scope === "client" ? "clients" : p.scope === "matter" ? "matters" : "projects"].some(
            (v) => v.id === p.targetId,
          );
    if (!target) timeError("Choose an accessible policy target.");
    if (p.reviewerId && !state.people.some((v) => v.id === p.reviewerId && !v.directoryOnly))
      timeError("Choose a firm account as reviewer.");
    if (p.workerRates && Object.keys(p.workerRates).some((id) => !state.people.some((v) => v.id === id)))
      timeError("Choose a firm account for each worker rate.");
    if (p.soloApproval && (scope !== "local" || p.scope !== "firm"))
      timeError("Solo approval is a local firm policy.");
    const id = "policy-" + digest([p.scope, p.targetId, p.effectiveFrom]),
      old = readTimeDocument(store, scope, id);
    if ((old?.kind === "policy" ? old.value.revision : 0) !== p.revision)
      timeError("This policy has changed. Refresh before saving.", 409);
    writeTimeDocument(store, scope, {
      kind: "policy",
      id,
      value: {
        ...authorizeIncrement(state, p, actor),
        revision: p.revision + 1,
      },
    });
    return;
  }
  if (command.type === "create") {
    const d = command.entry;
    if (command.source === "suggestion") {
      if (!command.proposalDigest) timeError("A suggestion must reference its private original.");
      const booked = store.db.get(
        `SELECT 1 FROM bo_timesheets WHERE scope=? AND json_extract(data,'$.kind')='entry'
          AND json_extract(data,'$.value.source')='suggestion' AND json_extract(data,'$.value.authorId')=?
          AND json_extract(data,'$.value.proposalDigest')=? LIMIT 1`,
        [scope, actor.userId, command.proposalDigest],
      );
      if (booked) timeError("This suggestion has already been recorded.", 409);
    }
    const workers = [...new Set(command.workerIds ?? [actor.userId])];
    if (workers.some((id) => !state.people.some((p) => p.id === id)))
      timeError("Choose a current account for each participant.");
    const overrides = new Map(command.workerTimes?.map((time) => [time.workerId, time]));
    if (
      overrides.size !== (command.workerTimes?.length ?? 0) ||
      [...overrides.keys()].some((id) => !workers.includes(id))
    ) timeError("Choose each participant once and enter their own duration.");
    const product = ensureProduct(store, scope, state, actor.userId, d);
    const { createWorkProduct: _create, ...billingFields } = d;
    for (const workerId of workers) {
      const override = overrides.get(workerId);
      const sameDuration = override?.workedMinutes === d.workedMinutes;
      const allocation = override ? {
        workedMinutes: override.workedMinutes,
        nonBillableMinutes: override.nonBillableMinutes,
        billableMinutes: override.billableMinutes,
        billable: override.workedMinutes > override.nonBillableMinutes,
        startAt: sameDuration ? d.startAt : undefined,
        endAt: sameDuration ? d.endAt : undefined,
      } : {};
      const e: TimeEntry = {
        ...billingFields,
        ...allocation,
        id: randomUUID(),
        workProductId: product?.id,
        workProductTitle: product?.name,
        revision: 1,
        workerId,
        authorId: actor.userId,
        status: workerId === actor.userId ? "confirmed" : "pending",
        source: command.source ?? "manual",
        proposalDigest: command.proposalDigest,
        groupId: command.requestId,
        history: [],
      };
      validateDraft(state, e);
      if (command.source === "suggestion" && workerId === actor.userId) {
        const slot = meetingSlot(e);
        if (slot && state.entries.some((row) => row.workerId === workerId && row.status !== "declined" && meetingSlot(row) === slot))
          timeError("Your timesheet already has a meeting for this matter, client and time. Check the existing line.", 409);
      }
      writeEntry(store, scope, actor, null, { ...e, ...snapshotRate(state, e) }, "create");
    }
    return;
  }
  if (command.type === "update") {
    const e = requireEntry(state, command);
    if (e.workerId !== actor.userId || !["pending", "confirmed", "submitted"].includes(e.status))
      timeError("This entry cannot be edited by this person.", 403);
    // Older clients can edit text without knowing how to express a mixed allocation.
    const d = command.entry.billable && command.entry.nonBillableMinutes === undefined && e.billable && e.nonBillableMinutes
      ? { ...command.entry, nonBillableMinutes: e.nonBillableMinutes }
      : command.entry;
    validateDraft(state, d);
    const product = ensureProduct(store, scope, state, actor.userId, d);
    const { createWorkProduct: _create, ...billingFields } = d;
    const next: TimeEntry = {
      ...billingFields,
      id: e.id,
      revision: e.revision,
      workerId: e.workerId,
      authorId: e.authorId,
      history: e.history,
      source: e.source,
      groupId: e.groupId,
      proposalDigest: e.proposalDigest,
      adjustmentBaselineRevision: e.adjustmentBaselineRevision,
      workProductId: product?.id,
      workProductTitle: product?.name,
      status: e.status === "submitted" ? "confirmed" : e.status,
    };
    if (!e.legacy && nonBillableWork(e) === nonBillableWork(next) && editableFields.every((key) => e[key] === next[key])) return;
    writeEntry(store, scope, actor, e, { ...next, ...snapshotRate(state, next) }, "update");
    return;
  }
  if (command.type === "declineSuggestion") {
    const e = requireEntry(state, command);
    requireReviewer(state, e, actor);
    if (e.status !== "submitted" || !e.suggestion)
      timeError("This suggestion is no longer pending.", 409);
    writeEntry(store, scope, actor, e, { ...e, suggestion: undefined }, "declineSuggestion");
    return;
  }
  if (command.type === "review") {
    const e = requireEntry(state, command);
    requireReviewer(state, e, actor);
    if (e.status !== "submitted") timeError("Review a submitted revision.", 409);
    if (command.billableMinutes !== e.billableMinutes && !command.reason)
      timeError("Give a reason for the changed chargeable time.");
    const next = {
      ...e,
      narrative: command.narrative,
      billableMinutes: command.billableMinutes,
    };
    validateDraft(state, next);
    writeEntry(
      store,
      scope,
      actor,
      e,
      {
        ...next,
        ...snapshotRate(state, next),
        suggestion: suggestion(state, next),
      },
      "review",
      command.reason,
    );
    return;
  }
  const selection = command.entries.map((ref) => requireEntry(state, ref));
  if (new Set(selection.map((e) => e.id)).size !== selection.length)
    timeError("Select each revision once.");
  if (command.type === "applyWording") {
    for (const [index, entry] of selection.entries()) {
      requireReviewer(state, entry, actor);
      const { before, after } = command.entries[index];
      if (entry.status !== "submitted" || entry.narrative !== before || suggestion(state, entry) !== after)
        timeError("The entry or its wording rules changed. Check the billing text again.", 409);
      writeEntry(store, scope, actor, entry, { ...entry, narrative: after, suggestion: undefined }, "review");
    }
    return;
  }
  if (command.type === "invoice") {
    if (
      command.templateRevision !== undefined &&
      command.templateRevision !== (state.template?.revision ?? 0)
    )
      timeError("The template changed. Review the new preview before issuing.", 409);
    issue(store, state, actor, selection, command.adjustmentVersions ?? []);
    return;
  }
  const booked = new Set(command.type === "confirm"
    ? state.entries.filter((e) => e.workerId === actor.userId && e.status !== "pending" && e.status !== "declined").map(meetingSlot)
    : []);
  for (const e of selection) {
    let status: TimeEntry["status"];
    const policy = policyFor(state, e);
    if (command.type === "approve" || command.type === "return") {
      requireReviewer(state, e, actor);
      if (
        command.type === "return" && e.status === "approved" && !e.legacy && e.billable &&
        !e.nonHourlyApproval && !policy.nonHourlyAgreement && !hasTimeEntryPrice(e)
      ) {
        if (!command.reason) timeError("Give a reason for returning the unpriced approval.");
        const adjustments = state.adjustments ?? [];
        if (adjustments.some((a) => a.status === "pending" && appliesTimeAdjustment(e, a)))
          timeError("Resolve pending corrections before returning this entry.", 409);
        // Carry approved corrections into the new base revision and leave their records intact.
        const next = adjustedTimeEntry(e, adjustments);
        writeEntry(store, scope, actor, e, {
          ...next,
          status: "confirmed",
          adjustmentBaselineRevision: e.revision + 1,
          sharedOriginal: undefined,
        }, command.type, command.reason);
        continue;
      }
      if (e.status !== "submitted") timeError("Review a submitted revision.", 409);
      status = command.type === "approve" ? "approved" : "confirmed";
    } else {
      if (e.workerId !== actor.userId)
        timeError("Only the worker can confirm or submit this entry.", 403);
      if (command.type === "submit" ? e.status !== "confirmed" : e.status !== "pending")
        timeError("The entry is no longer at this stage.", 409);
      if (command.type === "confirm") {
        const slot = meetingSlot(e);
        if (slot && booked.has(slot))
          timeError("Your timesheet already has a meeting for this matter, client and time. Check the existing line.", 409);
        if (slot) booked.add(slot);
      }
      status =
        command.type === "submit" ? "submitted" : command.type === "confirm" ? "confirmed" : "declined";
    }
    if (
      e.billable &&
      (status === "submitted" || status === "approved") &&
      policy.ambiguousAgreement
    )
      timeError(
        "Several fee agreements apply. Link the intended agreement in Project details and choose that project before submitting.",
        409,
      );
    if (["approved", "submitted", "confirmed"].includes(status) && command.type !== "return")
      validateDraft(state, e, status === "approved");
    const next: TimeEntry = {
      ...e,
      status,
      suggestion: status === "submitted" ? suggestion(state, e) : undefined,
      submittedNarrative: status === "submitted" ? e.narrative : e.submittedNarrative,
    };
    if (command.type === "submit") {
      const consent = command.entries.find((ref) => ref.id === e.id)?.shareOriginal;
      delete next.sharedOriginal;
      if (consent) {
        const original = originals.get(consent.digest);
        if (e.authorId !== actor.userId || e.source !== "suggestion" || !original ||
            consent.key !== e.groupId || consent.digest !== e.proposalDigest)
          timeError("Refresh the verified original before sharing.", 409);
        next.sharedOriginal = { ...original, submittedRevision: e.revision + 1 };
      }
    } else if (command.type === "return") delete next.sharedOriginal;
    if (status === "submitted" || status === "approved") {
      const terms = snapshotRate(state, next, policy);
      if (status === "approved") {
        if (e.billable && policy.nonHourlyAgreement) next.nonHourlyApproval = true;
        else if (e.billable && !hasTimeEntryPrice(terms))
          timeError("Set an hourly rate and currency for the service date before approving this billable entry.", 409);
        if (e.policyDigest !== terms.policyDigest)
          timeError(
            "The applicable billing terms changed. Review the entry again or return it for resubmission.",
            409,
          );
      }
      Object.assign(next, terms);
    }
    writeEntry(store, scope, actor, e, next, command.type, command.reason);
  }
}
/** Execute on the directory's authoritative database. A team replica must use the platform route. */
export function commandTimesheet(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  people: TimeDirectory["people"],
  input: unknown,
  workspaces: TimeDirectory["projects"] = [],
  originals: Originals = new Map(),
) {
  if (actor.agentId) timeError("A person must save or confirm billing workflow changes.", 403);
  const command = TimesheetCommandSchema.parse(input);
  return store.transaction(
    () => {
      store.requireAccount(scope, actor);
      const state = readTimesheet(store, scope, actor, people, workspaces, true);
      if ("requestId" in command) {
        const id = "request-" + digest([actor.userId, command.requestId]),
          hash = digest(command),
          previous = readTimeDocument(store, scope, id);
        if (previous) {
          if (previous.kind !== "request" || previous.digest !== hash)
            timeError("This request ID was already used for other data.", 409);
          return readTimesheet(store, scope, actor, people, workspaces);
        }
        apply(store, state, actor, command, originals);
        writeTimeDocument(store, scope, { kind: "request", id, digest: hash });
      } else apply(store, state, actor, command, originals);
      return readTimesheet(store, scope, actor, people, workspaces);
    },
    { actor, action: "timesheet." + command.type },
  );
}
