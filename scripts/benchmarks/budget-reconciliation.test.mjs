import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createBudgetGuard, reconcileReviewedBudgetLedger } from "./budget-guard.mjs";
import { sha256, eurToCeilingMicros, verifyBudgetReconciliation } from "./budget-reconciliation.mjs";
import { runReviewedReconciliation } from "./budget-reconcile.mjs";
import { audit, complete, deployment, fixture, request, writeJson, json, fileHash } from "./budget-test-fixture.mjs";

async function applyFixture(f) {
  const evidence = await f.verify();
  const preview = await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence });
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: preview.ledgerBeforeSha256 });
  return evidence;
}

test("evidenced dry-run is byte-preserving; apply appends a v2 batch and retains all original records and cloud hold", async t => {
  const f = await fixture(t), evidence = await f.verify();
  const before = await readFile(f.ledgerPath), marker = await readFile(`${f.ledgerPath}.initialized`);
  const preview = await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence });
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.deepEqual(await readFile(`${f.ledgerPath}.initialized`), marker);
  assert.equal(preview.after.committedUpperBoundEur, 8.03);
  assert.equal(preview.after.historicalCommittedUpperBoundEur, preview.before.committedUpperBoundEur);
  await assert.rejects(reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true }), { code: "ledger_changed" });
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: sha256(before) });
  const state = await json(f.ledgerPath);
  assert.equal(state.version, 2);
  assert.deepEqual(state.entries, f.original.entries);
  assert.equal(state.entries[f.cancelled.id].status, "uncertain");
  assert.equal(state.entries[f.cloud.id].reservedMicros, 8_000_000);
  const health = await f.guard.health();
  assert.equal(health.evidencedInferenceDebitEur, 0.03);
  assert.equal(health.reservedEur, 8);
  assert.equal(health.historicalUncertainReservations, 1);
  assert.equal(health.uncertainReservations, 0);
  assert.equal(health.reportedSpendEur, 0);
  assert.equal(health.inferenceCostHeadersMissing, 2);
  assert.equal(health.inferenceCostHeadersReported, 0);
});

test("new independent calls coexist and retain their full reservation; exact batch replay cannot refund twice", async t => {
  const f = await fixture(t), evidence = await f.verify();
  const independent = await f.guard.reserve(request("independent-new"));
  await f.guard.reconcile(independent, complete);
  const independentDebit = (await json(f.ledgerPath)).entries[independent.id].accountedMicros / 1_000_000;
  const snapshot = await readFile(f.ledgerPath);
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: sha256(snapshot) });
  const health = await f.guard.health();
  assert.equal(health.accountedUpperBoundEur, 0.03 + independentDebit);
  const next = await f.guard.reserve(request("after-batch"));
  assert.equal(next.reservedMicros, 2_313_421);
  const frozen = await readFile(f.ledgerPath);
  const repeated = await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: "0".repeat(64) });
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(await readFile(f.ledgerPath), frozen);
  assert.equal((await f.guard.health()).reservedEur, 10.313421);
});

test("late old-token callbacks preserve history; real higher headers append absolute debits and freeze when beyond bound", async t => {
  const f = await fixture(t); await applyFixture(f);
  const prior = await readFile(f.ledgerPath);
  const replay = await f.guard.reconcile(f.cancelled, { ...complete, cancelled: true });
  assert.equal(replay.accountedMicros, 20_000);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(await readFile(f.ledgerPath), prior);
  await f.guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "0.04" } });
  assert.equal((await f.guard.health()).committedUpperBoundEur, 8.05);
  const firstIncrease = await json(f.ledgerPath);
  await f.guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "0.01" } });
  await f.guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "0.04" } });
  assert.equal((await json(f.ledgerPath)).reconciliationIncreases.length, 1);
  assert.deepEqual((await json(f.ledgerPath)).entries, f.original.entries);
  assert.equal(firstIncrease.entries[f.cancelled.id].reportedMicros, null);
  const larger = await f.guard.reconcile(f.cancelled, { responseHeaders: { "x-litellm-response-cost": "101" } });
  assert.equal(larger.frozen, true);
  const health = await f.guard.health();
  assert.equal(health.committedUpperBoundEur, 109.01);
  assert.equal(health.exhausted, true);
  await assert.rejects(f.guard.reserve(request("must-not-dispatch")), { code: "budget_frozen" });
  const restarted = await createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit() });
  assert.equal((await restarted.health()).committedUpperBoundEur, 109.01);
});

test("existing external hold may settle normally after the inference reconciliation", async t => {
  const f = await fixture(t); await applyFixture(f);
  await f.guard.settleExternal(f.cloud, { actualEur: 3, evidenceId: "cloud-final-invoice" });
  assert.equal((await f.guard.health()).committedUpperBoundEur, 3.03);
});

test("changed original financial tuples, missing entries and forged evidence capabilities cannot apply", async t => {
  const f = await fixture(t), evidence = await f.verify();
  for (const mutate of [state => { state.entries[f.completed.id].accountedMicros++; },
    state => { delete state.entries[f.cancelled.id]; }, state => { state.entries[f.cloud.id].reservedMicros--; }]) {
    const state = structuredClone(f.original); mutate(state); await writeJson(f.ledgerPath, state);
    await assert.rejects(reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence }), { code: "reconciliation_rejected" });
  }
  await writeJson(f.ledgerPath, f.original);
  await assert.rejects(reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: { batchId: evidence.batchId } }), /verified evidence capability/);
});

test("application requires exact reviewed ledger hash and no active unreviewed inference reservation", async t => {
  const f = await fixture(t), evidence = await f.verify();
  await f.guard.reserve(request("still-in-flight"));
  const before = await readFile(f.ledgerPath);
  await assert.rejects(reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: sha256(before) }), { code: "ledger_not_quiescent" });
  assert.deepEqual(await readFile(f.ledgerPath), before);
});

test("racing reviewed applications serialize on the existing lock and append exactly once", async t => {
  const f = await fixture(t), evidence = await f.verify(), before = await readFile(f.ledgerPath);
  const results = await Promise.all([1, 2].map(() => reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: sha256(before) })));
  assert.equal(results.filter(row => row.idempotent).length, 1);
  assert.equal((await json(f.ledgerPath)).reconciliations.length, 1);
});

test("persisted duplicate batches, original-record tampering and decreasing adjustments fail closed on restart", async t => {
  const f = await fixture(t); await applyFixture(f); const applied = await json(f.ledgerPath);
  for (const mutate of [state => state.reconciliations.push(state.reconciliations[0]),
    state => { state.entries[f.completed.id].accountedMicros = 0; },
    state => { state.reconciliations[0].plan.entries[0].accountedMicros = 0; },
    state => { state.reconciliationIncreases.push({ id: "forged", entryId: f.completed.id, accountedMicros: 1 }); },
    state => { state.version = 1; }]) {
    const changed = structuredClone(applied); mutate(changed); await writeJson(f.ledgerPath, changed);
    await assert.rejects(createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit() }), /ledger|Reconciled|reconciliation|Reconciled accounting/);
  }
});

for (const scenario of ["duplicate-gateway", "missing-gateway", "extra-mapping", "wrong-key", "wrong-deployment", "altered-cost"]) {
  test(`evidence rejects ${scenario} even with a newly matching file-hash index`, async t => {
    const f = await fixture(t), page = await json(f.pagePath), mapping = await json(f.mappingPath);
    if (scenario === "duplicate-gateway") page.sanitized.records[1] = page.sanitized.records[0];
    if (scenario === "missing-gateway") page.sanitized.records.pop();
    if (scenario === "extra-mapping") mapping.push(mapping[0]);
    if (scenario === "wrong-key") page.query.api_key = "b".repeat(64);
    if (scenario === "wrong-deployment") { page.sanitized.records[0].model_id = "unknown"; mapping[0].gateway.model_id = "unknown"; }
    if (scenario === "altered-cost") { page.sanitized.records[0].spend = 0; mapping[0].gateway.spend = 0; }
    await writeJson(f.pagePath, page); await writeJson(f.mappingPath, mapping); await f.seal();
    await assert.rejects(f.verify(), /Reconciliation evidence rejected/);
  });
}

test("independent pins, raw SSE and trace content are checked, and the CLI has no caller-supplied trust override", async t => {
  const f = await fixture(t), mapping = await json(f.mappingPath);
  await writeFile(mapping[0].response.path, "data: {\"id\":\"another-response\"}\n\n");
  await assert.rejects(f.verify(), /file hash changed/);
  await assert.rejects(verifyBudgetReconciliation({ receiptPath: f.receiptPath, reviewPath: f.reviewPath }), /file hash changed/);
  await assert.rejects(runReviewedReconciliation(["--trust", "self-signed"]), /Unknown/);
});

test("completed wire deployments stay strict and the cancelled wire-backend qualification cannot be upgraded", async t => {
  const f = await fixture(t), mapping = await json(f.mappingPath);
  const trace = await json(mapping[0].trace.path);
  trace.actualBackend.deploymentId = "different-wire-deployment";
  await writeJson(mapping[0].trace.path, trace);
  mapping[0].trace.sha256 = await fileHash(mapping[0].trace.path);
  await writeJson(f.mappingPath, mapping); await f.seal();
  await assert.rejects(f.verify(), /completed wire deployment differs/);
  trace.actualBackend.deploymentId = deployment;
  await writeJson(mapping[0].trace.path, trace);
  mapping[0].trace.sha256 = await fileHash(mapping[0].trace.path);
  mapping[1].deploymentMatches = true;
  await writeJson(f.mappingPath, mapping); await f.seal();
  await assert.rejects(f.verify(), /cancelled-request qualification changed/);
});

test("decimal debits always round upward, including exponent notation; invalid charges cannot create credit", () => {
  for (const [input, expected] of [[0, 0], [1e-10, 1], [0.000001, 1], [0.0000010000000001, 2], [0.05453514, 54536], [4.322936925, 4322937]]) {
    assert.equal(eurToCeilingMicros(input), expected);
  }
  for (const value of [-1, NaN, Infinity, "0", null]) assert.throws(() => eurToCeilingMicros(value), /invalid EUR charge/);
});
