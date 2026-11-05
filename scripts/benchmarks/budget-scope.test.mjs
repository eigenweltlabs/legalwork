import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyReviewedBudgetScope, createBudgetGuard, reconcileReviewedBudgetLedger } from "./budget-guard.mjs";
import { evidenceHash, sha256 } from "./budget-reconciliation.mjs";
import { verifyBudgetScopeDecision } from "./budget-scope.mjs";
import { runReviewedBudgetScope } from "./budget-rescope.mjs";
import { audit, complete, fixture, request, writeJson, json, fileHash } from "./budget-test-fixture.mjs";

async function scopeFixture(t) {
  const f = await fixture(t);
  const reconciliation = await f.verify();
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: reconciliation,
    apply: true, expectedLedgerSha256: await fileHash(f.ledgerPath) });
  const state = await json(f.ledgerPath);
  const decisionPath = join(f.root, "scope-decision.json");
  const decision = { kind: "migration-budget-scope-decision", version: 1, scope: "migration-model-tokens-only",
    currency: "EUR", modelLimitMicros: 100_000_000, ledgerCreatedAt: state.createdAt,
    manifestSha256: state.manifestSha256,
    excludedExternal: [{ entryId: f.cloud.id, originalEntrySha256: evidenceHash(state.entries[f.cloud.id]) }],
    originalFinancialEntriesPreserved: true, externalCostsNotZero: true };
  async function verify() {
    await writeJson(decisionPath, decision);
    return verifyBudgetScopeDecision({ decisionPath, trustSha256: await fileHash(decisionPath) });
  }
  const evidence = await verify();
  const scopedGuard = () => createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit(), scopeEvidence: evidence });
  return { ...f, reconciliation, decisionPath, decision, evidence, verify, scopedGuard, state };
}
async function apply(f) {
  return applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.evidence,
    apply: true, expectedLedgerSha256: await fileHash(f.ledgerPath), backupPath: join(f.root, "before-scope.json") });
}

test("scope dry-run is byte preserving; actual guard keeps all original financial records and separates cloud", async t => {
  const f = await scopeFixture(t), before = await readFile(f.ledgerPath), marker = await readFile(`${f.ledgerPath}.initialized`);
  const preview = await applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.evidence });
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.equal(preview.before.committedUpperBoundEur, 8.03);
  assert.equal(preview.after.committedUpperBoundEur, 0.03);
  assert.equal(preview.after.externalReservedEur, 8);
  assert.equal(preview.after.allFinancialExposureEur, 8.03);
  assert.equal(preview.after.externalInvoiceKnownForAllExcludedEntries, false);
  await apply(f);
  const state = await json(f.ledgerPath);
  assert.equal(state.version, 3);
  assert.deepEqual(state.entries, f.state.entries);
  assert.deepEqual(state.reconciliations, f.state.reconciliations);
  assert.deepEqual(await readFile(`${f.ledgerPath}.initialized`), marker);
  assert.deepEqual(await readFile(join(f.root, "before-scope.json")), before);
  const guard = await f.scopedGuard();
  const health = await guard.health();
  assert.equal(health.scope, "migration-model-tokens-only");
  assert.equal(health.remainingEur, 99.97);
  assert.equal(health.historicalCommittedUpperBoundEur, preview.before.historicalCommittedUpperBoundEur);
  const fresh = await guard.reserve(request("post-scope"));
  await guard.reconcile(fresh, { cancelled: true });
  assert.equal((await guard.health()).reservedEur, 2.313421);
  assert.equal((await guard.health()).externalReservedEur, 8);
  assert.equal((await guard.health()).uncertainReservations, 1);
});

test("unknown external holds stay conservative and pending model costs are never removed", async t => {
  const f = await scopeFixture(t);
  const unknown = await f.guard.reserveExternal({ requestId: "unclassified-external", label: "Unclassified external", maxEur: 5 });
  const model = await f.guard.reserve(request("unknown-model-cost"));
  await f.guard.reconcile(model, { cancelled: true });
  await apply(f);
  const guard = await f.scopedGuard(), health = await guard.health();
  assert.equal(health.committedUpperBoundEur, 7.343421);
  assert.equal(health.externalExposureEur, 8);
  assert.equal(health.unclassifiedExternalEntriesInModelBudget, 1);
  await guard.settleExternal(unknown, { actualEur: 1, evidenceId: "unclassified-invoice" });
  assert.equal((await guard.health()).committedUpperBoundEur, 3.343421);
});

test("actual model admission reaches the unchanged token guard independently of excluded cloud holds", async t => {
  const f = await scopeFixture(t); await apply(f);
  const guard = await f.scopedGuard();
  for (let i = 0; i < 43; i++) await guard.reserve(request(`model-capacity-${i}`));
  const health = await guard.health();
  assert.equal(health.committedUpperBoundEur, 99.507103);
  assert.equal(health.externalReservedEur, 8);
  assert.equal(health.allFinancialExposureEur, 107.507103);
  await assert.rejects(guard.reserve(request("complete-request-will-not-fit")), { code: "budget_exhausted" });
});

test("scope cannot release model costs or tampered cloud records even under a new hash pin", async t => {
  const f = await scopeFixture(t);
  for (const target of [f.completed.id, f.cancelled.id]) {
    f.decision.excludedExternal = [{ entryId: target, originalEntrySha256: evidenceHash(f.state.entries[target]) }];
    const evidence = await f.verify();
    await assert.rejects(applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence }), /inference was excluded/);
  }
  f.decision.excludedExternal = [{ entryId: f.cloud.id, originalEntrySha256: "0".repeat(64) }];
  await assert.rejects(applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: await f.verify() }), /financial record changed/);
  await assert.rejects(applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: { decisionSha256: "a".repeat(64) } }), /verified decision evidence/);
});

test("scope application is locked, exact-before-hash and quiescent; replay cannot release twice", async t => {
  const f = await scopeFixture(t), before = await readFile(f.ledgerPath);
  await assert.rejects(applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.evidence, apply: true }), { code: "ledger_changed" });
  const active = await f.guard.reserve(request("active"));
  await assert.rejects(apply(f), { code: "ledger_not_quiescent" });
  await f.guard.reconcile(active, { cancelled: true });
  const expected = await fileHash(f.ledgerPath);
  const results = await Promise.all([1, 2].map(() => applyReviewedBudgetScope({ ledgerPath: f.ledgerPath,
    evidence: f.evidence, apply: true, expectedLedgerSha256: expected, backupPath: join(f.root, "before-scope.json") })));
  assert.equal(results.filter(r => r.idempotent).length, 1);
  const applied = await readFile(f.ledgerPath);
  assert.equal((await json(f.ledgerPath)).budgetScopeEvents.length, 1);
  await applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.evidence, apply: true });
  assert.deepEqual(await readFile(f.ledgerPath), applied);
  assert.notDeepEqual(applied, before);
});

test("late gateway increases and reconciliation replay retain schema3 and only affect model exposure", async t => {
  const f = await scopeFixture(t); await apply(f);
  const guard = await f.scopedGuard();
  await guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "0.04" } });
  assert.equal((await guard.health()).committedUpperBoundEur, 0.05);
  assert.equal((await guard.health()).allFinancialExposureEur, 8.05);
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: f.reconciliation, apply: true, scopeEvidence: f.evidence });
  assert.equal((await json(f.ledgerPath)).version, 3);
  await guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "101" } });
  assert.equal((await guard.health()).frozen, true);
  assert.equal((await guard.health()).externalReservedEur, 8);
  await assert.rejects(guard.reserve(request("after-real-model-overrun")), { code: "budget_frozen" });
});

test("external invoices append evidence without zeroing or rewriting original holds or model spending", async t => {
  const f = await scopeFixture(t); await apply(f);
  const guard = await f.scopedGuard(), original = structuredClone((await json(f.ledgerPath)).entries);
  await guard.settleExternal(f.cloud, { actualEur: 3, evidenceId: "actual-cloud-invoice" });
  let health = await guard.health();
  assert.equal(health.committedUpperBoundEur, 0.03);
  assert.equal(health.externalAccountedEur, 3);
  assert.equal(health.externalReservedEur, 0);
  assert.equal(health.externalInvoiceKnownForAllExcludedEntries, true);
  const prior = await readFile(f.ledgerPath);
  await guard.settleExternal(f.cloud, { actualEur: 0, evidenceId: "unproven-zero" });
  assert.deepEqual(await readFile(f.ledgerPath), prior);
  await guard.settleExternal(f.cloud, { actualEur: 12, evidenceId: "higher-cloud-invoice" });
  health = await guard.health();
  assert.equal(health.externalCostEvidenceExceedingOriginalHold, 1);
  assert.equal(health.allFinancialExposureEur, 12.03);
  assert.equal(health.frozen, false);
  assert.deepEqual((await json(f.ledgerPath)).entries, original);
});

test("pre-scope actual external debit cannot be decreased and an existing backup prevents ledger publication", async t => {
  const f = await scopeFixture(t);
  await f.guard.settleExternal(f.cloud, { actualEur: 3, evidenceId: "invoice-before-scope" });
  f.decision.excludedExternal[0].originalEntrySha256 = evidenceHash((await json(f.ledgerPath)).entries[f.cloud.id]);
  f.evidence = await f.verify();
  const before = await readFile(f.ledgerPath);
  await writeFile(join(f.root, "before-scope.json"), "existing immutable evidence", { flag: "wx" });
  await assert.rejects(apply(f), { code: "EEXIST" });
  assert.deepEqual(await readFile(f.ledgerPath), before);
  await applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.evidence, apply: true,
    expectedLedgerSha256: sha256(before), backupPath: join(f.root, "new-before-scope.json") });
  const guard = await createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit(), scopeEvidence: f.evidence });
  const scoped = await readFile(f.ledgerPath);
  await guard.settleExternal(f.cloud, { actualEur: 0, evidenceId: "unproven-lower-invoice" });
  assert.deepEqual(await readFile(f.ledgerPath), scoped);
  assert.equal((await guard.health()).externalAccountedEur, 3);
});

test("restart rejects forged decisions, changed holds, duplicate scope events and decreased external evidence", async t => {
  const f = await scopeFixture(t); await apply(f);
  const guard = await f.scopedGuard();
  await guard.settleExternal(f.cloud, { actualEur: 3, evidenceId: "invoice" });
  const valid = await json(f.ledgerPath);
  for (const mutate of [s => { s.budgetScopeEvents[0].decisionRaw += " "; },
    s => { s.budgetScopeEvents.push(s.budgetScopeEvents[0]); },
    s => { s.entries[f.cloud.id].reservedMicros--; },
    s => { s.externalCostEvents.push(s.externalCostEvents[0]); },
    s => { s.version = 2; }]) {
    const changed = structuredClone(valid); mutate(changed); await writeJson(f.ledgerPath, changed);
    await assert.rejects(f.scopedGuard(), /scope|financial record changed|schema3/);
  }
});

test("production verifier and CLI reject caller-supplied/self-signed scope authority", async t => {
  const f = await scopeFixture(t);
  await assert.rejects(verifyBudgetScopeDecision({ decisionPath: f.decisionPath }), /independent decision hash/);
  await assert.rejects(runReviewedBudgetScope(["--trust", "self-signed"]), /Unknown/);
  await apply(f);
  await assert.rejects(createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit() }), /not independently approved/);
  assert.equal(sha256(await readFile(f.decisionPath)), await fileHash(f.decisionPath));
});
