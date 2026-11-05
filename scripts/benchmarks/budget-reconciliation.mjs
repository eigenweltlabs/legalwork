import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { auditedGatewayDeployments, budgetRateManifestSha256 } from "./budget-rates.mjs";

const verified = new WeakMap();
export const approvedHistoricalReconciliation = Object.freeze({
  receiptSha256: "57866ed7e5f39f059b54bae13538c85f09ab23815da6421dba378c38b02946d7",
  reviewSha256: "72e14e304ee39559417215aa326cd75c5e5bab06e9620e981ec0b6b1419b76a5",
  requests: 139,
  accountedMicros: 4_322_998,
  cancelledRequestIds: Object.freeze(["25d58784-d331-411e-9a77-ac7bcb6a0e0c"]),
});
export const approvedFollowupReconciliation = Object.freeze({
  receiptSha256: "a65ab95a45f806a496d7ed7c329f77d9a0fa1a17550d8b4d0cf3759ff8d6a7db",
  reviewSha256: "1b03a8214aaa9e3986deec8f535a821011c65e5897bf65080c7ea9991ea9bf12",
  draftSha256: "5c987310923a39e67907f4bf3d5afea249cd500fd2486e9b5f0c418b63db6cde",
  requests: 188,
  priorRequests: 139,
  totalRequests: 327,
  accountedMicros: 3_945_028,
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const evidenceHash = value => sha256(canonicalJson(value));
function requireEvidence(condition, message) { if (!condition) throw new Error(`Reconciliation evidence rejected: ${message}`); }
const sameCharge = (left, right) => typeof left === "number" && typeof right === "number"
  && Number.isFinite(left) && Number.isFinite(right)
  && Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right));

/** Decimal arithmetic prevents floating point rounding from releasing a microeuro. */
export function eurToCeilingMicros(value) {
  requireEvidence(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000, "invalid EUR charge");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  requireEvidence(Boolean(match), "invalid decimal charge");
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - fraction.length + 6;
  const numerator = BigInt(match[1] + fraction);
  const divisor = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
  const amount = exponent < 0 ? (numerator + divisor - 1n) / divisor : numerator * 10n ** BigInt(exponent);
  requireEvidence(amount <= BigInt(Number.MAX_SAFE_INTEGER), "charge is not a safe microeuro amount");
  return Number(amount);
}

async function bytesAt(path, expected) {
  requireEvidence(typeof path === "string" && isAbsolute(path), "absolute evidence path required");
  requireEvidence(/^[a-f0-9]{64}$/.test(expected), "independent SHA256 required");
  const info = await lstat(path);
  requireEvidence(info.isFile() && !info.isSymbolicLink(), "evidence must be an ordinary file");
  const bytes = await readFile(path);
  requireEvidence(sha256(bytes) === expected, "file hash changed");
  return bytes;
}
async function jsonAt(path, expected) { return JSON.parse(await bytesAt(path, expected)); }

/** The caller supplies independent review pins. The CLI uses only the approved fixed pins. */
export async function verifyBudgetReconciliation({ receiptPath, reviewPath, trust = approvedHistoricalReconciliation }) {
  trust = structuredClone(trust);
  const receipt = await jsonAt(receiptPath, trust.receiptSha256);
  const review = await jsonAt(reviewPath, trust.reviewSha256);
  requireEvidence(review.receiptSha256 === trust.receiptSha256 && review.ledgerChanged === false
    && review.mappedRequests === trust.requests && review.perRequestRoundedUpMicros === trust.accountedMicros,
  "independent review does not approve this receipt and batch");
  requireEvidence(/^[a-f0-9]{64}$/.test(receipt.keyHash) && Array.isArray(receipt.evidenceFiles), "missing key or evidence index");
  const files = new Map();
  for (const reference of receipt.evidenceFiles) {
    requireEvidence(!files.has(reference.path), "duplicate evidence path");
    files.set(reference.path, { reference, bytes: await bytesAt(reference.path, reference.sha256) });
  }
  function indexed(suffix) {
    const matches = [...files].filter(([path]) => path.endsWith(`/${suffix}`));
    requireEvidence(matches.length === 1, "missing or ambiguous indexed evidence");
    return JSON.parse(matches[0][1].bytes);
  }
  const mapping = indexed("local-to-gateway-mapping.json");
  const collection = indexed("attempt3-stable-read/collection.receipt.json");
  const pages = [...files].filter(([path]) => /\/attempt3-stable-read\/spend-page-\d+\.json$/.test(path))
    .map(([, file]) => JSON.parse(file.bytes)).sort((left, right) => left.sanitized.page - right.sanitized.page);
  requireEvidence(collection.key.hash === receipt.keyHash && collection.logs.completePagination === true
    && collection.logs.expectedTotal === trust.requests && pages.length === collection.logs.expectedPages, "incomplete key-filtered pagination");
  const rows = [];
  for (const [index, page] of pages.entries()) {
    requireEvidence(page.httpStatus === 200 && page.query.api_key === receipt.keyHash && page.sanitized.page === index + 1
      && page.sanitized.total === trust.requests && page.sanitized.total_pages === pages.length, "wrong key or inconsistent page");
    rows.push(...page.sanitized.records);
  }
  requireEvidence(rows.length === trust.requests && mapping.length === trust.requests, "missing or extra request IDs");
  requireEvidence(new Set(rows.map(row => row.request_id)).size === rows.length, "duplicate gateway ID");
  const snapshotReference = collection.ledger.snapshot;
  const snapshotFile = files.get(snapshotReference.path);
  requireEvidence(snapshotFile?.reference.sha256 === snapshotReference.sha256, "unindexed original ledger snapshot");
  const snapshot = JSON.parse(snapshotFile.bytes);
  requireEvidence(sha256(`${JSON.stringify(snapshot)}\n`) === receipt.ledger.sha256
    && collection.ledger.originalSha256 === receipt.ledger.sha256, "original ledger snapshot changed");
  requireEvidence(snapshot.version === 1 && snapshot.currency === "EUR" && snapshot.limitMicros === 100_000_000
    && snapshot.manifestSha256 === budgetRateManifestSha256, "wrong original budget contract");
  const originals = Object.entries(snapshot.entries).filter(([, entry]) => entry.kind === "inference");
  requireEvidence(originals.length === trust.requests, "snapshot request count differs");
  const localIds = new Set(), ledgerIds = new Set(), gatewayIds = new Set();
  const entries = [];
  for (const item of mapping) {
    const id = item.ledger?.id;
    const original = snapshot.entries[id];
    requireEvidence(original?.kind === "inference" && original.requestId === item.localId && !localIds.has(item.localId)
      && !ledgerIds.has(id) && !gatewayIds.has(item.gateway?.request_id), "duplicate or unknown mapping ID");
    localIds.add(item.localId); ledgerIds.add(id); gatewayIds.add(item.gateway.request_id);
    const gateway = rows.find(row => row.request_id === item.gateway.request_id);
    requireEvidence(gateway && canonicalJson(gateway) === canonicalJson(item.gateway) && gateway.keyHashMatches === true
      && gateway.status === "success", "mapped gateway charge differs");
    const deployment = auditedGatewayDeployments[gateway.model_id];
    const upstream = deployment?.transport === "bedrock" ? `bedrock/converse/eu.anthropic.${deployment.model.replace("5.5", "5-5")}`
      : deployment?.transport === "openrouter" ? `openai/anthropic/${deployment.model}` : `vertex_ai/${deployment?.model}`;
    requireEvidence(deployment?.alias === original.model && gateway.model_group === original.model && gateway.model === upstream,
      "wrong deployment or model");
    requireEvidence(item.ledger.status === original.status && item.ledger.requestId === original.requestId
      && item.ledger.reservedMicros === original.reservedMicros && item.ledger.accountedMicros === original.accountedMicros,
    "mapped original financial tuple differs");
    const trace = await jsonAt(item.trace.path, item.trace.sha256);
    const response = await bytesAt(item.response.path, item.response.sha256);
    requireEvidence(trace.id === item.localId && trace.status === item.status, "trace identity changed");
    const responseIds = new Set();
    const costs = [];
    let terminalEvents = 0;
    for (const line of response.toString().split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") { terminalEvents++; continue; }
      let event;
      try { event = JSON.parse(data); } catch { requireEvidence(false, "unparseable SSE accounting frame"); }
      if (typeof event.id === "string") responseIds.add(event.id);
      if (typeof event.usage?.cost === "number") costs.push(event.usage.cost);
    }
    requireEvidence(responseIds.size === 1 && responseIds.has(gateway.request_id), "SSE ID does not identify exactly one gateway row");
    const cancelled = trust.cancelledRequestIds.includes(item.localId);
    if (cancelled) {
      requireEvidence(trace.status === "cancelled" && original.status === "uncertain"
        && item.deploymentMatches === null && !trace.actualBackend?.deploymentId, "cancelled-request qualification changed");
    } else {
      requireEvidence(trace.status === "completed" && original.status === "settled" && terminalEvents === 1
        && trace.actualBackend?.deploymentId === gateway.model_id && item.deploymentMatches === true,
      "completed wire deployment differs");
      // Gateway JSON serialization differs by a few binary floating-point bits.
      // Only this comparison tolerates those bits; debit rounding uses the persisted price.
      requireEvidence(costs.length > 0 && sameCharge(costs.at(-1), gateway.spend)
        && sameCharge(item.observedUsageCostEur, gateway.spend), "completed response cost differs");
    }
    const accountedMicros = eurToCeilingMicros(gateway.spend);
    requireEvidence(accountedMicros <= original.reservedMicros
      && accountedMicros >= (original.reportedMicros ?? 0), "charge exceeds its reservation or contradicts an existing cost header");
    entries.push({ entryId: id, requestId: item.localId, originalEntrySha256: evidenceHash(original),
      gatewayRequestId: gateway.request_id, gatewayCallId: gateway.litellm_call_id, deploymentId: gateway.model_id,
      accountedMicros, gatewaySpendEur: gateway.spend, cancelledWireDeploymentUnknown: cancelled,
      traceSha256: item.trace.sha256, responseSha256: item.response.sha256 });
  }
  requireEvidence(rows.every(row => gatewayIds.has(row.request_id)) && originals.every(([id]) => ledgerIds.has(id)), "missing or extra IDs");
  requireEvidence(trust.cancelledRequestIds.every(id => localIds.has(id)), "missing approved cancellation");
  entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
  const accountedMicros = entries.reduce((sum, entry) => sum + entry.accountedMicros, 0);
  requireEvidence(accountedMicros === trust.accountedMicros && review.perRequestRoundedUpMicros === accountedMicros,
    "approved charge total differs");
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  requireEvidence(Math.abs(spend - collection.keyBefore.info.spend) < 1e-10
    && collection.keyBefore.info.spend === collection.keyAfter.info.spend
    && receipt.timing.keySpendStableAcrossFourSuccessfulReads === true
    && receipt.timing.recordsIdenticalAcrossCollections === true
    && receipt.timing.secondsBetweenKeyReads >= 60 && receipt.timing.secondsFromLastCapturedResponseToFirstKeyRead >= 60,
  "persisted spend or batching evidence differs");
  const plan = { version: 1, kind: "reviewed-gateway-debits", keyHash: receipt.keyHash,
    receiptSha256: trust.receiptSha256, reviewSha256: trust.reviewSha256,
    ledgerCreatedAt: snapshot.createdAt, manifestSha256: snapshot.manifestSha256, entries, accountedMicros,
    preservedEntries: Object.entries(snapshot.entries).filter(([, entry]) => entry.kind !== "inference")
      .map(([entryId, entry]) => ({ entryId, originalEntrySha256: evidenceHash(entry) })),
    qualifications: { initialZeroSpendReceiptUnavailable: true, historicalExclusivityUnproven: true,
      cancelledWireDeploymentUnknown: [...trust.cancelledRequestIds] } };
  const capability = Object.freeze({ batchId: evidenceHash(plan) });
  verified.set(capability, plan);
  return capability;
}

export function verifiedReconciliationPlan(capability) {
  const plan = verified.get(capability);
  requireEvidence(Boolean(plan), "a verified evidence capability is required");
  return structuredClone(plan);
}

/** Fixed reviewed follow-up only. Every source file and response identity is
 * verified again; neither a caller-provided plan nor a time filter is authority. */
export async function verifyBudgetFollowupReconciliation({ receiptPath, reviewPath, draftPath, trust = approvedFollowupReconciliation }) {
  trust = structuredClone(trust);
  const receipt = await jsonAt(receiptPath, trust.receiptSha256);
  const review = await jsonAt(reviewPath, trust.reviewSha256);
  const draft = await jsonAt(draftPath, trust.draftSha256);
  requireEvidence(review.kind === "root-approved-followup-confirmed-gateway-debits" && review.version === 1
    && review.receiptSha256 === trust.receiptSha256 && review.draftSha256 === trust.draftSha256
    && review.unreviewedPlanCanonicalSha256 === evidenceHash(draft.plan) && review.ledgerChanged === false
    && review.mappedRequests === trust.requests && review.perRequestRoundedUpMicros === trust.accountedMicros
    && review.preservedExistingReconciliationRequests === trust.priorRequests
    && review.existingFinancialHistoryMustRemain === true && review.cloudCostsSeparateNotZero === true
    && review.wholeWireAndTerminalCostFieldsVerifiedForAll188 === true
    && review.authorizesOnlyAppendingThisReviewedBatch === true && review.requiresExactFreshLedgerHashAndQuiescence === true,
  "follow-up independent approval differs");
  requireEvidence(receipt.ledgerMutated === false && receipt.newModelCalls === 0 && receipt.issues?.length === 0
    && receipt.entries?.length === trust.totalRequests && receipt.collections?.length === 2
    && receipt.collectionStableSeconds >= 60, "incomplete follow-up source collection");
  const snapshot = await jsonAt(receipt.sourceLedgerSnapshot.path, receipt.sourceLedgerSnapshot.sha256);
  requireEvidence([2, 3].includes(snapshot.version) && snapshot.currency === "EUR" && snapshot.limitMicros === 100_000_000
    && snapshot.manifestSha256 === budgetRateManifestSha256 && Array.isArray(snapshot.reconciliations), "wrong follow-up ledger contract");
  const prior = new Set();
  for (const batch of snapshot.reconciliations) {
    requireEvidence(batch.id === evidenceHash(batch.plan), "changed historical reconciliation batch");
    for (const row of batch.plan.entries) {
      requireEvidence(!prior.has(row.entryId), "duplicated historical entry");
      prior.add(row.entryId);
    }
  }
  requireEvidence(prior.size === trust.priorRequests, "historical reconciliation set differs");
  let rows;
  const spends = [], times = [];
  for (const reference of receipt.collections) {
    const collection = await jsonAt(reference.path, reference.sha256);
    requireEvidence(collection.key.hash === receipt.keyHash && collection.logs.completePagination === true
      && collection.logs.expectedTotal === trust.totalRequests && collection.ledger.unchangedDuringRead === true,
    "follow-up key, pagination or quiescent snapshot differs");
    const pages = [];
    for (const file of collection.requests) {
      const content = await jsonAt(file.path, file.sha256);
      if (/\/spend-page-\d+\.json$/.test(file.path)) pages.push(content);
      if (/\/key-(?:before|after)\.json$/.test(file.path)) {
        requireEvidence(content.httpStatus === 200 && content.sanitized.keyHashVerified === true, "unverified key metadata");
        spends.push(content.sanitized.info.spend);
      }
    }
    pages.sort((left, right) => left.sanitized.page - right.sanitized.page);
    requireEvidence(pages.length === collection.logs.expectedPages, "missing follow-up page");
    const current = [];
    for (const [index, page] of pages.entries()) {
      requireEvidence(page.httpStatus === 200 && page.query.api_key === receipt.keyHash
        && page.sanitized.page === index + 1 && page.sanitized.total === trust.totalRequests
        && page.sanitized.total_pages === pages.length, "wrong key or inconsistent follow-up page");
      current.push(...page.sanitized.records);
    }
    requireEvidence(current.length === trust.totalRequests
      && new Set(current.map(row => row.request_id)).size === current.length, "missing or duplicated follow-up response IDs");
    if (rows) requireEvidence(canonicalJson(rows) === canonicalJson(current), "persisted charges changed between collections");
    else rows = current;
    const collectedSnapshot = await jsonAt(collection.ledger.snapshot.path, collection.ledger.snapshot.sha256);
    requireEvidence(canonicalJson(collectedSnapshot) === canonicalJson(snapshot), "collection ledger snapshot differs");
    times.push(Date.parse(collection.createdAt));
  }
  requireEvidence(spends.length === 4 && spends.every(value => typeof value === "number" && value === spends[0])
    && times[1] - times[0] >= 60_000, "persisted key spend is not stable across four reads");
  requireEvidence(rows.every(row => typeof row.spend === "number" && Number.isFinite(row.spend) && row.spend >= 0)
    && Math.abs(rows.reduce((sum, row) => sum + row.spend, 0) - spends[0]) < 1e-10,
  "complete persisted charges do not match the key spend");
  const ids = new Set(), gateways = new Set(), entries = [];
  for (const item of receipt.entries) {
    const original = snapshot.entries[item.entryId];
    const gateway = rows.find(row => row.request_id === item.gateway.request_id);
    requireEvidence(original?.kind === "inference" && original.requestId === item.localRequestId
      && item.originalEntrySha256 === evidenceHash(original) && !ids.has(item.entryId)
      && gateway && canonicalJson(gateway) === canonicalJson(item.gateway) && !gateways.has(gateway.request_id)
      && gateway.keyHashMatches === true && gateway.status === "success", "changed or duplicated follow-up mapping");
    ids.add(item.entryId); gateways.add(gateway.request_id);
    const deployment = auditedGatewayDeployments[gateway.model_id];
    const upstream = deployment?.transport === "bedrock" ? `bedrock/converse/eu.anthropic.${deployment.model.replace("5.5", "5-5")}`
      : deployment?.transport === "openrouter" ? `openai/anthropic/${deployment.model}` : `vertex_ai/${deployment?.model}`;
    requireEvidence(deployment?.alias === original.model && gateway.model_group === original.model && gateway.model === upstream,
      "follow-up deployment or model differs");
    const trace = await jsonAt(item.trace.path, item.trace.sha256);
    const response = await bytesAt(item.response.path, item.response.sha256);
    requireEvidence(trace.id === item.localRequestId && trace.status === item.localStatus && trace.model === original.model,
      "follow-up trace identity differs");
    const responseIds = new Set(), costs = [];
    let done = 0;
    for (const line of response.toString().split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const text = line.slice(5).trim();
      if (!text) continue;
      if (text === "[DONE]") { done++; continue; }
      let event;
      try { event = JSON.parse(text); } catch { requireEvidence(false, "unparseable follow-up SSE frame"); }
      if (typeof event.id === "string") responseIds.add(event.id);
      if (typeof event.usage?.cost === "number") costs.push(event.usage.cost);
    }
    requireEvidence(responseIds.size === 1 && responseIds.has(gateway.request_id), "follow-up raw SSE ID differs");
    if (costs.length) requireEvidence(sameCharge(costs.at(-1), gateway.spend)
      && sameCharge(item.observedUsageCostEur, gateway.spend), "follow-up terminal cost differs");
    const actualDeployment = trace.actualBackend?.deploymentId;
    if (actualDeployment) requireEvidence(actualDeployment === gateway.model_id, "observed follow-up backend differs");
    if (!prior.has(item.entryId)) {
      requireEvidence(trace.status === "completed" && original.status === "settled" && done === 1 && costs.length > 0
        && actualDeployment === gateway.model_id && item.deploymentUnknown === false,
      "newly confirmed entry lacks actual completed wire, cost or deployment evidence");
      const accountedMicros = eurToCeilingMicros(gateway.spend);
      requireEvidence(accountedMicros === item.accountedMicros && accountedMicros <= original.reservedMicros
        && accountedMicros >= (original.reportedMicros ?? 0), "follow-up debit contradicts original bound/header");
      entries.push({ entryId: item.entryId, requestId: item.localRequestId, originalEntrySha256: evidenceHash(original),
        gatewayRequestId: gateway.request_id, gatewayCallId: gateway.litellm_call_id, deploymentId: gateway.model_id,
        accountedMicros, gatewaySpendEur: gateway.spend, cancelledWireDeploymentUnknown: false,
        traceSha256: item.trace.sha256, responseSha256: item.response.sha256 });
    }
  }
  requireEvidence(Object.entries(snapshot.entries).filter(([, entry]) => entry.kind === "inference")
    .every(([id]) => ids.has(id)) && ids.size === trust.totalRequests && gateways.size === trust.totalRequests,
  "missing follow-up original entries");
  entries.sort((left, right) => left.entryId.localeCompare(right.entryId));
  const expected = { version: 1, kind: "reviewed-gateway-debits", keyHash: receipt.keyHash,
    receiptSha256: trust.receiptSha256, reviewSha256: null, ledgerCreatedAt: snapshot.createdAt,
    manifestSha256: snapshot.manifestSha256, entries,
    accountedMicros: entries.reduce((sum, entry) => sum + entry.accountedMicros, 0),
    preservedEntries: Object.entries(snapshot.entries).filter(([id]) => !entries.some(entry => entry.entryId === id))
      .map(([entryId, entry]) => ({ entryId, originalEntrySha256: evidenceHash(entry) })),
    qualifications: draft.plan.qualifications };
  requireEvidence(entries.length === trust.requests && expected.accountedMicros === trust.accountedMicros
    && canonicalJson(expected) === canonicalJson(draft.plan), "reviewed follow-up draft does not match the complete evidence");
  expected.reviewSha256 = trust.reviewSha256;
  const capability = Object.freeze({ batchId: evidenceHash(expected) });
  verified.set(capability, expected);
  return capability;
}
