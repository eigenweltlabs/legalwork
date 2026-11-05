import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { evidenceHash, sha256 } from "./budget-reconciliation.mjs";
import { validatedBudgetCeiling } from "./budget-ceiling.mjs";

export const approvedBudgetScopeDecisionSha256 = "3b214cbd0905d2789a75da30822b66554fe8579722549c7afb9e9c6fdaac1cc3";
const verified = new WeakMap();
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function requireScope(condition, message) {
  if (!condition) throw new Error(`Budget scope rejected: ${message}`);
}

function decisionFromBytes(bytes, expectedSha256) {
  requireScope(digest(expectedSha256) && sha256(bytes) === expectedSha256, "independent decision hash differs");
  const decision = JSON.parse(bytes);
  requireScope(decision.kind === "migration-budget-scope-decision" && decision.version === 1
    && decision.scope === "migration-model-tokens-only" && decision.currency === "EUR"
    && decision.modelLimitMicros === 100_000_000 && typeof decision.ledgerCreatedAt === "string"
    && digest(decision.manifestSha256) && decision.originalFinancialEntriesPreserved === true
    && decision.externalCostsNotZero === true && Array.isArray(decision.excludedExternal)
    && decision.excludedExternal.length > 0, "decision does not preserve the approved financial contract");
  const ids = new Set();
  for (const row of decision.excludedExternal) {
    requireScope(typeof row.entryId === "string" && !ids.has(row.entryId)
      && digest(row.originalEntrySha256), "duplicate or invalid external identity");
    ids.add(row.entryId);
  }
  return decision;
}

/** Production uses the fixed root review pin. An explicit independent trust pin
 * also supports isolated evidence fixtures, just like reconciliation evidence. */
export async function verifyBudgetScopeDecision({ decisionPath, trustSha256 = approvedBudgetScopeDecisionSha256 }) {
  requireScope(typeof decisionPath === "string" && isAbsolute(decisionPath), "absolute decision path required");
  const info = await lstat(decisionPath);
  requireScope(info.isFile() && !info.isSymbolicLink(), "decision must be an ordinary file");
  const bytes = await readFile(decisionPath, "utf8");
  const decision = decisionFromBytes(bytes, trustSha256);
  const capability = Object.freeze({ decisionSha256: trustSha256 });
  verified.set(capability, { decision, decisionRaw: bytes, decisionPath, decisionSha256: trustSha256 });
  return capability;
}

export function verifiedBudgetScopeDecision(capability) {
  const value = verified.get(capability);
  requireScope(Boolean(value), "verified decision evidence is required");
  return structuredClone(value);
}

/** Validate the scope only after the guard has validated original financial and
 * reconciliation records. Unclassified external entries remain in the budget. */
export function scopedExternalEntries(state, evidence, ceilingEvidence) {
  if (state.version !== 3) {
    requireScope(state.budgetScopeEvents === undefined && state.externalCostEvents === undefined,
      "scope events require schema3");
    return new Set();
  }
  requireScope(Array.isArray(state.budgetScopeEvents) && state.budgetScopeEvents.length === 1
    && Array.isArray(state.externalCostEvents), "schema3 requires its explicit immutable scope event");
  const event = state.budgetScopeEvents[0];
  const { id, appliedAt, ...identity } = event;
  requireScope(id === evidenceHash(identity) && typeof appliedAt === "string"
    && digest(event.ledgerBeforeSha256) && typeof event.decisionPath === "string"
    && isAbsolute(event.decisionPath) && typeof event.decisionRaw === "string", "scope event changed");
  const expected = evidence ? verifiedBudgetScopeDecision(evidence).decisionSha256 : approvedBudgetScopeDecisionSha256;
  requireScope(event.decisionSha256 === expected, "scope decision is not independently approved");
  const decision = decisionFromBytes(event.decisionRaw, expected);
  requireScope(decision.ledgerCreatedAt === state.createdAt && decision.manifestSha256 === state.manifestSha256
    && decision.modelLimitMicros === validatedBudgetCeiling(state, ceilingEvidence).originalLimitMicros, "decision belongs to another ledger");
  const excluded = new Set();
  for (const row of decision.excludedExternal) {
    const entry = state.entries[row.entryId];
    requireScope(entry?.kind === "external" && evidenceHash(entry) === row.originalEntrySha256,
      "an original external financial record changed or an inference was excluded");
    excluded.add(row.entryId);
  }
  return excluded;
}

/** Billing evidence is appended; the original fingerprinted holds stay intact.
 * Higher late debits remain visible. A scope event never proves a zero invoice. */
export function externalCostDebits(state, excluded) {
  const debits = new Map(), ids = new Set();
  for (const event of state.externalCostEvents ?? []) {
    const { id, at, ...identity } = event;
    const previous = debits.get(event.entryId);
    const original = state.entries[event.entryId];
    const floor = previous?.accountedMicros ?? (original?.status === "settled" ? original.accountedMicros : null);
    requireScope(excluded.has(event.entryId) && id === evidenceHash(identity) && !ids.has(id)
      && typeof at === "string" && integer(event.accountedMicros)
      && typeof event.evidenceId === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(event.evidenceId)
      && event.source === "external-cost-evidence"
      && (floor === null || event.accountedMicros > floor), "external debit event is invalid or decreases prior evidence");
    ids.add(id);
    debits.set(event.entryId, event);
  }
  return debits;
}
