import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { budgetRateManifest, budgetRateManifestSha256 } from "./budget-rates.mjs";
import { verifyBudgetAudit } from "./budget-audit.mjs";
import { evidenceHash, sha256, eurToCeilingMicros, verifiedReconciliationPlan } from "./budget-reconciliation.mjs";
import { externalCostDebits, scopedExternalEntries, verifiedBudgetScopeDecision } from "./budget-scope.mjs";

import { validatedBudgetCeiling, verifiedBudgetCeilingAuthorization, verifiedBudgetRunCoverage } from "./budget-ceiling.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const ceilingMicros = 100_000_000;
const routes = new Set(["/chat/completions", "/v1/chat/completions"]);
const fields = new Set([
  "model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
  "temperature", "top_p", "n", "best_of", "stop", "presence_penalty", "frequency_penalty",
  "logit_bias", "user", "seed", "logprobs", "top_logprobs", "tools", "tool_choice",
  "parallel_tool_calls", "functions", "function_call", "response_format", "prediction",
  "reasoning_effort", "reasoning", "thinking", "verbosity", "store", "metadata",
  "cache_control", "prompt_cache_key", "prompt_cache_retention", "safety_identifier", "service_tier",
]);

export class BudgetGuardError extends Error {
  constructor(code, message) { super(message); this.name = "BudgetGuardError"; this.code = code; }
}

function fail(code, message) { throw new BudgetGuardError(code, message); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function micros(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("invalid_amount", "EUR amounts must be finite and nonnegative");
  const amount = Math.ceil(value * 1_000_000 - 1e-8);
  if (!integer(amount)) fail("invalid_amount", "EUR amount is not a safe integer number of microeuros");
  return amount;
}
const eur = amount => amount / 1_000_000;
function tokenCost(input, output, rate) {
  return Number((BigInt(input) * BigInt(rate.inputMicrosPerMillion)
    + BigInt(output) * BigInt(rate.outputMicrosPerMillion) + 999_999n) / 1_000_000n);
}

function checkModalities(messages) {
  for (const message of messages) {
    if (!message || typeof message !== "object") fail("unsupported_request", "Invalid chat message");
    if (message.content === undefined || message.content === null || typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) fail("unpriced_modality", "Only audited text, images and native PDFs are priced for this test run");
    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string") continue;
      if (part?.type === "image_url" && typeof part.image_url?.url === "string"
        && /^(?:https?:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(part.image_url.url)) continue;
      if (part?.type === "file" && typeof part.file?.file_data === "string"
        && (/^data:application\/pdf;base64,/i.test(part.file.file_data)
          || (/\.pdf$/i.test(part.file.filename ?? "") && /^[a-zA-Z0-9+/=\r\n]+$/.test(part.file.file_data)))) continue;
      fail("unpriced_modality", "Audio, video and other file modalities need a separate audited price bound; nothing was sent or removed");
    }
  }
}

function requestBound({ model, route, body }) {
  const rate = budgetRateManifest.models[model];
  if (!rate) fail("unpriced_model", "Model has no audited migration budget bound");
  if (!routes.has(route)) fail("unpriced_route", "This inference route needs an audited pricing contract before a paid benchmark");
  if (!body || typeof body !== "object" || Array.isArray(body) || body.model !== model || !Array.isArray(body.messages)) {
    fail("unsupported_request", "Expected an unchanged OpenAI-compatible chat request");
  }
  if (Object.keys(body).some(key => !fields.has(key))) {
    fail("unpriced_parameter", "Request contains an unaudited inference parameter; nothing was sent or stripped");
  }
  checkModalities(body.messages);
  if (body.tools !== undefined && (!Array.isArray(body.tools)
    || body.tools.some(tool => !tool || tool.type !== "function" || !tool.function || typeof tool.function.name !== "string"))) {
    fail("unpriced_builtin_tool", "Provider-hosted tools need a separate price bound; ordinary function tools remain supported");
  }
  // Modalities in messages are processed as model input tokens. Generated
  // audio, grounding, search, batches and externally retained caches are not
  // silently accepted under a text-generation tariff.
  let multiplicity = 1;
  for (const field of ["n", "best_of"]) {
    const count = body[field] ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(multiplicity * count)) {
      fail("unsupported_request", "Completion multiplicity must be a positive safe integer");
    }
    multiplicity *= count;
  }
  const reservedMicros = tokenCost(rate.inputTokens, rate.outputTokens, rate) * multiplicity;
  if (!integer(reservedMicros)) fail("unsupported_request", "Request has no finite safe budget bound");
  return { rate, reservedMicros, multiplicity };
}

function used(state, scopeEvidence, ceilingEvidence) {
  let accountedMicros = 0;
  let reservedMicros = 0;
  let reportedMicros = 0;
  for (const entry of Object.values(state.entries)) {
    if (!["inference", "external"].includes(entry.kind) || !integer(entry.reservedMicros)
      || !["reserved", "uncertain", "settled"].includes(entry.status)) {
      fail("invalid_ledger", "Budget ledger contains an invalid entry; it was not reset");
    }
    if (entry.status === "settled") {
      if (!integer(entry.accountedMicros)) fail("invalid_ledger", "Budget ledger contains an invalid settlement");
      accountedMicros += entry.accountedMicros;
    } else reservedMicros += entry.reservedMicros;
    if (entry.reportedMicros !== null && entry.reportedMicros !== undefined) {
      if (!integer(entry.reportedMicros)) fail("invalid_ledger", "Budget ledger contains an invalid reported cost");
      reportedMicros += entry.reportedMicros;
    }
  }
  const historicalAccountedMicros = accountedMicros;
  const historicalReservedMicros = reservedMicros;
  const reconciled = reconciledDebits(state);
  let evidencedMicros = 0;
  for (const [id, debit] of reconciled) {
    const entry = state.entries[id];
    if (entry.status === "settled") accountedMicros -= entry.accountedMicros;
    else reservedMicros -= entry.reservedMicros;
    accountedMicros += debit.accountedMicros;
    evidencedMicros += debit.accountedMicros;
  }
  if (![accountedMicros, reservedMicros, reportedMicros, evidencedMicros].every(integer)) fail("invalid_ledger", "Budget ledger totals are invalid");
  const excluded = scopedExternalEntries(state, scopeEvidence, ceilingEvidence);
  const externalDebits = externalCostDebits(state, excluded);
  let externalAccountedMicros = 0, externalReservedMicros = 0, externalReportedMicros = 0;
  for (const id of excluded) {
    const entry = state.entries[id];
    if (entry.status === "settled") accountedMicros -= entry.accountedMicros;
    else reservedMicros -= entry.reservedMicros;
    reportedMicros -= entry.reportedMicros ?? 0;
    const debit = externalDebits.get(id);
    if (debit) {
      externalAccountedMicros += debit.accountedMicros;
      externalReportedMicros += debit.accountedMicros;
    } else if (entry.status === "settled") {
      externalAccountedMicros += entry.accountedMicros;
      externalReportedMicros += entry.reportedMicros ?? 0;
    } else externalReservedMicros += entry.reservedMicros;
  }
  const allAccountedMicros = accountedMicros + externalAccountedMicros;
  const allReservedMicros = reservedMicros + externalReservedMicros;
  if (![accountedMicros, reservedMicros, reportedMicros, allAccountedMicros, allReservedMicros,
    externalAccountedMicros, externalReservedMicros, externalReportedMicros].every(integer)) fail("invalid_ledger", "Scoped financial totals are invalid");
  return { accountedMicros, reservedMicros, reportedMicros, usedMicros: accountedMicros + reservedMicros,
    historicalAccountedMicros, historicalReservedMicros, evidencedMicros, reconciled,
    allAccountedMicros, allReservedMicros, externalAccountedMicros, externalReservedMicros, externalReportedMicros,
    excluded, externalDebits };
}

function reconciledDebits(state) {
  const debits = new Map();
  const batches = new Set();
  if (state.version === 1) {
    if (state.reconciliations !== undefined || state.reconciliationIncreases !== undefined) fail("invalid_ledger", "Reconciled accounting requires ledger schema v2");
    return debits;
  }
  if (!Array.isArray(state.reconciliations) || !state.reconciliations.length || !Array.isArray(state.reconciliationIncreases)) {
    fail("invalid_ledger", "Schema v2 requires preserved reconciliation records");
  }
  for (const batch of state.reconciliations) {
    const plan = batch.plan;
    if (!plan || batch.id !== evidenceHash(plan) || batches.has(batch.id) || plan.version !== 1
      || plan.kind !== "reviewed-gateway-debits" || plan.manifestSha256 !== state.manifestSha256
      || plan.ledgerCreatedAt !== state.createdAt || !Array.isArray(plan.entries) || !plan.entries.length) {
      fail("invalid_ledger", "Invalid or duplicated reconciliation batch");
    }
    batches.add(batch.id);
    let sum = 0;
    const gatewayIds = new Set();
    for (const row of plan.entries) {
      const entry = state.entries[row.entryId];
      if (!entry || entry.kind !== "inference" || entry.requestId !== row.requestId || debits.has(row.entryId)
        || gatewayIds.has(row.gatewayRequestId) || row.originalEntrySha256 !== evidenceHash(entry)
        || !integer(row.accountedMicros) || row.accountedMicros !== eurToCeilingMicros(row.gatewaySpendEur)
        || row.accountedMicros > entry.reservedMicros || row.accountedMicros < (entry.reportedMicros ?? 0)) {
        fail("invalid_ledger", "Reconciled entry, original financial record or charge changed");
      }
      gatewayIds.add(row.gatewayRequestId);
      sum += row.accountedMicros;
      debits.set(row.entryId, { batchId: batch.id, accountedMicros: row.accountedMicros });
    }
    if (!integer(sum) || sum !== plan.accountedMicros) fail("invalid_ledger", "Reconciliation total differs");
  }
  const increases = new Set();
  for (const event of state.reconciliationIncreases) {
    const { at, id, ...identity } = event;
    const debit = debits.get(event.entryId);
    if (!debit || debit.batchId !== event.batchId || event.source !== "late-gateway-cost-header"
      || id !== evidenceHash(identity) || increases.has(id) || !integer(event.accountedMicros)
      || event.accountedMicros <= debit.accountedMicros || typeof at !== "string") {
      fail("invalid_ledger", "Invalid, duplicated or decreasing reconciliation adjustment");
    }
    increases.add(id);
    debit.accountedMicros = event.accountedMicros;
  }
  return debits;
}

function validate(state, limitMicros, scopeEvidence, ceilingEvidence) {
  if (![1, 2, 3].includes(state.version) || state.currency !== "EUR" || (limitMicros !== undefined && state.limitMicros !== limitMicros)
    || state.manifestSha256 !== budgetRateManifestSha256 || !state.entries || Array.isArray(state.entries)
    || !Array.isArray(state.violations)) {
    fail("incompatible_ledger", "Budget ledger limit, currency or pricing manifest differs; explicit reconciliation is required and no reset occurred");
  }
  validatedBudgetCeiling(state, ceilingEvidence);
  used(state, scopeEvidence, ceilingEvidence);
}

async function save(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

function reportedCost(headers) {
  const value = typeof headers?.get === "function" ? headers.get("x-litellm-response-cost") : headers?.["x-litellm-response-cost"];
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1_000_000 ? eurToCeilingMicros(number) : null;
}

function ledgerPathOutsideRepository(ledgerPath) {
  if (typeof ledgerPath !== "string" || !isAbsolute(ledgerPath)) fail("invalid_path", "An absolute persistent budget ledger path outside the repository is required");
  const path = resolve(ledgerPath);
  const fromRepository = relative(repository, path);
  if (fromRepository === "" || (!fromRepository.startsWith(`..${sep}`) && fromRepository !== ".." && !isAbsolute(fromRepository))) {
    fail("invalid_path", "Keep the migration budget ledger outside Git and reuse it for every benchmark arm");
  }
  return path;
}

async function ledgerTransaction({ path, limitMicros, lockTimeoutMs = 10_000, readOnly = false, requireExisting = false, includeLedgerHash = false, scopeEvidence, ceilingEvidence }, fn) {
  const lock = `${path}.lock`;
  const initialized = `${path}.initialized`;
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("ledger_locked", "The budget ledger is locked; check the owning process before manual recovery. No stale lock was discarded");
      await setTimeout(10);
    }
  }
  try {
    let state, original;
    try { original = await readFile(path, "utf8"); state = JSON.parse(original); }
    catch (error) {
      if (error.code !== "ENOENT") fail("invalid_ledger", "Budget ledger could not be read; no reset occurred");
      if (requireExisting || readOnly) fail("missing_ledger", "Reconciliation requires the existing ledger; no allowance was created");
      try { await readFile(initialized); fail("missing_ledger", "An initialized budget ledger is missing; restore it before continuing. No new allowance was created"); }
      catch (markerError) { if (markerError.code !== "ENOENT") throw markerError; }
      state = { version: 1, currency: "EUR", limitMicros, manifestSha256: budgetRateManifestSha256,
        createdAt: new Date().toISOString(), entries: {}, violations: [] };
    }
    validate(state, limitMicros, scopeEvidence, ceilingEvidence);
    if (readOnly || requireExisting) {
      if ((await readFile(initialized, "utf8")).trim() !== state.createdAt) fail("invalid_ledger", "Original ledger marker differs");
    } else {
      try {
        const marker = await open(initialized, "wx", 0o600);
        try { await marker.writeFile(`${state.createdAt}\n`); await marker.sync(); }
        finally { await marker.close(); }
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const result = await fn(state, { originalSha256: original === undefined ? null : sha256(original), originalBytes: original });
    if (!readOnly && result?.ledgerWrite !== false) {
      state.updatedAt = new Date().toISOString();
      await save(path, state);
    }
    if (includeLedgerHash) result.ledgerAfterSha256 = !readOnly && result?.ledgerWrite !== false
      ? sha256(`${JSON.stringify(state)}\n`) : sha256(original);
    return result;
  } finally { await rm(lock, { recursive: true }); }
}

function healthOf(state, audit, scopeEvidence, ceilingEvidence) {
  const totals = used(state, scopeEvidence, ceilingEvidence);
  const ceiling = validatedBudgetCeiling(state, ceilingEvidence);
  const entries = Object.values(state.entries);
  const inference = entries.filter(entry => entry.kind === "inference");
  return { enforcement: "local-durable-worst-case-reservations", currency: "EUR", limitEur: eur(state.limitMicros),
    planningTargetEur: eur(ceiling.planningTargetMicros), planningTargetReached: totals.usedMicros >= ceiling.planningTargetMicros,
    authorizationSha256: ceiling.authorizationSha256,
    scope: state.version === 3 ? "migration-model-tokens-only" : "all-migration-model-tests-and-explicit-external-holds",
    verifiedAt: budgetRateManifest.verifiedAt,
    audit, ledgerVersion: state.version, manifestSha256: state.manifestSha256,
    accountedUpperBoundEur: eur(totals.accountedMicros), reportedSpendEur: eur(totals.reportedMicros),
    reservedEur: eur(totals.reservedMicros), committedUpperBoundEur: eur(totals.usedMicros),
    remainingEur: eur(Math.max(0, state.limitMicros - totals.usedMicros)), reservations: entries.length,
    modelBudgetScopeActive: state.version === 3,
    externalAccountedEur: eur(totals.externalAccountedMicros), externalReservedEur: eur(totals.externalReservedMicros),
    externalExposureEur: eur(totals.externalAccountedMicros + totals.externalReservedMicros),
    externalReportedEur: eur(totals.externalReportedMicros),
    externalInvoiceKnownForAllExcludedEntries: totals.excluded.size === 0 ? null
      : [...totals.excluded].every(id => totals.externalDebits.has(id) || state.entries[id].status === "settled"),
    externalHoldsExcludedFromModelBudget: totals.excluded.size,
    unclassifiedExternalEntriesInModelBudget: Object.entries(state.entries).filter(([id, entry]) => entry.kind === "external" && !totals.excluded.has(id)).length,
    allFinancialAccountedUpperBoundEur: eur(totals.allAccountedMicros),
    allFinancialReservedEur: eur(totals.allReservedMicros),
    allFinancialExposureEur: eur(totals.allAccountedMicros + totals.allReservedMicros),
    externalCostEvidenceEvents: state.externalCostEvents?.length ?? 0,
    externalCostEvidenceExceedingOriginalHold: [...totals.externalDebits].filter(([id, event]) => event.accountedMicros > state.entries[id].reservedMicros).length,
    uncertainReservations: Object.entries(state.entries).filter(([id, entry]) => entry.status === "uncertain" && !totals.reconciled.has(id)).length,
    historicalAccountedUpperBoundEur: eur(totals.historicalAccountedMicros),
    historicalReservedEur: eur(totals.historicalReservedMicros),
    historicalCommittedUpperBoundEur: eur(totals.historicalAccountedMicros + totals.historicalReservedMicros),
    historicalUncertainReservations: entries.filter(entry => entry.status === "uncertain").length,
    evidencedInferenceDebitEur: eur(totals.evidencedMicros), reconciledInferenceRequests: totals.reconciled.size,
    reconciledInferenceCostHeadersMissing: Object.entries(state.entries).filter(([id, entry]) => entry.kind === "inference"
      && totals.reconciled.has(id) && (entry.reportedMicros === null || entry.reportedMicros === undefined)).length,
    lateInferenceCostHeaderIncreases: state.reconciliationIncreases?.length ?? 0,
    inferenceCostHeadersReported: inference.filter(entry => entry.reportedMicros !== null && entry.reportedMicros !== undefined).length,
    inferenceCostHeadersMissing: inference.filter(entry => entry.reportedMicros === null || entry.reportedMicros === undefined).length,
    frozen: state.violations.length > 0, exhausted: totals.usedMicros >= state.limitMicros,
    notificationThresholdsReached: [50, 80, 95, 100].filter(percent => totals.usedMicros * 100 >= ceiling.planningTargetMicros * percent) };
}

/** Historical controller operation: dry-run never rewrites the ledger or marker. */
export async function reconcileReviewedBudgetLedger({ ledgerPath, evidence, apply = false, expectedLedgerSha256, lockTimeoutMs = 10_000, scopeEvidence, ceilingEvidence }) {
  const plan = verifiedReconciliationPlan(evidence);
  const path = ledgerPathOutsideRepository(ledgerPath);
  const batchId = evidenceHash(plan);
  return ledgerTransaction({ path, limitMicros: undefined, lockTimeoutMs, readOnly: !apply, requireExisting: true, includeLedgerHash: true, scopeEvidence, ceilingEvidence }, (state, { originalSha256 }) => {
    const before = healthOf(state, undefined, scopeEvidence, ceilingEvidence);
    const existing = state.reconciliations?.find(batch => batch.id === batchId);
    if (existing) return { ledgerWrite: false, batchId, idempotent: true, dryRun: !apply, ledgerBeforeSha256: originalSha256, before, after: before };
    if (apply && (!/^[a-f0-9]{64}$/.test(expectedLedgerSha256 ?? "") || expectedLedgerSha256 !== originalSha256)) {
      fail("ledger_changed", "Apply requires the exact quiescent ledger SHA256 reviewed in the dry-run");
    }
    if (state.createdAt !== plan.ledgerCreatedAt || state.manifestSha256 !== plan.manifestSha256 || state.violations.length) {
      fail("reconciliation_rejected", "Ledger identity, tariff contract or violation state differs");
    }
    const covered = used(state, scopeEvidence, ceilingEvidence).reconciled;
    for (const row of plan.entries) {
      const entry = state.entries[row.entryId];
      if (!entry || evidenceHash(entry) !== row.originalEntrySha256 || covered.has(row.entryId)) {
        fail("reconciliation_rejected", "Reviewed original entry changed, is missing or is already reconciled");
      }
    }
    for (const row of plan.preservedEntries) {
      if (!state.entries[row.entryId] || evidenceHash(state.entries[row.entryId]) !== row.originalEntrySha256) {
        fail("reconciliation_rejected", "An original external financial record changed");
      }
    }
    if (apply && Object.entries(state.entries).some(([id, entry]) => entry.kind === "inference" && entry.status === "reserved"
      && !plan.entries.some(row => row.entryId === id))) fail("ledger_not_quiescent", "An unreviewed inference reservation is still pending");
    if (state.version < 2) state.version = 2;
    state.reconciliations ??= [];
    state.reconciliationIncreases ??= [];
    state.reconciliations.push({ id: batchId, plan, appliedAt: new Date().toISOString() });
    validate(state, undefined, scopeEvidence, ceilingEvidence);
    return { batchId, idempotent: false, dryRun: !apply, ledgerBeforeSha256: originalSha256,
      preservedOriginalEntries: Object.keys(state.entries).length, reviewedInferenceRequests: plan.entries.length,
      before, after: healthOf(state, undefined, scopeEvidence, ceilingEvidence), qualifications: plan.qualifications };
  });
}

/** Scope changes preserve original records and are only applied at a reviewed,
 * quiescent controller boundary. No model or cloud request is made here. */
export async function applyReviewedBudgetScope({ ledgerPath, evidence, apply = false, expectedLedgerSha256, backupPath, lockTimeoutMs = 10_000, ceilingEvidence }) {
  const approved = verifiedBudgetScopeDecision(evidence);
  const path = ledgerPathOutsideRepository(ledgerPath);
  return ledgerTransaction({ path, limitMicros: undefined, lockTimeoutMs, readOnly: !apply,
    requireExisting: true, includeLedgerHash: true, scopeEvidence: evidence, ceilingEvidence }, async (state, { originalSha256, originalBytes }) => {
    const before = healthOf(state, undefined, evidence, ceilingEvidence);
    if (state.version === 3) return { ledgerWrite: false, idempotent: true, dryRun: !apply,
      ledgerBeforeSha256: originalSha256, before, after: before };
    if (state.version !== 2 || state.violations.length) fail("scope_rejected", "A valid reconciled schema2 ledger is required");
    if (apply && (!/^[a-f0-9]{64}$/.test(expectedLedgerSha256 ?? "") || expectedLedgerSha256 !== originalSha256)) {
      fail("ledger_changed", "Apply requires the exact quiescent ledger SHA256 reviewed in the dry-run");
    }
    if (apply && Object.values(state.entries).some(entry => entry.kind === "inference" && entry.status === "reserved")) {
      fail("ledger_not_quiescent", "Stop active inference guards before changing accounting scope");
    }
    const identity = { decisionSha256: approved.decisionSha256, decisionRaw: approved.decisionRaw,
      decisionPath: approved.decisionPath, ledgerBeforeSha256: originalSha256 };
    state.version = 3;
    state.budgetScopeEvents = [{ ...identity, id: evidenceHash(identity), appliedAt: new Date().toISOString() }];
    state.externalCostEvents = [];
    validate(state, undefined, evidence, ceilingEvidence);
    if (apply) {
      if (!backupPath) fail("scope_backup_required", "Apply requires a new private path for the unchanged original ledger backup");
      const backup = ledgerPathOutsideRepository(backupPath);
      if (backup === path) fail("scope_backup_required", "The original backup must use a separate new path");
      const handle = await open(backup, "wx", 0o400);
      try { await handle.writeFile(originalBytes); await handle.sync(); }
      finally { await handle.close(); }
      const parent = await open(dirname(backup), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return { idempotent: false, dryRun: !apply, ledgerBeforeSha256: originalSha256,
      preservedOriginalEntries: Object.keys(state.entries).length, decisionSha256: approved.decisionSha256,
      originalBackup: apply ? { path: resolve(backupPath), sha256: originalSha256 } : null,
      before, after: healthOf(state, undefined, evidence, ceilingEvidence) };
  });
}

/** Controller-only explicit ceiling application; original financial history is
 * preserved. The same ledger lock covers validation, immutable backup and save. */
export async function applyReviewedBudgetCeiling({ ledgerPath, evidence, apply = false, expectedLedgerSha256,
  backupPath, lockTimeoutMs = 10_000, scopeEvidence }) {
  const approved = verifiedBudgetCeilingAuthorization(evidence);
  const path = ledgerPathOutsideRepository(ledgerPath);
  return ledgerTransaction({ path, limitMicros: undefined, lockTimeoutMs, readOnly: !apply,
    requireExisting: true, includeLedgerHash: true, scopeEvidence, ceilingEvidence: evidence }, async (state, { originalSha256, originalBytes }) => {
    const before = healthOf(state, undefined, scopeEvidence, evidence);
    if (state.budgetAuthorizationEvents !== undefined) return { ledgerWrite: false, idempotent: true, dryRun: !apply,
      ledgerBeforeSha256: originalSha256, before, after: before };
    if (state.version !== 3 || state.limitMicros !== approved.authorization.originalLimitMicros || state.violations.length) {
      fail("authorization_rejected", "A valid token-scoped schema3 ledger at its original ceiling is required");
    }
    if (apply && (!/^[a-f0-9]{64}$/.test(expectedLedgerSha256 ?? "") || expectedLedgerSha256 !== originalSha256)) {
      fail("ledger_changed", "Apply requires the exact quiescent ledger SHA256 reviewed in the dry-run");
    }
    if (Object.values(state.entries).some(entry => entry.kind === "inference" && entry.status === "reserved")) {
      fail("ledger_not_quiescent", "Stop active inference guards before authorizing the new ceiling");
    }
    const identity = { authorizationSha256: approved.authorizationSha256, authorizationRaw: approved.authorizationRaw,
      authorizationPath: approved.authorizationPath, ledgerBeforeSha256: originalSha256 };
    state.limitMicros = approved.authorization.hardLimitMicros;
    state.budgetAuthorizationEvents = [{ ...identity, id: evidenceHash(identity), appliedAt: new Date().toISOString() }];
    validate(state, state.limitMicros, scopeEvidence, evidence);
    if (apply) {
      if (!backupPath) fail("authorization_backup_required", "Apply requires a new immutable original ledger backup");
      const backup = ledgerPathOutsideRepository(backupPath);
      if (backup === path) fail("authorization_backup_required", "Backup must use a separate new path");
      const handle = await open(backup, "wx", 0o400);
      try { await handle.writeFile(originalBytes); await handle.sync(); } finally { await handle.close(); }
      const parent = await open(dirname(backup), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return { idempotent: false, dryRun: !apply, ledgerBeforeSha256: originalSha256,
      authorizationSha256: approved.authorizationSha256, preservedOriginalEntries: Object.keys(state.entries).length,
      originalBackup: apply ? { path: resolve(backupPath), sha256: originalSha256 } : null,
      before, after: healthOf(state, undefined, scopeEvidence, evidence) };
  });
}

export async function createBudgetGuard({ ledgerPath, totalEur = 100, lockTimeoutMs = 10_000, auditAttestation, scopeEvidence, ceilingEvidence, runCoverage } = {}) {
  const audit = verifyBudgetAudit(auditAttestation);
  const path = ledgerPathOutsideRepository(ledgerPath);
  const limitMicros = micros(totalEur);
  if (limitMicros <= 0 || (limitMicros > ceilingMicros && limitMicros !== 250_000_000)) fail("invalid_limit", "Only the original ceiling or the reviewed EUR250 authorization is supported");
  const coverage = limitMicros > ceilingMicros ? verifiedBudgetRunCoverage(runCoverage) : undefined;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const transaction = fn => ledgerTransaction({ path, limitMicros, lockTimeoutMs, scopeEvidence, ceilingEvidence, requireExisting: limitMicros > ceilingMicros }, fn);
  function admit(state, entry) {
    if (state.violations.length) fail("budget_frozen", "The budget is frozen after a pricing/accounting discrepancy");
    if (typeof entry.requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(entry.requestId)) fail("invalid_request_id", "A stable nonsecret request identifier is required");
    if (Object.values(state.entries).some(existing => existing.requestId === entry.requestId)) fail("duplicate_request", "This request identifier has already reserved budget; network retries need their own reservation");
    if (used(state, scopeEvidence, ceilingEvidence).usedMicros + entry.reservedMicros > state.limitMicros) {
      fail("budget_exhausted", "Insufficient unreserved budget for this complete request. No output cap was inserted and nothing was sent");
    }
    const id = randomUUID();
    state.entries[id] = { ...entry, status: "reserved", accountedMicros: null, reportedMicros: null, createdAt: new Date().toISOString() };
    state.entries[id].auditSnapshotSha256 = audit.snapshotSha256;
    if (coverage && entry.kind === "inference") state.entries[id].budgetRunCoverage = coverage;
    return { id, reservedMicros: entry.reservedMicros, manifestSha256: budgetRateManifestSha256 };
  }
  function entryFor(state, token, kind) {
    const entry = state.entries[token?.id];
    if (!entry || entry.kind !== kind || token.reservedMicros !== entry.reservedMicros || token.manifestSha256 !== state.manifestSha256) {
      fail("unknown_reservation", "Reservation does not belong to this ledger and pricing contract");
    }
    return entry;
  }
  function settle(state, entry, accountedMicros, reportedMicros, evidence) {
    if (entry.status === "settled") return { status: "settled", accountedMicros: entry.accountedMicros, idempotent: true };
    if (accountedMicros > entry.reservedMicros || (reportedMicros !== null && reportedMicros > entry.reservedMicros)) {
      state.violations.push({ kind: "reservation_exceeded", requestId: entry.requestId, at: new Date().toISOString() });
      entry.status = "uncertain";
      return { status: "uncertain", frozen: true, reservedMicros: entry.reservedMicros };
    }
    Object.assign(entry, { status: "settled", accountedMicros, reportedMicros, evidence, settledAt: new Date().toISOString() });
    return { status: "settled", accountedMicros, reportedMicros };
  }
  const guard = {
    async reserve(input) {
      const bound = requestBound(input);
      return transaction(state => admit(state, { kind: "inference", requestId: input.requestId,
        model: input.model, route: input.route, reservedMicros: bound.reservedMicros, multiplicity: bound.multiplicity }));
    },
    async reconcile(token, { httpStatus, responseHeaders, usage, completed, error, cancelled } = {}) {
      return transaction(state => {
        const entry = entryFor(state, token, "inference");
        const evidenced = used(state, scopeEvidence, ceilingEvidence).reconciled.get(token.id);
        if (evidenced) {
          const reported = reportedCost(responseHeaders);
          if (reported !== null && reported > evidenced.accountedMicros) {
            const identity = { batchId: evidenced.batchId, entryId: token.id, accountedMicros: reported, source: "late-gateway-cost-header" };
            state.reconciliationIncreases.push({ ...identity, id: evidenceHash(identity), at: new Date().toISOString() });
            if (reported > entry.reservedMicros || used(state, scopeEvidence, ceilingEvidence).usedMicros > state.limitMicros) {
              state.violations.push({ kind: "reconciled_cost_increased_beyond_bound", requestId: entry.requestId, at: new Date().toISOString() });
            }
            return { status: "evidenced", accountedMicros: reported, historicalStatus: entry.status, increased: true,
              frozen: state.violations.length > 0 };
          }
          return { status: "evidenced", accountedMicros: evidenced.accountedMicros, historicalStatus: entry.status, idempotent: true, ledgerWrite: false };
        }
        if (entry.status === "settled") return { status: "settled", accountedMicros: entry.accountedMicros, idempotent: true };
        const hold = () => { entry.status = "uncertain"; return { status: "uncertain", reservedMicros: entry.reservedMicros }; };
        // HTTP errors, interrupted streams and missing usage are not evidence
        // that the provider incurred no charge. Never refund them on a timer.
        if (httpStatus !== 200 || completed !== true || usage?.complete !== true || error || cancelled
          || usage.errors?.length || !integer(usage?.input) || !integer(usage?.output)) return hold();
        const rate = budgetRateManifest.models[entry.model];
        const cacheRead = usage.cacheRead ?? 0;
        const cacheWrite = usage.cacheWrite ?? 0;
        const reasoning = usage.reasoning ?? 0;
        if (![cacheRead, cacheWrite, reasoning].every(integer)) return hold();
        // Adding categories even when a transport already includes them is
        // intentional conservative accounting, never an output transformation.
        const input = usage.input + cacheRead + cacheWrite;
        const output = usage.output + reasoning;
        if (!integer(input) || !integer(output) || input > rate.inputTokens * entry.multiplicity
          || output > rate.outputTokens * entry.multiplicity) return hold();
        const upperBound = tokenCost(input, output, rate);
        const reported = reportedCost(responseHeaders);
        return settle(state, entry, Math.max(upperBound, reported ?? 0), reported, "complete-response-usage-upper-bound");
      });
    },
    async reserveExternal({ requestId, label, maxEur }) {
      if (typeof label !== "string" || !/^[a-zA-Z0-9 ._:-]{1,120}$/.test(label)) fail("invalid_label", "External budget holds need a nonsecret short label");
      const reservedMicros = micros(maxEur);
      if (!reservedMicros) fail("invalid_amount", "External budget holds must be positive");
      return transaction(state => admit(state, { kind: "external", requestId, label, reservedMicros }));
    },
    async settleExternal(token, { actualEur, evidenceId }) {
      if (typeof evidenceId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(evidenceId)) fail("invalid_evidence", "External debits require a nonsecret evidence identifier");
      const amount = micros(actualEur);
      return transaction(state => {
        const entry = entryFor(state, token, "external");
        const totals = used(state, scopeEvidence, ceilingEvidence);
        if (!totals.excluded.has(token.id)) return settle(state, entry, amount, amount, evidenceId);
        const prior = totals.externalDebits.get(token.id);
        const floor = prior?.accountedMicros ?? (entry.status === "settled" ? entry.accountedMicros : null);
        if (floor !== null && amount <= floor) return { status: "external-evidenced", accountedMicros: floor, idempotent: true, ledgerWrite: false };
        const identity = { entryId: token.id, accountedMicros: amount, evidenceId, source: "external-cost-evidence" };
        state.externalCostEvents.push({ ...identity, id: evidenceHash(identity), at: new Date().toISOString() });
        return { status: "external-evidenced", accountedMicros: amount,
          exceedsOriginalHold: amount > entry.reservedMicros, originalHoldPreserved: true };
      });
    },
    async health() {
      return transaction(state => ({ ...healthOf(state, audit, scopeEvidence, ceilingEvidence), runCoverage: coverage }));
    },
  };
  await guard.health();
  return guard;
}
