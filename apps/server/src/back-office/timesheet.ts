import { isTimekeepingBillingCommand } from "../time-capture/chat-billing-schema.js";
import { assignedTimeReviewer, changeTimeApproval, timeApprovalPrice } from "./timesheet-schema.js";
import { adjustTime, decideAdjustment } from "./timesheet-adjustment.js";
import { buildInvoiceDraft } from "./timesheet-invoice-draft.js";
import type { InvoiceGuidelineContext } from "./timesheet-invoice-guidelines.js";
import { authorizeIncrement } from "./timesheet-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  currencyScale,
  renderInvoice,
  suggestBillingNarrative,
  resolveTimePolicy,
  soleMatterClient,
  timePolicyError,
  timeEntryError,
  TimeDraftSchema,
  nonBillableWork,
  adjustedTimeEntry,
  appliesTimeAdjustment,
  hasTimeEntryPrice,
  TimesheetCommandSchema,
  type TimeDraft,
  type TimeEntry,
  type TimeInvoice,
  type TimeInvoiceDraft,
  type InvoiceWordingSuggestion,
  type TimesheetCommand,
  type TimesheetState,
} from "./timesheet-schema.js";
import { BackOfficeRecordSchema, backOfficeMoneyFromMinor, canonicalBackOfficeAudit, type BackOfficeActor } from "./schema.js";
import {
  readTimesheet,
  readTimeDocument,
  readInvoiceDraft,
  invoiceDraftKey,
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
const timesheetRequestKey = (actorId: string, requestId: string) => "request-" + digest([actorId, requestId]);
export function readTimesheetRequest(store: BackOfficeStore, scope: string, actorId: string, requestId: string) {
  return readTimeDocument(store, scope, timesheetRequestKey(actorId, requestId));
}
const policyFor = (s: TimesheetState, d: TimeDraft) =>
  resolveTimePolicy(s.policies, d.clientId, d.matterId, d.date, d.projectId);
// Product identity is resolved before comparison. Its current display title may have changed.
const editableFields = TimeDraftSchema.omit({ createWorkProduct: true, workProductTitle: true, nonBillableMinutes: true }).keyof().options;
function validateReferences(state: TimesheetState, draft: TimeDraft) {
  const matter = state.matters.find((m) => m.id === draft.matterId);
  if (!matter) timeError("Choose an accessible matter.", 404);
  if (draft.clientId && (!matter.clientIds.includes(draft.clientId) || !state.clients.some((c) => c.id === draft.clientId)))
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
function canReviewEntry(state: TimesheetState, e: TimeEntry, actor: BackOfficeActor) {
  const p = policyFor(state, e);
  const solo = p.soloApproval && state.scope === "local";
  return actor.finance && actor.edit && (p.reviewerId === actor.userId || (solo && !p.reviewerId)) &&
    (e.workerId !== actor.userId || solo);
}
function requireReviewer(state: TimesheetState, e: TimeEntry, actor: BackOfficeActor) {
  if (!canReviewEntry(state, e, actor))
    timeError("An assigned independent billing reviewer must perform this action.", 403);
}
function requireEntry(state: TimesheetState, ref: { id: string; revision: number }) {
  const e = state.entries.find((v) => v.id === ref.id);
  if (!e) timeError("This entry is unavailable.", 404);
  if (e.revision !== ref.revision) timeError("This entry has changed. Refresh before saving.", 409);
  return e;
}
function snapshotRate(state: TimesheetState, e: TimeEntry, policy = policyFor(state, e)) {
  return timeApprovalPrice(e, policy, digest(policy));
}
function issue(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  draft: TimeInvoiceDraft,
  profileId?: string,
  recordOnly?: true,
) {
  const { currency, snapshot, totalMinor, input, approval } = draft;
  const { scope } = state;
  const entries = draft.lines.map(({ entry, amountMinor, actualAmountMinor, baseAmountMinor, originalNarrative }) => ({
    ...entry,
    amountMinor,
    actualAmountMinor,
    baseAmountMinor,
    originalNarrative,
  }));
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
    invoice: TimeInvoice = {
      id: randomUUID(),
      ...(recordOnly ? { recordOnly } : { draftId: draft.id }),
      number,
      currency,
      clientId: input.clientId,
      templateRevision: snapshot.template.revision,
      issuedAt: new Date().toISOString(),
      entries,
      total: totalMinor / scale,
      totalMinor,
      billingMode: input.pricing.mode,
      showHours: draft.showHours,
      approval,
      snapshot: recordOnly ? { ...snapshot, template: { ...snapshot.template, word: undefined } } : snapshot,
    };
  writeTimeDocument(store, scope, {
    id: invoice.id,
    kind: "invoice",
    value: invoice,
    document: recordOnly ? undefined : renderInvoice(snapshot.template, {
      number,
      date: snapshot.date,
      currency,
      client: snapshot.client,
      clientAddress: snapshot.clientAddress,
      entries: invoice.entries,
      billingMode: invoice.billingMode,
      showHours: invoice.showHours,
    }),
  });
  projectBillingRecord(store, scope, invoice.id, "invoices", actor.userId, {
    name: "Invoice " + number,
    invoiceNumber: String(number),
    status: "Issued",
    issuedOn: snapshot.date,
    matter: input.matterId,
    client: invoice.clientId,
    netTotal: backOfficeMoneyFromMinor(totalMinor, currency, scale),
  });
  for (const ref of input.entries) {
    const e = requireEntry(state, ref);
    writeEntry(store, scope, actor, e, { ...e, ...(e.status === "confirmed" ? snapshotRate(state, e) : {}), status: "invoiced" }, "invoice");
    projectBillingRecord(store, scope, e.id, "timeEntries", e.workerId, {
      invoice: invoice.id,
    });
  }
  if (!recordOnly)
    store.db.run("DELETE FROM bo_timesheets WHERE scope=? AND id=?", [scope, invoiceDraftKey(actor.userId, profileId)]);
}

function requireInvoiceAuthority(state: TimesheetState, actor: BackOfficeActor) {
  if (state.scope !== "local") timeError("The connected firm must issue invoices in its own service.", 409);
  if (!actor.finance || !actor.edit) timeError("Billing access is required.", 403);
}

function canInvoiceEntry(state: TimesheetState, entry: TimeEntry, actor: BackOfficeActor) {
  const ownWithoutReviewer = actor.finance && actor.edit && entry.workerId === actor.userId &&
    !assignedTimeReviewer(policyFor(state, entry), entry.workerId);
  return entry.status === "confirmed" ? ownWithoutReviewer :
    entry.status === "approved" && (ownWithoutReviewer || canReviewEntry(state, entry, actor));
}

function invoiceTimeState(state: TimesheetState): TimesheetState {
  return { ...state, entries: state.entries.map(entry => entry.status === "confirmed"
    ? { ...entry, ...snapshotRate(state, entry) } : entry) };
}

function validateInvoiceEntry(state: TimesheetState, actor: BackOfficeActor, entry: TimeEntry) {
  if (!canInvoiceEntry(state, entry, actor)) timeError("Only the assigned reviewer or owner of time without review can invoice this entry.", 403);
  validateReferences(state, entry);
  if (entry.status === "confirmed") {
    const error = timePolicyError(entry, policyFor(state, entry));
    if (error) timeError(error);
  }
}

export function currentInvoiceDraft(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  ref: { id: string; revision: string },
  context?: InvoiceGuidelineContext,
) {
  requireInvoiceAuthority(state, actor);
  const previous = readInvoiceDraft(store, state.scope, actor.userId, context?.profileId);
  if (!previous || previous.id !== ref.id || previous.revision !== ref.revision)
    timeError("The invoice draft changed. Open the current preview.", 409);
  const draft = buildInvoiceDraft(invoiceTimeState(state), previous.input, (entry) => canInvoiceEntry(state, entry, actor),
    (entry) => validateInvoiceEntry(state, actor, entry), digest, previous, undefined, context);
  if (draft.revision !== ref.revision)
    timeError("The invoice content or template changed. Preview it again before approval.", 409);
  return draft;
}

function reviewInvoice(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  command: Extract<TimesheetCommand, { type: "prepareInvoice" | "reviewInvoiceWording" | "approveInvoice" | "issueInvoice" }>,
  advice: InvoiceWordingSuggestion[] | undefined,
  context?: InvoiceGuidelineContext,
) {
  requireInvoiceAuthority(state, actor);
  const build = (input: TimeInvoiceDraft["input"], prior?: TimeInvoiceDraft, modelWording?: InvoiceWordingSuggestion[]) =>
    buildInvoiceDraft(invoiceTimeState(state), input, (entry) => canInvoiceEntry(state, entry, actor),
      (entry) => validateInvoiceEntry(state, actor, entry), digest, prior, modelWording, context);
  let draft = command.type === "prepareInvoice"
    ? build(command.draft, readInvoiceDraft(store, state.scope, actor.userId, context?.profileId))
    : currentInvoiceDraft(store, state, actor, command, context);
  if (command.type === "reviewInvoiceWording") {
    if (!actor.model) timeError("Model access is required to check invoice wording.", 403);
    if (!advice) timeError("No invoice wording review is available.", 409);
    if (draft.approval)
      timeError("Check wording before approving the invoice.", 409);
    draft = build(draft.input, draft, advice);
  }
  if (command.type === "issueInvoice") {
    if (!draft.approval || draft.approval.actorId !== actor.userId || draft.approval.revision !== draft.revision)
      timeError("Approve this invoice preview before issuing.", 409);
    issue(store, state, actor, draft, context?.profileId);
    return;
  }
  if (command.type === "approveInvoice") {
    if (!draft.snapshot.clientAddress) timeError("Add the client's billing address before approving the invoice.", 409);
    draft.approval ??= { actorId: actor.userId, at: new Date().toISOString(), revision: draft.revision };
  }
  writeTimeDocument(store, state.scope, {
    kind: "invoiceDraft",
    id: invoiceDraftKey(actor.userId, context?.profileId),
    value: draft,
  });
}
function apply(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  command: TimesheetCommand,
  advice: InvoiceWordingSuggestion[] | undefined,
  context?: InvoiceGuidelineContext,
) {
  const scope = state.scope;
  if (command.type === "submit" && command.entries.some(entry => entry.shareOriginal))
    timeError("Only confirmed entries can be shared. The original proposal stays on this device.",403);
  if (!actor.edit) timeError("Directory edit permission is required.", 403);
  if (command.type === "createInvoice") {
    requireInvoiceAuthority(state, actor);
    const invoice = buildInvoiceDraft(invoiceTimeState(state), command.invoice, entry => canInvoiceEntry(state, entry, actor),
      entry => validateInvoiceEntry(state, actor, entry), digest);
    issue(store, state, actor, invoice, undefined, true);
    return;
  }
  if (command.type === "prepareInvoice" || command.type === "reviewInvoiceWording" || command.type === "approveInvoice" || command.type === "issueInvoice") {
    reviewInvoice(store, state, actor, command, advice, context);
    return;
  }
  if (command.type === "invoice") timeError("Create and approve an invoice draft before issuing.", 409);
  if (command.type === "assignBillingClient") {
    const entry = requireEntry(state, command);
    if (!entry.billable || entry.clientId || !["confirmed", "submitted", "approved"].includes(entry.status))
      timeError("The entry is no longer awaiting an invoice recipient.", 409);
    const assigned = { ...entry, clientId: command.clientId };
    validateReferences(state, assigned);
    if (entry.status === "confirmed") {
      if (entry.workerId !== actor.userId) timeError("Only the timekeeper may edit this entry.", 403);
    } else {
      requireReviewer(state, entry, actor);
    }
    let updated = assigned;
    if (entry.status === "approved") {
      const amendments = state.adjustments ?? [];
      if (amendments.some(a => a.status === "pending" && appliesTimeAdjustment(entry, a)))
        timeError("Resolve pending corrections before assigning an invoice recipient.", 409);
      updated = { ...adjustedTimeEntry(assigned, amendments), status: "submitted", adjustmentBaselineRevision: entry.revision + 1,
        nonHourlyApproval: undefined, nonHourlyBasis: undefined };
    }
    writeEntry(store, scope, actor, entry, { ...updated, ...snapshotRate(state, updated) }, "assignBillingClient");
    return;
  }
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
    const d = { ...command.entry, clientId: command.entry.clientId || soleMatterClient(state.matters.find(m => m.id === command.entry.matterId), state.clients) };
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
    if (workers.some(id => id !== actor.userId && !state.people.some(person => person.id === id && person.canRecordTimeFor === true)))
      timeError("Your firm has not delegated time entry for this person.", 403);
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
      validateDraft(state, e, !assignedTimeReviewer(policyFor(state, e), e.workerId));
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
    const clientId = d.clientId || soleMatterClient(state.matters.find(m => m.id === d.matterId), state.clients);
    const assigned = { ...d, clientId };
    // Rewording a saved line preserves its pricing snapshot and work product.
    if (!e.legacy && !d.createWorkProduct && d.workProductTitle === e.workProductTitle
      && nonBillableWork(e) === nonBillableWork(assigned)
      && editableFields.every(key => key === "narrative" || assigned[key] === e[key])) {
      validateReferences(state, assigned);
      if (d.narrative !== e.narrative) {
        writeEntry(store, scope, actor, e, { ...e, narrative: d.narrative,
          status: e.status === "submitted" ? "confirmed" : e.status, sharedOriginal: undefined, suggestion: undefined }, "update");
      }
      return;
    }
    validateDraft(state, assigned, !assignedTimeReviewer(policyFor(state, { ...e, ...assigned }), e.workerId));
    const product = ensureProduct(store, scope, state, actor.userId, d);
    const { createWorkProduct: _create, ...billingFields } = assigned;
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
  if (command.type === "withdraw") {
    const entry = requireEntry(state, command);
    if (entry.workerId !== actor.userId) timeError("Only the timekeeper can remove this entry.", 403);
    if (entry.status !== "pending" && entry.status !== "confirmed") timeError("This entry has already entered billing review.", 409);
    writeEntry(store, scope, actor, entry, { ...entry, status: "declined" }, "withdraw");
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
    validateReferences(state, e);
    const policy = policyFor(state, e);
    const result = changeTimeApproval(e, command, {
      actorId: actor.userId, canReview: canReviewEntry(state, e, actor), policy, policyDigest: digest(policy),
    });
    if (!("entry" in result)) timeError(result.message, result.status);
    writeEntry(store, scope, actor, e, result.entry, command.approve ? "approve" : "review", command.reason);
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
  const booked = new Set(command.type === "confirm"
    ? state.entries.filter((e) => e.workerId === actor.userId && e.status !== "pending" && e.status !== "declined").map(meetingSlot)
    : []);
  for (const e of selection) {
    const policy = policyFor(state, e);
    if (command.type === "approve" || command.type === "return" || command.type === "submit") {
      if (
        command.type === "return" && e.status === "approved" && !e.legacy && e.billable &&
        !e.nonHourlyApproval && !policy.nonHourlyAgreement && !hasTimeEntryPrice(e)
      ) {
        requireReviewer(state, e, actor);
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
      validateReferences(state, e);
      const result = changeTimeApproval(e, command, {
        actorId: actor.userId, canReview: canReviewEntry(state, e, actor), policy, policyDigest: digest(policy),
      });
      if (!("entry" in result)) timeError(result.message, result.status);
      if (command.type === "submit" && !assignedTimeReviewer(policy, e.workerId)) continue;
      writeEntry(store, scope, actor, e, result.entry, command.type, command.reason);
      continue;
    }

    if (e.workerId !== actor.userId) timeError("Only the worker can confirm this entry.", 403);
    if (e.status !== "pending") timeError("The entry is no longer at this stage.", 409);
    if (command.type === "confirm") {
      const slot = meetingSlot(e);
      if (slot && booked.has(slot))
        timeError("Your timesheet already has a meeting for this matter, client and time. Check the existing line.", 409);
      if (slot) booked.add(slot);
      validateDraft(state, e);
    }
    writeEntry(store, scope, actor, e, {
      ...e, status: command.type === "confirm" ? "confirmed" : "declined", suggestion: undefined,
    }, command.type, command.reason);
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
  advice?: InvoiceWordingSuggestion[],
  context?: InvoiceGuidelineContext,
) {
  const command = TimesheetCommandSchema.parse(input);
  if (actor.agentId && !(actor.agentId === "timekeeping" && (command.type === "update" || command.type === "withdraw" || isTimekeepingBillingCommand(command))))
    timeError("A person must save or confirm billing workflow changes.", 403);
  return store.transaction(
    () => {
      store.requireAccount(scope, actor);
      const state = readTimesheet(store, scope, actor, people, workspaces, true, context?.profileId);
      if ("requestId" in command) {
        const id = timesheetRequestKey(actor.userId, command.requestId),
          hash = digest(command),
          previous = readTimeDocument(store, scope, id);
        if (previous) {
          if (previous.kind !== "request" || previous.digest !== hash)
            timeError("This request ID was already used for other data.", 409);
          return readTimesheet(store, scope, actor, people, workspaces, false, context?.profileId);
        }
        apply(store, state, actor, command, advice, context);
        writeTimeDocument(store, scope, { kind: "request", id, digest: hash });
      } else apply(store, state, actor, command, advice, context);
      return readTimesheet(store, scope, actor, people, workspaces, false, context?.profileId);
    },
    { actor, action: "timesheet." + command.type },
  );
}
