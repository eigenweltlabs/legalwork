import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditBudgetModelInfo } from "./budget-audit.mjs";
import { createBudgetGuard } from "./budget-guard.mjs";
import { auditedGatewayDeployments, budgetRateManifest } from "./budget-rates.mjs";
import { sha256, verifyBudgetReconciliation } from "./budget-reconciliation.mjs";

const model = "Eigenwelt Europe Gemini";
export const deployment = "29e13e7f-6939-406a-a5a6-1e2a9acb75db";
const keyHash = "a".repeat(64);
export const complete = { httpStatus: 200, completed: true, usage: { input: 100_000, output: 100, complete: true } };
export const request = requestId => ({ requestId, model, route: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: "Full legal task" }] } });
export function audit() {
  return auditBudgetModelInfo({ data: Object.entries(auditedGatewayDeployments).map(([id, row]) => {
    const rate = budgetRateManifest.models[row.alias];
    return { model_name: row.alias, model_info: { id, max_input_tokens: rate.inputTokens, max_output_tokens: rate.outputTokens },
      litellm_params: { order: row.order, input_cost_per_token: rate.inputMicrosPerMillion / 1e12,
        output_cost_per_token: rate.outputMicrosPerMillion / 1e12,
        model: row.transport === "bedrock" ? `bedrock/converse/eu.anthropic.${row.model.replace("5.5", "5-5")}`
          : row.transport === "openrouter" ? `openai/anthropic/${row.model}` : `vertex_ai/${row.model}` } };
  }) });
}
export async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
export const json = path => readFile(path, "utf8").then(JSON.parse);
export const fileHash = path => readFile(path).then(sha256);

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-evidenced-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.json");
  const guard = await createBudgetGuard({ ledgerPath, auditAttestation: audit() });
  const completed = await guard.reserve(request("completed"));
  await guard.reconcile(completed, complete);
  const cancelled = await guard.reserve(request("cancelled"));
  await guard.reconcile(cancelled, { cancelled: true });
  const cloud = await guard.reserveExternal({ requestId: "cloud", label: "Cloud lease", maxEur: 8 });
  const original = await json(ledgerPath);
  const originalLedgerHash = await fileHash(ledgerPath);
  const snapshotPath = join(root, "snapshot.json");
  await writeJson(snapshotPath, original);
  const pageDirectory = join(root, "attempt3-stable-read");
  await mkdir(pageDirectory);
  const pagePath = join(pageDirectory, "spend-page-0001.json");
  const collectionPath = join(pageDirectory, "collection.receipt.json");
  const mappingPath = join(root, "local-to-gateway-mapping.json");
  const receiptPath = join(root, "receipt.json");
  const reviewPath = join(root, "review.json");
  const rows = [], mapping = [];
  for (const [index, token] of [completed, cancelled].entries()) {
    const originalEntry = original.entries[token.id];
    const status = index ? "cancelled" : "completed";
    const gateway = { request_id: `gateway-${index}`, litellm_call_id: `call-${index}`, model_id: deployment,
      model: "vertex_ai/gemini-3.8-flash", model_group: model, status: "success", spend: index ? 0.02 : 0.01, keyHashMatches: true };
    rows.push(gateway);
    const tracePath = join(root, `trace-${index}.json`), responsePath = join(root, `response-${index}.raw`);
    await writeJson(tracePath, { id: originalEntry.requestId, status, ...(index ? {} : { actualBackend: { deploymentId: deployment } }) });
    await writeFile(responsePath, `data: ${JSON.stringify({ id: gateway.request_id, ...(index ? {} : { usage: { cost: gateway.spend } }) })}\n\ndata: [DONE]\n\n`);
    mapping.push({ localId: originalEntry.requestId, status,
      ledger: { id: token.id, ...Object.fromEntries(["requestId", "status", "reservedMicros", "accountedMicros"].map(name => [name, originalEntry[name]])) },
      gateway, trace: { path: tracePath, sha256: await fileHash(tracePath) }, response: { path: responsePath, sha256: await fileHash(responsePath) },
      deploymentMatches: index ? null : true, observedUsageCostEur: index ? null : gateway.spend });
  }
  await writeJson(pagePath, { httpStatus: 200, query: { api_key: keyHash }, sanitized: { page: 1, total: 2, total_pages: 1, records: rows } });
  await writeJson(mappingPath, mapping);
  await writeJson(collectionPath, { key: { hash: keyHash }, logs: { completePagination: true, expectedTotal: 2, expectedPages: 1 },
    ledger: { snapshot: { path: snapshotPath, sha256: await fileHash(snapshotPath) }, originalSha256: originalLedgerHash },
    keyBefore: { info: { spend: 0.03 } }, keyAfter: { info: { spend: 0.03 } } });
  const trust = { requests: 2, accountedMicros: 30_000, cancelledRequestIds: ["cancelled"] };
  async function seal() {
    const evidenceFiles = await Promise.all([snapshotPath, pagePath, mappingPath, collectionPath]
      .map(async path => ({ path, sha256: await fileHash(path) })));
    await writeJson(receiptPath, { keyHash, ledger: { sha256: originalLedgerHash }, evidenceFiles,
      timing: { keySpendStableAcrossFourSuccessfulReads: true, recordsIdenticalAcrossCollections: true,
        secondsBetweenKeyReads: 80, secondsFromLastCapturedResponseToFirstKeyRead: 100 } });
    trust.receiptSha256 = await fileHash(receiptPath);
    await writeJson(reviewPath, { receiptSha256: trust.receiptSha256, ledgerChanged: false, mappedRequests: 2, perRequestRoundedUpMicros: 30_000 });
    trust.reviewSha256 = await fileHash(reviewPath);
  }
  await seal();
  const verify = () => verifyBudgetReconciliation({ receiptPath, reviewPath, trust });
  return { root, ledgerPath, guard, original, cloud, completed, cancelled, pagePath, mappingPath, receiptPath, reviewPath, trust, seal, verify };
}
