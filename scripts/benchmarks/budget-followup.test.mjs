import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileReviewedBudgetLedger } from "./budget-guard.mjs";
import { evidenceHash, verifyBudgetFollowupReconciliation, verifiedReconciliationPlan } from "./budget-reconciliation.mjs";
import { runReviewedFollowupReconciliation } from "./budget-reconcile-followup.mjs";
import { complete, deployment, fixture, request, writeJson, json, fileHash } from "./budget-test-fixture.mjs";

async function followupFixture(t) {
  const f = await fixture(t), historical = await f.verify();
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: historical,
    apply: true, expectedLedgerSha256: await fileHash(f.ledgerPath) });
  const token = await f.guard.reserve(request("new-confirmed"));
  await f.guard.reconcile(token, complete);
  const snapshot = await json(f.ledgerPath), snapshotPath = join(f.root, "followup-snapshot.json");
  await writeJson(snapshotPath, snapshot);
  const mapping = await json(f.mappingPath), rows = (await json(f.pagePath)).sanitized.records;
  const model = snapshot.entries[token.id].model;
  rows.push({ request_id: "gateway-new", litellm_call_id: "call-new", model_id: deployment,
    model: "vertex_ai/gemini-3.8-flash", model_group: model, status: "success", spend: 0.015, keyHashMatches: true });
  const tracePath = join(f.root, "new-trace.json"), responsePath = join(f.root, "new-response.raw");
  await writeJson(tracePath, { id: "new-confirmed", status: "completed", model, actualBackend: { deploymentId: deployment } });
  await writeFile(responsePath, 'data: {"id":"gateway-new","usage":{"cost":0.015}}\n\ndata: [DONE]\n\n');
  const all = [...mapping.map(row => ({ entryId: row.ledger.id, localRequestId: row.localId, gateway: row.gateway,
    trace: { path: row.trace.path }, response: { path: row.response.path }, localStatus: row.status,
    observedUsageCostEur: row.observedUsageCostEur, deploymentUnknown: row.status === "cancelled" })),
  { entryId: token.id, localRequestId: "new-confirmed", gateway: rows.at(-1), trace: { path: tracePath },
    response: { path: responsePath }, localStatus: "completed", observedUsageCostEur: 0.015, deploymentUnknown: false }];
  for (const item of all.slice(0, 2)) {
    const trace = await json(item.trace.path); trace.model = model; await writeJson(item.trace.path, trace);
  }
  const receiptPath = join(f.root, "followup-receipt.json"), reviewPath = join(f.root, "followup-review.json"), draftPath = join(f.root, "followup-draft.json");
  const pages = [], collections = [], trust = { requests: 1, priorRequests: 2, totalRequests: 3, accountedMicros: 15_000 };
  for (let index = 0; index < 2; index++) {
    const directory = join(f.root, `followup-read-${index}`); await mkdir(directory);
    const page = join(directory, "spend-page-0001.json"); pages.push(page);
    await writeJson(page, { httpStatus: 200, query: { api_key: "a".repeat(64) }, sanitized: { page: 1, total: 3, total_pages: 1, records: rows } });
  }
  async function seal() {
    collections.length = 0;
    for (const [index, page] of pages.entries()) {
      const directory = join(f.root, `followup-read-${index}`), requests = [];
      for (const name of ["key-before.json", "key-after.json"]) {
        const path = join(directory, name);
        await writeJson(path, { httpStatus: 200, sanitized: { keyHashVerified: true, info: { spend: 0.045 } } });
        requests.push({ path, sha256: await fileHash(path) });
      }
      requests.push({ path: page, sha256: await fileHash(page) });
      const path = join(directory, "collection.receipt.json");
      await writeJson(path, { createdAt: `2026-10-25T00:0${index * 2}:00.000Z`, key: { hash: "a".repeat(64) },
        logs: { completePagination: true, expectedTotal: 3, expectedPages: 1 },
        ledger: { unchangedDuringRead: true, snapshot: { path: snapshotPath, sha256: await fileHash(snapshotPath) } }, requests });
      collections.push({ path, sha256: await fileHash(path) });
    }
    for (const item of all) {
      item.originalEntrySha256 = evidenceHash(snapshot.entries[item.entryId]);
      item.accountedMicros = Math.ceil(item.gateway.spend * 1e6);
      item.trace.sha256 = await fileHash(item.trace.path); item.response.sha256 = await fileHash(item.response.path);
    }
    const receipt = { keyHash: "a".repeat(64), ledgerMutated: false, newModelCalls: 0, issues: [], entries: all,
      collections, collectionStableSeconds: 120, sourceLedgerSnapshot: { path: snapshotPath, sha256: await fileHash(snapshotPath) } };
    await writeJson(receiptPath, receipt); trust.receiptSha256 = await fileHash(receiptPath);
    const original = snapshot.entries[token.id];
    const plan = { version: 1, kind: "reviewed-gateway-debits", keyHash: receipt.keyHash,
      receiptSha256: trust.receiptSha256, reviewSha256: null, ledgerCreatedAt: snapshot.createdAt,
      manifestSha256: snapshot.manifestSha256,
      entries: [{ entryId: token.id, requestId: original.requestId, originalEntrySha256: evidenceHash(original),
        gatewayRequestId: "gateway-new", gatewayCallId: "call-new", deploymentId: deployment, accountedMicros: 15_000,
        gatewaySpendEur: 0.015, cancelledWireDeploymentUnknown: false, traceSha256: await fileHash(tracePath), responseSha256: await fileHash(responsePath) }],
      accountedMicros: 15_000, preservedEntries: Object.entries(snapshot.entries).filter(([id]) => id !== token.id)
        .map(([entryId, entry]) => ({ entryId, originalEntrySha256: evidenceHash(entry) })),
      qualifications: { initialZeroSpendReceiptUnavailable: true, historicalExclusivityUnproven: true, roleAttributionUnchanged: true } };
    await writeJson(draftPath, { plan }); trust.draftSha256 = await fileHash(draftPath);
    await writeJson(reviewPath, { kind: "root-approved-followup-confirmed-gateway-debits", version: 1,
      receiptSha256: trust.receiptSha256, draftSha256: trust.draftSha256, unreviewedPlanCanonicalSha256: evidenceHash(plan),
      ledgerChanged: false, mappedRequests: 1, perRequestRoundedUpMicros: 15_000, preservedExistingReconciliationRequests: 2,
      existingFinancialHistoryMustRemain: true, cloudCostsSeparateNotZero: true, wholeWireAndTerminalCostFieldsVerifiedForAll188: true,
      authorizesOnlyAppendingThisReviewedBatch: true, requiresExactFreshLedgerHashAndQuiescence: true });
    trust.reviewSha256 = await fileHash(reviewPath);
  }
  await seal();
  const verify = () => verifyBudgetFollowupReconciliation({ receiptPath, reviewPath, draftPath, trust });
  return { ...f, token, snapshot, tracePath, responsePath, pages, receiptPath, reviewPath, draftPath, seal, verify };
}

test("actual follow-up guard transaction appends only new confirmed rows, preserving old records, holds and batch", async t => {
  const f = await followupFixture(t), evidence = await f.verify(), before = await readFile(f.ledgerPath);
  assert.equal(verifiedReconciliationPlan(evidence).entries.length, 1);
  const preview = await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence });
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.equal(preview.after.committedUpperBoundEur, 8.045);
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true, expectedLedgerSha256: await fileHash(f.ledgerPath) });
  const state = await json(f.ledgerPath);
  assert.deepEqual(state.entries, f.snapshot.entries);
  assert.deepEqual(state.reconciliations[0], f.snapshot.reconciliations[0]);
  assert.equal(state.reconciliations.length, 2);
  const applied = await readFile(f.ledgerPath);
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence, apply: true });
  assert.deepEqual(await readFile(f.ledgerPath), applied);
});

for (const scenario of ["wrong-response-id", "missing-terminal", "wrong-cost", "wrong-deployment", "cancelled-new-entry", "changed-page"]) {
  test(`follow-up rejects ${scenario} even after newly matching fixture pins`, async t => {
    const f = await followupFixture(t);
    if (scenario === "wrong-response-id") await writeFile(f.responsePath, 'data: {"id":"another-id","usage":{"cost":0.015}}\n\ndata: [DONE]\n\n');
    if (scenario === "missing-terminal") await writeFile(f.responsePath, 'data: {"id":"gateway-new","usage":{"cost":0.015}}\n\n');
    if (scenario === "wrong-cost") await writeFile(f.responsePath, 'data: {"id":"gateway-new","usage":{"cost":0}}\n\ndata: [DONE]\n\n');
    if (scenario === "wrong-deployment") { const trace = await json(f.tracePath); trace.actualBackend.deploymentId = "wrong"; await writeJson(f.tracePath, trace); }
    if (scenario === "cancelled-new-entry") { const trace = await json(f.tracePath); trace.status = "cancelled"; await writeJson(f.tracePath, trace); }
    if (scenario === "changed-page") { const page = await json(f.pages[1]); page.sanitized.records[2].spend = 0; await writeJson(f.pages[1], page); }
    await f.seal();
    await assert.rejects(f.verify(), /Reconciliation evidence rejected/);
  });
}

test("follow-up fixed authority and CLI cannot accept a self-signed batch or caller trust override", async t => {
  const f = await followupFixture(t);
  await assert.rejects(verifyBudgetFollowupReconciliation({ receiptPath: f.receiptPath, reviewPath: f.reviewPath, draftPath: f.draftPath }), /file hash changed/);
  await assert.rejects(runReviewedFollowupReconciliation(["--trust", "caller"]), /Unknown/);
  const evidence = await f.verify(), state = await json(f.ledgerPath);
  state.entries[f.cloud.id].reservedMicros--;
  await writeJson(f.ledgerPath, state);
  await assert.rejects(reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence }), { code: "reconciliation_rejected" });
});
