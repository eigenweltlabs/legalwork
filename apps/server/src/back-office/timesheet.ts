import { adjustTime, decideAdjustment, invoiceLines } from "./timesheet-adjustment.js";
import { authorizeIncrement } from "./timesheet-policy.js";
import { suggestBillingNarrative } from "@legalwork/types/billing-narrative";
import { renderInvoice, standardInvoice } from "@legalwork/types/invoice-template";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  timeActivities,
  resolveTimePolicy,
  timePolicyError,
  timeEntryError,
  TimesheetCommandSchema,
  type TimeDraft,
  type TimeEntry,
  type TimeInvoice,
  type TimesheetCommand,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { BackOfficeRecordSchema, canonicalBackOfficeAudit, type BackOfficeActor } from "./schema.js";
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
function validateDraft(state: TimesheetState, draft: TimeDraft, final = false) {
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
  const policy = policyFor(state, draft);
  const error = final ? timePolicyError(draft, policy) : timeEntryError(draft, policy);
  if (error) timeError(error);
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
function snapshotRate(state: TimesheetState, e: TimeEntry) {
  const p = policyFor(state, e);
  return {
    activityLabel:
      p.activityLabels[e.activity] ??
      (Object.hasOwn(timeActivities, e.activity) ? timeActivities[e.activity] : e.activity),
    hourlyRate: p.workerRates[e.workerId] ?? p.hourlyRate,
    currency: p.currency || undefined,
    policyDigest: digest(p),
  };
}
const scaleFor = (currency: string) =>
  10 **
  (new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits ?? 2);
function lineAmount(e: TimeEntry) {
  const scale = scaleFor(e.currency!);
  return Math.round((e.billableMinutes * e.hourlyRate! * scale) / 60) / scale;
}
function issue(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  originals: TimeEntry[],
  adjustmentVersions: { id: string; revision: number }[],
) {
  const entries = invoiceLines(originals, state.adjustments ?? [], adjustmentVersions);
  if (!actor.finance) timeError("Billing access is required.", 403);
  for (const e of entries) {
    validateDraft(state, e, true);
    if (e.legacy || e.status !== "approved" || !e.billable || e.hourlyRate === undefined || !e.currency)
      timeError("Issuance requires approved, priced billing lines.", 409);
    if (
      e.clientId !== entries[0].clientId ||
      e.currency !== entries[0].currency ||
      e.matterId !== entries[0].matterId
    )
      timeError("Select one client, matter and currency for an invoice.");
  }
  const currency = entries[0].currency!,
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
  const scale = scaleFor(currency),
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
        suggestion: undefined,
      })),
      total: entries.reduce((n, e) => n + Math.round(lineAmount(e) * scale), 0) / scale,
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
    netTotal: { amountMinor: Math.round(invoice.total * 100), currency },
  });
  for (const e of originals) {
    writeEntry(store, scope, actor, e, { ...e, status: "invoiced" }, "invoice");
    projectBillingRecord(store, scope, e.id, "timeEntries", e.workerId, {
      invoice: invoice.id,
    });
  }
}
function apply(
  store: BackOfficeStore,
  state: TimesheetState,
  actor: BackOfficeActor,
  command: TimesheetCommand,
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
    if (p.reviewerId && !state.people.some((v) => v.id === p.reviewerId))
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
    validateDraft(state, d);
    if (command.source === "suggestion" && !command.proposalDigest)
      timeError("A suggestion must reference its private original.");
    if (
      command.source === "suggestion" &&
      state.entries.some(
        (e) => e.authorId === actor.userId && e.proposalDigest === command.proposalDigest,
      )
    )
      timeError("This suggestion has already been recorded.", 409);
    const workers = [...new Set(command.workerIds ?? [actor.userId])];
    if (workers.some((id) => !state.people.some((p) => p.id === id)))
      timeError("Choose a current account for each participant.");
    const product = ensureProduct(store, scope, state, actor.userId, d);
    const { createWorkProduct: _create, ...billingFields } = d;
    for (const workerId of workers) {
      const e: TimeEntry = {
        ...billingFields,
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
      writeEntry(store, scope, actor, null, { ...e, ...snapshotRate(state, e) }, "create");
    }
    return;
  }
  if (command.type === "update") {
    const e = requireEntry(state, command);
    if (e.workerId !== actor.userId || !["pending", "confirmed", "submitted"].includes(e.status))
      timeError("This entry cannot be edited by this person.", 403);
    validateDraft(state, command.entry);
    const d = command.entry,
      product = ensureProduct(store, scope, state, actor.userId, d);
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
      workProductId: product?.id,
      workProductTitle: product?.name,
      status: e.status === "submitted" ? "confirmed" : e.status,
    };
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
  if (command.type === "invoice") {
    if (
      command.templateRevision !== undefined &&
      command.templateRevision !== (state.template?.revision ?? 0)
    )
      timeError("The template changed. Review the new preview before issuing.", 409);
    issue(store, state, actor, selection, command.adjustmentVersions ?? []);
    return;
  }
  for (const e of selection) {
    let status: TimeEntry["status"];
    if (command.type === "approve" || command.type === "return") {
      requireReviewer(state, e, actor);
      if (e.status !== "submitted") timeError("Review a submitted revision.", 409);
      status = command.type === "approve" ? "approved" : "confirmed";
    } else {
      if (e.workerId !== actor.userId)
        timeError("Only the worker can confirm or submit this entry.", 403);
      if (command.type === "submit" ? e.status !== "confirmed" : e.status !== "pending")
        timeError("The entry is no longer at this stage.", 409);
      status =
        command.type === "submit" ? "submitted" : command.type === "confirm" ? "confirmed" : "declined";
    }
    if (["approved", "submitted", "confirmed"].includes(status) && command.type !== "return")
      validateDraft(state, e, status === "approved");
    const next: TimeEntry = {
      ...e,
      status,
      suggestion: status === "submitted" ? suggestion(state, e) : undefined,
      submittedNarrative: status === "submitted" ? e.narrative : e.submittedNarrative,
    };
    if (status === "approved" && e.policyDigest !== snapshotRate(state, e).policyDigest)
      timeError(
        "The applicable billing terms changed. Review the entry again or return it for resubmission.",
        409,
      );
    if (status === "submitted" || status === "approved") Object.assign(next, snapshotRate(state, next));
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
        apply(store, state, actor, command);
        writeTimeDocument(store, scope, { kind: "request", id, digest: hash });
      } else apply(store, state, actor, command);
      return readTimesheet(store, scope, actor, people, workspaces);
    },
    { actor, action: "timesheet." + command.type },
  );
}
