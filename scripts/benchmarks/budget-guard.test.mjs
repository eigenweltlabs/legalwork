import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBudgetGuard as openBudgetGuard } from "./budget-guard.mjs";
import { auditBudgetModelInfo, verifyBudgetAudit } from "./budget-audit.mjs";
import { auditedGatewayDeployments, budgetRateManifest } from "./budget-rates.mjs";

function auditFixture() {
  const data = Object.entries(auditedGatewayDeployments).map(([id, value]) => {
    const rate = budgetRateManifest.models[value.alias];
    return { model_name: value.alias, model_info: { id, max_input_tokens: rate.inputTokens, max_output_tokens: rate.outputTokens },
      litellm_params: { order: value.order,
        model: value.transport === "bedrock" ? `bedrock/converse/eu.anthropic.${value.model.replace("5.5", "5-5")}`
          : value.transport === "openrouter" ? `openai/anthropic/${value.model}` : `vertex_ai/${value.model}`,
        input_cost_per_token: rate.inputMicrosPerMillion / 1e12,
        output_cost_per_token: rate.outputMicrosPerMillion / 1e12 } };
  });
  return { data };
}
function createBudgetGuard(options) { return openBudgetGuard({ auditAttestation: auditBudgetModelInfo(auditFixture()), ...options }); }

const model = "Eigenwelt Europe Gemini";
const body = { model, messages: [{ role: "user", content: "Use the full document and browser tools." }],
  tools: [{ type: "function", function: { name: "browser", parameters: { type: "object" } } }], stream: true };
function request(requestId, overrides = {}) { return { model, route: "/v1/chat/completions", body: structuredClone(body), requestId, ...overrides }; }
const complete = { httpStatus: 200, completed: true, usage: { input: 1000, output: 100, complete: true } };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.json");
  return { directory, ledgerPath, guard: await createBudgetGuard({ ledgerPath, ...options }) };
}

test("reserves natural model capacity without changing request, then conservatively settles complete usage", async t => {
  const { guard, ledgerPath } = await fixture(t);
  const input = request("full-capacity");
  const original = JSON.stringify(input);
  const reservation = await guard.reserve(input);
  assert.equal(JSON.stringify(input), original);
  assert.equal(reservation.reservedMicros, 2_313_421);
  assert.equal((await guard.health()).reservedEur, 2.313421);
  const result = await guard.reconcile(reservation, complete);
  assert.equal(result.accountedMicros, 2600);
  const health = await guard.health();
  assert.equal(health.accountedUpperBoundEur, 0.0026);
  assert.equal(health.remainingEur, 99.9974);
  assert.equal(health.reportedSpendEur, 0);
  assert.equal(health.reservedEur, 0);
  assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
  assert.equal((await guard.reconcile(reservation, complete)).idempotent, true);
});

test("all three model tariffs include full input, output, priority/reasoning and 1h cache-write capacity", async t => {
  const { guard } = await fixture(t);
  for (const [name, expected] of [["Gemini", 2_313_421], ["Claude Sonnet", 5_801_600], ["Claude Opus", 11_571_200]]) {
    const alias = `Eigenwelt Europe ${name}`;
    const token = await guard.reserve(request(`model-${name.replaceAll(" ", "-")}`, { model: alias, body: { ...body, model: alias } }));
    assert.equal(token.reservedMicros, expected);
  }
});

test("denies before dispatch when remaining budget cannot fund an intact request", async t => {
  const { guard } = await fixture(t, { totalEur: 3 });
  await guard.reserve(request("first"));
  let dispatched = 0;
  await assert.rejects(async () => { await guard.reserve(request("second")); dispatched++; }, { code: "budget_exhausted" });
  assert.equal(dispatched, 0);
  assert.equal((await guard.health()).remainingEur, 0.686579);
});

test("restarts share prior spend, pending reservations and the aggregate ceiling", async t => {
  const { guard, ledgerPath } = await fixture(t, { totalEur: 3 });
  const token = await guard.reserve(request("prior-process"));
  await guard.reconcile(token, { httpStatus: 500, completed: true, responseHeaders: { "x-litellm-response-cost": "0" } });
  const restarted = await createBudgetGuard({ ledgerPath, totalEur: 3 });
  assert.equal((await restarted.health()).uncertainReservations, 1);
  await assert.rejects(restarted.reserve(request("next-process")), { code: "budget_exhausted" });
  await assert.rejects(createBudgetGuard({ ledgerPath, totalEur: 100 }), { code: "incompatible_ledger" });
});

test("missing terminal usage, cancelled requests and misleading zero headers retain the full hold", async t => {
  const { guard } = await fixture(t);
  const cases = [
    {},
    { ...complete, cancelled: true },
    { ...complete, error: new Error("connection lost") },
    { ...complete, usage: { ...complete.usage, complete: false } },
    { httpStatus: 200, completed: true, responseHeaders: { "x-litellm-response-cost": "0" } },
    { ...complete, usage: { ...complete.usage, errors: [{ code: "provider_failed" }] } },
  ];
  for (const [i, evidence] of cases.entries()) {
    const token = await guard.reserve(request(`ambiguous-${i}`));
    assert.equal((await guard.reconcile(token, evidence)).status, "uncertain");
  }
  assert.equal((await guard.health()).reservedEur, 2.313421 * cases.length);
});

test("cached input and reasoning are never subtracted as an unproven discount", async t => {
  const { guard } = await fixture(t);
  const token = await guard.reserve(request("reasoning-and-cache"));
  const result = await guard.reconcile(token, { ...complete,
    usage: { ...complete.usage, cacheRead: 500, cacheWrite: 100, reasoning: 50 } });
  assert.equal(result.accountedMicros, 4055);
});

test("unknown pricing routes, aliases, parameters and hosted tools fail closed without mutation", async t => {
  const { guard } = await fixture(t);
  for (const [input, code] of [
    [request("route", { route: "/v1/responses" }), "unpriced_route"],
    [request("model", { model: "gemini-latest" }), "unpriced_model"],
    [request("override", { body: { ...body, api_base: "https://example.com" } }), "unpriced_parameter"],
    [request("grounding", { body: { ...body, tools: [{ google_search: {} }] } }), "unpriced_builtin_tool"],
  ]) {
    const before = JSON.stringify(input);
    await assert.rejects(guard.reserve(input), { code });
    assert.equal(JSON.stringify(input), before);
  }
  assert.equal((await guard.health()).reservations, 0);
});

test("only audited text, screenshots/images and native PDF content is admitted", async t => {
  const { guard } = await fixture(t);
  for (const part of [
    { type: "text", text: "Complete document" },
    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
    { type: "file", file: { filename: "contract.pdf", file_data: "data:application/pdf;base64,aGVsbG8=" } },
  ]) {
    await guard.reserve(request(`modality-${part.type}`, { body: { ...body, messages: [{ role: "user", content: [part] }] } }));
  }
  for (const part of [
    { type: "input_audio", input_audio: { data: "aGVsbG8=", format: "wav" } },
    { type: "video_url", video_url: { url: "https://example.com/video.mp4" } },
    { type: "file", file: { filename: "audio.wav", file_data: "aGVsbG8=" } },
    { type: "image_url", image_url: { url: "data:video/mp4;base64,aGVsbG8=" } },
  ]) {
    await assert.rejects(guard.reserve(request("unpriced-content", { body: { ...body, messages: [{ role: "user", content: [part] }] } })), { code: "unpriced_modality" });
  }
});

test("startup re-audits the actual deployment identities, ceilings and every positive tariff", async t => {
  const { ledgerPath } = await fixture(t);
  await assert.rejects(openBudgetGuard({ ledgerPath }), /production model\/price re-audit/);
  const stale = auditBudgetModelInfo(auditFixture(), { verifiedAt: new Date(Date.now() - 16 * 60_000).toISOString() });
  assert.throws(() => verifyBudgetAudit(stale), /within 15 minutes/);
  const changedPrice = auditFixture();
  changedPrice.data[0].litellm_params.output_cost_per_token = 999;
  assert.throws(() => auditBudgetModelInfo(changedPrice), /tariffs exceed/);
  const unknownFee = auditFixture();
  unknownFee.data[0].model_info.input_cost_per_audio_token = 0.00001;
  assert.throws(() => auditBudgetModelInfo(unknownFee), /unpriced tariff/);
  const changedModel = auditFixture();
  changedModel.data[0].litellm_params.model += "-unverified";
  assert.throws(() => auditBudgetModelInfo(changedModel), /unknown or changed deployment/);
  const changedLimit = auditFixture();
  changedLimit.data[0].model_info.max_output_tokens++;
  assert.throws(() => auditBudgetModelInfo(changedLimit), /model limits changed/);
  const forged = auditBudgetModelInfo(auditFixture());
  forged.snapshot[0].inputTokens++;
  assert.throws(() => verifyBudgetAudit(forged), /matching actual production/);
});

test("completion multiplicity is reserved without adding a limit to the request", async t => {
  const { guard } = await fixture(t);
  const token = await guard.reserve(request("multiple", { body: { ...body, n: 2, best_of: 3 } }));
  assert.equal(token.reservedMicros, 2_313_421 * 6);
});

test("duplicate retries need a new reservation and settlement cannot refund twice", async t => {
  const { guard } = await fixture(t);
  const token = await guard.reserve(request("stable-id"));
  await assert.rejects(guard.reserve(request("stable-id")), { code: "duplicate_request" });
  await guard.reconcile(token, complete);
  await guard.reconcile(token, { ...complete, usage: { input: 0, output: 0, complete: true } });
  assert.equal((await guard.health()).accountedUpperBoundEur, 0.0026);
});

test("external holds reduce the same budget and real debits survive a restart", async t => {
  const { guard, ledgerPath } = await fixture(t);
  const token = await guard.reserveExternal({ requestId: "windows-vm", label: "Windows VM and disk", maxEur: 10 });
  assert.equal((await guard.health()).remainingEur, 90);
  await guard.settleExternal(token, { actualEur: 4.25, evidenceId: "cloud-usage-export-1" });
  const restarted = await createBudgetGuard({ ledgerPath });
  assert.equal((await restarted.health()).remainingEur, 95.75);
});

test("an observed cost beyond the audited reserve freezes all subsequent admissions", async t => {
  const { guard } = await fixture(t);
  const token = await guard.reserve(request("price-discrepancy"));
  const result = await guard.reconcile(token, { ...complete, responseHeaders: { "x-litellm-response-cost": "3.5" } });
  assert.equal(result.frozen, true);
  assert.equal((await guard.health()).frozen, true);
  await assert.rejects(guard.reserve(request("after-discrepancy")), { code: "budget_frozen" });
});

test("corrupt ledgers and abandoned locks stop work instead of creating a fresh EUR100 budget", async t => {
  const { ledgerPath } = await fixture(t);
  await writeFile(ledgerPath, "broken JSON", { mode: 0o600 });
  await assert.rejects(createBudgetGuard({ ledgerPath }), { code: "invalid_ledger" });
  await rm(ledgerPath);
  await mkdir(`${ledgerPath}.lock`);
  await assert.rejects(createBudgetGuard({ ledgerPath, lockTimeoutMs: 20 }), { code: "ledger_locked" });
});

test("accidental deletion of an initialized ledger never creates a new allowance", async t => {
  const { guard, ledgerPath } = await fixture(t);
  await guard.reserve(request("before-deletion"));
  await rm(ledgerPath);
  await assert.rejects(createBudgetGuard({ ledgerPath }), { code: "missing_ledger" });
});

test("independent processes race for one shared allowance without aggregate overspend", async t => {
  const { ledgerPath } = await fixture(t, { totalEur: 10 });
  const moduleUrl = new URL("./budget-guard.mjs", import.meta.url).href;
  const code = `import { createBudgetGuard } from ${JSON.stringify(moduleUrl)};
    const guard = await createBudgetGuard({ ledgerPath: process.argv[1], totalEur: 10, auditAttestation: ${JSON.stringify(auditBudgetModelInfo(auditFixture()))} });
    try { await guard.reserve(${JSON.stringify(request("child")) .replace('"child"', 'process.argv[2]')}); process.stdout.write('admitted'); }
    catch (error) { if (error.code !== 'budget_exhausted') throw error; process.stdout.write('denied'); }`;
  const runs = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, ledgerPath, `process-${i}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => status === 0 ? resolve(stdout) : reject(new Error(stderr)));
  })));
  assert.equal(runs.filter(result => result === "admitted").length, 4);
  const state = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(Object.keys(state.entries).length, 4);
  const guard = await createBudgetGuard({ ledgerPath, totalEur: 10 });
  assert.equal((await guard.health()).committedUpperBoundEur, 9.253684);
});
