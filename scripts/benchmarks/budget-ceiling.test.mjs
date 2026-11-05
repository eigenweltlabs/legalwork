import assert from "node:assert/strict";
import { readFile, stat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyReviewedBudgetCeiling, applyReviewedBudgetScope, createBudgetGuard, reconcileReviewedBudgetLedger } from "./budget-guard.mjs";
import { approvedBudgetCeilingAuthorizationSha256, verifyBudgetCeilingAuthorization, verifyBudgetRunCoverage, verifyPaidRunBudget, verifiedBudgetRunCoverage } from "./budget-ceiling.mjs";
import { verifyBudgetScopeDecision } from "./budget-scope.mjs";
import { evidenceHash } from "./budget-reconciliation.mjs";
import { runReviewedBudgetAuthorization } from "./budget-authorize.mjs";
import { audit, fixture, request, writeJson, json, fileHash } from "./budget-test-fixture.mjs";

async function setup(t) {
  const f = await fixture(t);
  const reconciliation = await f.verify();
  await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: reconciliation,
    apply: true, expectedLedgerSha256: await fileHash(f.ledgerPath) });
  let state = await json(f.ledgerPath);
  const scopePath = join(f.root, "scope.json");
  await writeJson(scopePath, { kind: "migration-budget-scope-decision", version: 1, scope: "migration-model-tokens-only",
    currency: "EUR", modelLimitMicros: 100_000_000, ledgerCreatedAt: state.createdAt, manifestSha256: state.manifestSha256,
    excludedExternal: [{ entryId: f.cloud.id, originalEntrySha256: evidenceHash(state.entries[f.cloud.id]) }],
    originalFinancialEntriesPreserved: true, externalCostsNotZero: true });
  const scopeEvidence = await verifyBudgetScopeDecision({ decisionPath: scopePath, trustSha256: await fileHash(scopePath) });
  await applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: scopeEvidence, apply: true,
    expectedLedgerSha256: await fileHash(f.ledgerPath), backupPath: join(f.root, "before-scope.json") });
  state = await json(f.ledgerPath);
  const userEvidencePath = join(f.root, "user.txt");
  await writeJson(userEvidencePath, { user: "EUR100 target; necessary migration retests up to EUR250" });
  const authorizationPath = join(f.root, "authorization.json");
  const authorization = { kind: "migration-token-budget-authorization", version: 1, currency: "EUR",
    scope: "migration-model-tokens-only", planningTargetMicros: 100_000_000, originalLimitMicros: 100_000_000,
    hardLimitMicros: 250_000_000, ledgerCreatedAt: state.createdAt, manifestSha256: state.manifestSha256,
    scopeEventId: state.budgetScopeEvents[0].id, scopeDecisionSha256: state.budgetScopeEvents[0].decisionSha256,
    authorizationEvidence: { path: userEvidencePath, sha256: await fileHash(userEvidencePath) },
    constraints: { necessaryMigrationFixesAndRetestsOnly: true, arbitraryExtraSpendingProhibited: true,
      perRunCoverageRationaleRequired: true, originalFinancialRecordsPreserved: true,
      externalCostsRemainSeparateAndNotAssumedZero: true, noRequestOrCapabilityReduction: true } };
  async function verify() {
    await writeJson(authorizationPath, authorization);
    return verifyBudgetCeilingAuthorization({ authorizationPath, trustSha256: await fileHash(authorizationPath) });
  }
  const evidence = await verify();
  const coveragePath = join(f.root, "run-coverage.json");
  const coverage = { kind: "migration-test-run-coverage", version: 1, authorizationSha256: approvedBudgetCeilingAuthorizationSha256,
    runId: "review-lifecycle-regression", coverageRationale: "Verify the exact repaired worker authority lifecycle in the real app.",
    necessaryMigrationFixOrRetest: true };
  async function verifyCoverage() {
    await writeJson(coveragePath, coverage);
    return verifyBudgetRunCoverage({ coveragePath, expectedSha256: await fileHash(coveragePath) });
  }
  const runCoverage = await verifyCoverage();
  const options = { ledgerPath: f.ledgerPath, evidence, scopeEvidence };
  const guard = () => createBudgetGuard({ ledgerPath: f.ledgerPath, totalEur: 250, auditAttestation: audit(), scopeEvidence,
    ceilingEvidence: evidence, runCoverage });
  const apply = (extras = {}) => applyReviewedBudgetCeiling({ ...options, apply: true,
    expectedLedgerSha256: undefined, backupPath: join(f.root, "before-authorization.json"), ...extras });
  return { ...f, state, authorization, authorizationPath, userEvidencePath, scopeEvidence, evidence, reconciliation,
    coverage, coveragePath, runCoverage, verify, verifyCoverage, options, guard, apply };
}

const activate = async f => f.apply({ expectedLedgerSha256: await fileHash(f.ledgerPath) });

test("ceiling dry-run preserves exact bytes; apply backs up and preserves every financial/scope record, replay is byte preserving", async t => {
  const f = await setup(t), before = await readFile(f.ledgerPath), marker = await readFile(`${f.ledgerPath}.initialized`);
  const preview = await applyReviewedBudgetCeiling(f.options);
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.equal(preview.after.limitEur, 250);
  assert.equal(preview.after.planningTargetEur, 100);
  assert.equal(preview.after.committedUpperBoundEur, .03);
  assert.equal(preview.after.externalReservedEur, 8);
  const applied = await activate(f), after = await readFile(f.ledgerPath), state = await json(f.ledgerPath);
  assert.equal(state.version, 3);
  for (const key of ["createdAt", "entries", "reconciliations", "reconciliationIncreases", "budgetScopeEvents", "externalCostEvents", "violations"]) {
    assert.deepEqual(state[key], f.state[key], key);
  }
  assert.deepEqual(await readFile(`${f.ledgerPath}.initialized`), marker);
  assert.deepEqual(await readFile(applied.originalBackup.path), before);
  assert.equal((await stat(applied.originalBackup.path)).mode & 0o777, 0o400);
  assert.equal((await f.apply()).idempotent, true);
  assert.deepEqual(await readFile(f.ledgerPath), after);
  assert.equal((await f.guard()).health instanceof Function, true);
  const replayBefore = await readFile(f.ledgerPath);
  assert.equal((await applyReviewedBudgetScope({ ledgerPath: f.ledgerPath, evidence: f.scopeEvidence,
    ceilingEvidence: f.evidence, apply: true })).idempotent, true);
  assert.deepEqual(await readFile(f.ledgerPath), replayBefore);
  assert.equal((await reconcileReviewedBudgetLedger({ ledgerPath: f.ledgerPath, evidence: f.reconciliation,
    scopeEvidence: f.scopeEvidence, ceilingEvidence: f.evidence })).idempotent, true);
});

test("authorization requires exact reviewed hash, new backup, quiescence and existing shared ledger", async t => {
  const f = await setup(t), before = await readFile(f.ledgerPath);
  await assert.rejects(f.apply({ expectedLedgerSha256: "a".repeat(64) }), /exact quiescent/);
  await assert.rejects(f.apply({ expectedLedgerSha256: await fileHash(f.ledgerPath), backupPath: undefined }), /backup/);
  assert.deepEqual(await readFile(f.ledgerPath), before);
  const oldGuard = await createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit(), scopeEvidence: f.scopeEvidence });
  const token = await oldGuard.reserve(request("still-active"));
  await assert.rejects(activate(f), /active inference/);
  await oldGuard.reconcile(token, { cancelled: true });
  await activate(f); // Uncertain holds are retained; never assumed free.
  assert.equal((await (await f.guard()).health()).reservedEur, 2.313421);
  await assert.rejects(createBudgetGuard({ ledgerPath: join(f.root, "fresh250.json"), totalEur: 250,
    auditAttestation: audit(), runCoverage: f.runCoverage }), /existing ledger/);
});

test("authentic planning target does not stop complete requests; EUR250 hard boundary stops without modifying input", async t => {
  const f = await setup(t); await activate(f);
  const guard = await f.guard();
  for (let i = 0; i < 44; i++) await guard.reserve(request(`before-target-${i}`));
  let health = await guard.health();
  assert.equal(health.planningTargetReached, true);
  assert.deepEqual(health.notificationThresholdsReached, [50, 80, 95, 100]);
  assert.equal(health.exhausted, false);
  const body = request("after-target");
  const originalBody = structuredClone(body);
  await guard.reserve(body);
  assert.deepEqual(body, originalBody);
  for (let i = 45; i < 108; i++) await guard.reserve(request(`toward-hard-boundary-${i}`));
  health = await guard.health();
  assert.equal(health.committedUpperBoundEur, 249.879468);
  assert.equal(health.externalReservedEur, 8);
  await assert.rejects(guard.reserve(request("too-large-complete-request")), /Insufficient unreserved budget/);
  const rows = Object.values((await json(f.ledgerPath)).entries).filter(row => row.budgetRunCoverage);
  assert.equal(rows.length, 108);
  assert.equal(rows[0].budgetRunCoverage.coverageRationale, f.coverage.coverageRationale);
});

test("tampered/forged/mismatched authorization cannot raise or reset a ledger; old EUR100 guard rejects new250", async t => {
  const f = await setup(t);
  await assert.rejects(applyReviewedBudgetCeiling({ ...f.options, evidence: {} }), /verified user authorization/);
  await assert.rejects(verifyBudgetCeilingAuthorization({ authorizationPath: f.authorizationPath }), /hash differs/);
  await writeJson(f.userEvidencePath, { tampered: true });
  await assert.rejects(verifyBudgetCeilingAuthorization({ authorizationPath: f.authorizationPath,
    trustSha256: await fileHash(f.authorizationPath) }), /evidence changed/);
  await activate(f);
  await assert.rejects(createBudgetGuard({ ledgerPath: f.ledgerPath, auditAttestation: audit(), scopeEvidence: f.scopeEvidence }), /limit, currency/);
  const good = await json(f.ledgerPath);
  const edits = [s => s.limitMicros = 251_000_000, s => s.limitMicros = 100_000_000,
    s => delete s.budgetAuthorizationEvents, s => s.budgetAuthorizationEvents.push(s.budgetAuthorizationEvents[0]),
    s => s.budgetAuthorizationEvents[0].authorizationRaw += " ", s => s.budgetAuthorizationEvents[0].ledgerBeforeSha256 = "b".repeat(64),
    s => s.budgetScopeEvents[0].decisionRaw += " ", s => s.entries[f.cloud.id].reservedMicros = 1,
    s => s.reconciliations[0].plan.entries[0].accountedMicros = 0];
  for (const edit of edits) {
    const changed = structuredClone(good); edit(changed); await writeJson(f.ledgerPath, changed);
    await assert.rejects(f.guard());
  }
  await writeJson(f.ledgerPath, good);
  await assert.rejects(createBudgetGuard({ ledgerPath: f.ledgerPath, totalEur: 251, auditAttestation: audit(), runCoverage: f.runCoverage }), /reviewed EUR250/);
  await assert.rejects(createBudgetGuard({ ledgerPath: f.ledgerPath, totalEur: 250, auditAttestation: audit(), ceilingEvidence: f.evidence }), /per-run/);
});

test("run rationale is hash bound, necessary, nonempty; neither CLI accepts arbitrary trust or numeric limit overrides", async t => {
  const f = await setup(t);
  await assert.rejects(verifyBudgetRunCoverage({ coveragePath: f.coveragePath, expectedSha256: "a".repeat(64) }), /hash differs/);
  f.coverage.coverageRationale = " "; await assert.rejects(f.verifyCoverage(), /coverage plan/);
  f.coverage.coverageRationale = "Useful run"; f.coverage.necessaryMigrationFixOrRetest = false;
  await assert.rejects(f.verifyCoverage(), /coverage plan/);
  for (const option of ["--trust-sha256", "--limit", "--total-eur"]) {
    await assert.rejects(runReviewedBudgetAuthorization([option, "arbitrary"]), /Unknown/);
  }
});

test("existing transaction lock is respected and concurrent exact-hash replay appends only one event", async t => {
  const f = await setup(t);
  await mkdir(`${f.ledgerPath}.lock`);
  await assert.rejects(applyReviewedBudgetCeiling({ ...f.options, lockTimeoutMs: 20 }), /locked/);
  await rm(`${f.ledgerPath}.lock`, { recursive: true });
  const hash = await fileHash(f.ledgerPath);
  const results = await Promise.all([f.apply({ expectedLedgerSha256: hash }), f.apply({ expectedLedgerSha256: hash })]);
  assert.equal(results.filter(row => row.idempotent).length, 1);
  assert.equal((await json(f.ledgerPath)).budgetAuthorizationEvents.length, 1);
});


test("new matching fixture pins cannot authorize an arbitrary ceiling or another scope; an existing backup stops publication", async t => {
  const f = await setup(t), before = await readFile(f.ledgerPath);
  f.authorization.hardLimitMicros = 251_000_000;
  await assert.rejects(f.verify(), /financial contract/);
  f.authorization.hardLimitMicros = 250_000_000;
  f.authorization.scopeEventId = "a".repeat(64);
  const otherScope = await f.verify();
  await assert.rejects(applyReviewedBudgetCeiling({ ...f.options, evidence: otherScope }), /another ledger, scope or limit/);
  assert.deepEqual(await readFile(f.ledgerPath), before);
  await writeJson(join(f.root, "before-authorization.json"), { existing: "preserve" });
  await assert.rejects(activate(f), /EEXIST/);
  assert.deepEqual(await readFile(f.ledgerPath), before);
  assert.deepEqual(await json(join(f.root, "before-authorization.json")), { existing: "preserve" });
});


const runnerHealth = (limitEur = 100) => ({ ok: true, bodyMutation: false, outputCaps: false,
  budgetGuardOperational: true, budgetEvidence: { enforcement: "local-durable-worst-case-reservations",
    frozen: false, limitEur, manifestSha256: "a".repeat(64) } });

async function runnerCoverage(t) {
  const f = await setup(t);
  const suite = { id: "exact-suite", model: { providerID: "benchmark", variant: "medium" },
    tasks: [{ id: "resource-task", prompt: "Unchanged actual task" }] };
  const suitePath = join(f.root, "suite.json");
  await writeJson(suitePath, suite);
  f.coverage.taskIDs = ["resource-task"];
  f.coverage.suitePath = suitePath;
  f.coverage.suiteSha256 = await fileHash(suitePath);
  const runCoverage = await f.verifyCoverage();
  const health = runnerHealth(250);
  Object.assign(health.budgetEvidence, { ledgerVersion: 3, scope: "migration-model-tokens-only",
    planningTargetEur: 100, authorizationSha256: approvedBudgetCeilingAuthorizationSha256,
    runCoverage: verifiedBudgetRunCoverage(runCoverage) });
  return { f, suite, suitePath, health };
}

test("paid runner retains original <=100 guard behavior and rejects unhealthy/uncapped declarations", async () => {
  assert.deepEqual(await verifyPaidRunBudget(runnerHealth(), undefined), { limitEur: 100, authorization: "original-ceiling" });
  assert.equal((await verifyPaidRunBudget(runnerHealth(50), undefined)).limitEur, 50);
  const mutations = [h => h.budgetGuardOperational = false, h => h.ok = false,
    h => h.bodyMutation = true, h => h.outputCaps = true, h => h.budgetEvidence.frozen = true,
    h => h.budgetEvidence.enforcement = "declarative", h => h.budgetEvidence.limitEur = 0,
    h => h.budgetEvidence.limitEur = NaN, h => h.budgetEvidence.manifestSha256 = undefined];
  for (const mutate of mutations) {
    const health = runnerHealth(); mutate(health);
    await assert.rejects(verifyPaidRunBudget(health), /live transparent durable/);
  }
});

test("paid runner accepts250 only with pinned authorization and exact ordinary coverage/suite/task bytes", async t => {
  const { health, suite } = await runnerCoverage(t);
  const original = structuredClone({ health, suite });
  const result = await verifyPaidRunBudget(health, suite);
  assert.equal(result.limitEur, 250); assert.equal(result.planningTargetEur, 100);
  assert.equal(result.authorizationSha256, approvedBudgetCeilingAuthorizationSha256);
  assert.deepEqual(result.taskIDs, ["resource-task"]);
  assert.deepEqual({ health, suite }, original);
});

test("paid runner rejects arbitrary increased limits and forged/missing authorization or coverage", async t => {
  const { health, suite } = await runnerCoverage(t);
  const mutations = [h => h.budgetEvidence.limitEur = 101, h => h.budgetEvidence.limitEur = 251,
    h => h.budgetEvidence.authorizationSha256 = "b".repeat(64), h => h.budgetEvidence.ledgerVersion = 2,
    h => h.budgetEvidence.scope = "all-costs", h => h.budgetEvidence.planningTargetEur = 250,
    h => delete h.budgetEvidence.runCoverage,
    h => h.budgetEvidence.runCoverage.coverageSha256 = "b".repeat(64),
    h => h.budgetEvidence.runCoverage.coverageRationale += "forged"];
  for (const mutate of mutations) {
    const changed = structuredClone(health); mutate(changed);
    await assert.rejects(verifyPaidRunBudget(changed, suite));
  }
});

test("paid runner rejects coverage from another task, changed full suite, changed source bytes or symlink", async t => {
  const { f, health, suite, suitePath } = await runnerCoverage(t);
  const wrongTask = structuredClone(suite); wrongTask.tasks[0].id = "another-task";
  await assert.rejects(verifyPaidRunBudget(health, wrongTask), /task identities/);
  const wrongPrompt = structuredClone(suite); wrongPrompt.tasks[0].prompt = "Different task";
  await assert.rejects(verifyPaidRunBudget(health, wrongPrompt), /parsed identity/);
  const bytes = await readFile(suitePath);
  await writeJson(suitePath, wrongPrompt);
  await assert.rejects(verifyPaidRunBudget(health, suite), /suite bytes/);
  await import("node:fs/promises").then(async fs => {
    await fs.writeFile(suitePath, bytes); await fs.rename(suitePath, suitePath + ".original");
    await fs.symlink(suitePath + ".original", suitePath);
  });
  await assert.rejects(verifyPaidRunBudget(health, suite), /ordinary file/);
  assert.equal((await json(f.ledgerPath)).limitMicros, 100_000_000);
});
