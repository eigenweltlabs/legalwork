import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { evidenceHash, sha256 } from "./budget-reconciliation.mjs";

export const approvedBudgetCeilingAuthorizationSha256 = "74e48a9f6bc052e69ebdb5daa53991606a643eac8cf07075e5fa78ed027c4e82";
const verified = new WeakMap();
const coverageRecords = new WeakMap();
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function requireAuthorization(condition, message) {
  if (!condition) throw new Error(`Budget authorization rejected: ${message}`);
}
function authorizationFromBytes(bytes, expected) {
  requireAuthorization(digest(expected) && sha256(bytes) === expected, "independent authorization hash differs");
  const value = JSON.parse(bytes);
  requireAuthorization(value.kind === "migration-token-budget-authorization" && value.version === 1
    && value.currency === "EUR" && value.scope === "migration-model-tokens-only"
    && value.planningTargetMicros === 100_000_000 && value.originalLimitMicros === 100_000_000
    && value.hardLimitMicros === 250_000_000 && typeof value.ledgerCreatedAt === "string"
    && digest(value.manifestSha256) && digest(value.scopeEventId) && digest(value.scopeDecisionSha256)
    && isAbsolute(value.authorizationEvidence?.path ?? "") && digest(value.authorizationEvidence?.sha256)
    && value.constraints?.necessaryMigrationFixesAndRetestsOnly === true
    && value.constraints.arbitraryExtraSpendingProhibited === true
    && value.constraints.perRunCoverageRationaleRequired === true
    && value.constraints.originalFinancialRecordsPreserved === true
    && value.constraints.externalCostsRemainSeparateAndNotAssumedZero === true
    && value.constraints.noRequestOrCapabilityReduction === true, "authorization financial contract differs");
  return value;
}
async function ordinaryFile(path) {
  requireAuthorization(typeof path === "string" && isAbsolute(path), "absolute evidence path required");
  const info = await lstat(path);
  requireAuthorization(info.isFile() && !info.isSymbolicLink(), "evidence must be an ordinary file");
  return readFile(path, "utf8");
}
/** Only fixture callers supply an independent trust pin. Neither CLI exposes it. */
export async function verifyBudgetCeilingAuthorization({ authorizationPath, trustSha256 = approvedBudgetCeilingAuthorizationSha256 }) {
  const authorizationRaw = await ordinaryFile(authorizationPath);
  const authorization = authorizationFromBytes(authorizationRaw, trustSha256);
  requireAuthorization(sha256(await ordinaryFile(authorization.authorizationEvidence.path)) === authorization.authorizationEvidence.sha256,
    "recorded user authorization evidence changed");
  const capability = Object.freeze({ authorizationSha256: trustSha256 });
  verified.set(capability, { authorization, authorizationRaw, authorizationPath, authorizationSha256: trustSha256 });
  return capability;
}
export function verifiedBudgetCeilingAuthorization(capability) {
  const value = verified.get(capability);
  requireAuthorization(Boolean(value), "verified user authorization is required");
  return structuredClone(value);
}
/** Original scope decisions remain anchored to EUR100; only this separately
 * pinned append-only event may increase the live admission boundary. */
export function validatedBudgetCeiling(state, evidence) {
  if (state.budgetAuthorizationEvents === undefined) {
    requireAuthorization(Number.isSafeInteger(state.limitMicros) && state.limitMicros > 0 && state.limitMicros <= 100_000_000,
      "an increased ceiling requires its approved event");
    return { originalLimitMicros: state.limitMicros, planningTargetMicros: state.limitMicros, hardLimitMicros: state.limitMicros };
  }
  requireAuthorization(state.version === 3 && Array.isArray(state.budgetAuthorizationEvents)
    && state.budgetAuthorizationEvents.length === 1, "exactly one schema3 authorization event is required");
  const event = state.budgetAuthorizationEvents[0];
  const { id, appliedAt, ...identity } = event;
  const expected = evidence ? verifiedBudgetCeilingAuthorization(evidence).authorizationSha256 : approvedBudgetCeilingAuthorizationSha256;
  requireAuthorization(id === evidenceHash(identity) && typeof appliedAt === "string"
    && digest(event.ledgerBeforeSha256) && isAbsolute(event.authorizationPath ?? "")
    && typeof event.authorizationRaw === "string" && event.authorizationSha256 === expected, "authorization event changed");
  const authorization = authorizationFromBytes(event.authorizationRaw, expected);
  requireAuthorization(authorization.ledgerCreatedAt === state.createdAt && authorization.manifestSha256 === state.manifestSha256
    && state.budgetScopeEvents?.length === 1 && state.budgetScopeEvents[0].id === authorization.scopeEventId
    && state.budgetScopeEvents[0].decisionSha256 === authorization.scopeDecisionSha256
    && state.limitMicros === authorization.hardLimitMicros, "authorization belongs to another ledger, scope or limit");
  return { originalLimitMicros: authorization.originalLimitMicros, planningTargetMicros: authorization.planningTargetMicros,
    hardLimitMicros: authorization.hardLimitMicros, authorizationSha256: expected, authorizationEventId: id };
}
/** Root reviews this private run plan before issuing paid admission. Its hash is
 * pinned in the private proxy config, which the admission packet also binds.
 * This records a rationale; it grants no new ceiling or pricing authority. */
export async function verifyBudgetRunCoverage({ coveragePath, expectedSha256 }) {
  const raw = await ordinaryFile(coveragePath);
  requireAuthorization(digest(expectedSha256) && sha256(raw) === expectedSha256, "run coverage hash differs");
  const value = JSON.parse(raw);
  requireAuthorization(value.kind === "migration-test-run-coverage" && value.version === 1
    && value.authorizationSha256 === approvedBudgetCeilingAuthorizationSha256
    && typeof value.runId === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value.runId)
    && typeof value.coverageRationale === "string" && value.coverageRationale.trim().length > 0
    && value.necessaryMigrationFixOrRetest === true, "each run needs its own justified migration coverage plan");
  const capability = Object.freeze({ coverageSha256: expectedSha256 });
  coverageRecords.set(capability, { ...value, coveragePath, coverageSha256: expectedSha256 });
  return capability;
}
export function verifiedBudgetRunCoverage(capability) {
  const value = coverageRecords.get(capability);
  requireAuthorization(Boolean(value), "a verified per-run migration coverage rationale is required");
  return structuredClone(value);
}

/** The paid runner uses the same immutable coverage record as the live guard.
 * Its authenticated health is necessary but cannot raise the original ceiling
 * without the pinned authorization and this exact suite/task coverage. */
export async function verifyPaidRunBudget(captureHealth, suite) {
  const budget = captureHealth?.budgetEvidence;
  requireAuthorization(captureHealth?.ok === true && captureHealth.bodyMutation === false
    && captureHealth.outputCaps === false && captureHealth.budgetGuardOperational === true
    && budget?.enforcement === "local-durable-worst-case-reservations" && budget.frozen === false
    && Number.isFinite(budget.limitEur) && budget.limitEur > 0 && Boolean(budget.manifestSha256),
  "paid runs require a live transparent durable reservation guard");
  if (budget.limitEur <= 100) return { limitEur: budget.limitEur, authorization: "original-ceiling" };
  requireAuthorization(budget.limitEur === 250 && budget.planningTargetEur === 100
    && budget.ledgerVersion === 3 && budget.scope === "migration-model-tokens-only"
    && budget.authorizationSha256 === approvedBudgetCeilingAuthorizationSha256,
  "increased paid-run ceiling requires the exact reviewed schema3 authorization");
  const reported = budget.runCoverage;
  requireAuthorization(Boolean(reported), "increased paid-run ceiling requires bound run coverage");
  const verifiedCoverage = await verifyBudgetRunCoverage({ coveragePath: reported.coveragePath,
    expectedSha256: reported.coverageSha256 });
  const coverage = verifiedBudgetRunCoverage(verifiedCoverage);
  requireAuthorization(isDeepStrictEqual(coverage, reported), "guard coverage differs from its exact ordinary-file evidence");
  const tasks = suite?.tasks?.map(task => task.id);
  requireAuthorization(Array.isArray(tasks) && tasks.length > 0 && tasks.every(id => typeof id === "string" && id)
    && new Set(tasks).size === tasks.length && Array.isArray(coverage.taskIDs)
    && isDeepStrictEqual([...coverage.taskIDs].sort(), [...tasks].sort()),
  "run coverage task identities differ from the actual paid suite");
  const suiteRaw = await ordinaryFile(coverage.suitePath);
  requireAuthorization(digest(coverage.suiteSha256) && sha256(suiteRaw) === coverage.suiteSha256
    && isDeepStrictEqual(JSON.parse(suiteRaw), suite), "run coverage suite bytes or parsed identity differ");
  return { limitEur: budget.limitEur, planningTargetEur: budget.planningTargetEur,
    authorizationSha256: budget.authorizationSha256, coverageSha256: coverage.coverageSha256,
    runId: coverage.runId, taskIDs: coverage.taskIDs, suiteSha256: coverage.suiteSha256 };
}
