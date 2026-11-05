import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditedGatewayDeployments, auditedGatewayDeploymentsSha256, budgetRateManifest, budgetRateManifestSha256 } from "./budget-rates.mjs";

const excludedTariffs = new Set(["google_maps_grounding_cost_per_query"]);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Supply an actual fresh authenticated /model/info response in memory only.
 * The returned object contains selected nonsecret price and deployment facts.
 */
export function auditBudgetModelInfo(modelInfo, { verifiedAt = new Date().toISOString() } = {}) {
  const aliases = [...new Set(Object.values(auditedGatewayDeployments).map(value => value.alias))].sort();
  const snapshot = [];
  for (const alias of aliases) {
    const rate = budgetRateManifest.models[alias];
    const rows = modelInfo?.data?.filter(value => value.model_name === alias);
    const expected = Object.entries(auditedGatewayDeployments).filter(([, value]) => value.alias === alias);
    if (!rows?.length || rows.length !== expected.length || new Set(rows.map(row => row.model_info?.id)).size !== expected.length) {
      throw new Error(`Budget re-audit required: deployment count or identity changed for ${alias}`);
    }
    for (const row of rows) {
      const info = row.model_info ?? {};
      const params = row.litellm_params ?? {};
      const deployment = auditedGatewayDeployments[info.id];
      const expectedUpstream = deployment?.transport === "bedrock" ? `bedrock/converse/eu.anthropic.${deployment.model.replace("5.5", "5-5")}`
        : deployment?.transport === "openrouter" ? `openai/anthropic/${deployment.model}` : `vertex_ai/${deployment?.model}`;
      if (!deployment || deployment.alias !== alias || params.order !== deployment.order
        || params.model !== expectedUpstream) {
        throw new Error(`Budget re-audit required: unknown or changed deployment for ${alias}`);
      }
      if (info.max_input_tokens !== rate.inputTokens || info.max_output_tokens !== rate.outputTokens) {
        throw new Error(`Budget re-audit required: natural model limits changed for ${alias}`);
      }
      const prices = Object.fromEntries(Object.entries({ ...info, ...params })
        .filter(([key, value]) => (key.includes("cost") || key.includes("price")) && typeof value === "number" && value > 0)
        .sort(([left], [right]) => left.localeCompare(right)));
      if (!prices.input_cost_per_token || !prices.output_cost_per_token) throw new Error(`Missing token tariffs for ${alias}`);
      let largestInput = 0, largestOutput = 0, reasoning = 0;
      for (const [key, value] of Object.entries(prices)) {
        if (!Number.isFinite(value)) throw new Error(`Nonfinite tariff for ${alias}`);
        if (excludedTariffs.has(key)) continue; // Hosted maps/search tools are refused before dispatch.
        if (key === "output_cost_per_reasoning_token") reasoning = value;
        else if (key.includes("input") && key.includes("token") && !/audio|image|video/.test(key)) largestInput = Math.max(largestInput, value);
        else if (key.includes("output") && key.includes("token") && !/audio|image|video/.test(key)) largestOutput = Math.max(largestOutput, value);
        else throw new Error(`Budget re-audit required: unpriced tariff ${key} for ${alias}`);
      }
      if (largestInput * 1e12 > rate.inputMicrosPerMillion + 0.01
        || (largestOutput + reasoning) * 1e12 > rate.outputMicrosPerMillion + 0.01) {
        throw new Error(`Budget re-audit required: token tariffs exceed the conservative envelope for ${alias}`);
      }
      snapshot.push({ alias, deploymentId: info.id, upstream: params.model, order: params.order,
        inputTokens: info.max_input_tokens, outputTokens: info.max_output_tokens, prices });
    }
  }
  snapshot.sort((left, right) => left.deploymentId.localeCompare(right.deploymentId));
  return { version: 1, source: "production-model-info", currency: "EUR", verifiedAt,
    manifestSha256: budgetRateManifestSha256, deploymentManifestSha256: auditedGatewayDeploymentsSha256,
    snapshotSha256: hash(snapshot), snapshot };
}

/** Freshness is a run-start accounting preflight, not an agent output cap. */
export function verifyBudgetAudit(attestation, now = Date.now()) {
  if (attestation?.version !== 1 || attestation.source !== "production-model-info"
    || attestation.currency !== "EUR" || attestation.manifestSha256 !== budgetRateManifestSha256
    || attestation.deploymentManifestSha256 !== auditedGatewayDeploymentsSha256
    || !Array.isArray(attestation.snapshot) || attestation.snapshotSha256 !== hash(attestation.snapshot)) {
    throw new Error("A matching actual production model/price re-audit is required before paid benchmark startup");
  }
  const verifiedAt = Date.parse(attestation.verifiedAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > now + 60_000 || now - verifiedAt > 15 * 60_000) {
    throw new Error("Refresh the authenticated production model/price audit within 15 minutes before benchmark startup");
  }
  // Re-run the full audit from the selected facts; a hash/date alone is not
  // sufficient proof that each deployed route still fits the cost envelope.
  const reconstructed = { data: attestation.snapshot.map(row => ({ model_name: row.alias,
    model_info: { id: row.deploymentId, max_input_tokens: row.inputTokens, max_output_tokens: row.outputTokens, ...row.prices },
    litellm_params: { model: row.upstream, order: row.order } })) };
  const result = auditBudgetModelInfo(reconstructed, { verifiedAt: attestation.verifiedAt });
  if (result.snapshotSha256 !== attestation.snapshotSha256) throw new Error("Budget audit facts are not canonical");
  return { source: attestation.source, verifiedAt: attestation.verifiedAt, snapshotSha256: attestation.snapshotSha256,
    manifestSha256: attestation.manifestSha256, deploymentManifestSha256: attestation.deploymentManifestSha256 };
}

/** Read-only production preflight. Never mints a key or calls inference. */
export async function refreshBudgetAuditReceipt(outputPath) {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  if (typeof outputPath !== "string" || !isAbsolute(outputPath)) throw new Error("Use an absolute budget audit receipt path outside the repository");
  const path = resolve(outputPath);
  const relation = relative(repository, path);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) throw new Error("Keep budget audit receipts outside Git");
  let masterKey;
  try {
    const credential = await promisify(execFile)("gcloud", ["secrets", "versions", "access", "latest",
      "--secret=LITELLM_MASTER_KEY", "--project=eigenweltlabs-training"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    masterKey = credential.stdout.trim();
  } catch { throw new Error("Production budget audit credential is unavailable; no inference was attempted"); }
  if (!masterKey) throw new Error("Production budget audit credential is empty");
  let response;
  try { response = await fetch("https://api.eigenweltlabs.com/model/info", { headers: { Authorization: `Bearer ${masterKey}` }, signal: AbortSignal.timeout(30_000) }); }
  finally { masterKey = undefined; }
  if (!response.ok) throw new Error(`Production model-info audit returned HTTP ${response.status}`);
  const attestation = auditBudgetModelInfo(await response.json());
  const audit = verifyBudgetAudit(attestation);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(attestation, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  return { path, audit, deployments: attestation.snapshot.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("Usage: node scripts/benchmarks/budget-audit.mjs --output /absolute/private/budget-audit.json");
  try { process.stdout.write(`${JSON.stringify(await refreshBudgetAuditReceipt(process.argv[3]))}\n`); }
  catch (error) {
    const safe = /^(?:Budget re-audit required|Missing token tariffs|Nonfinite tariff|Production budget audit credential|Production model-info audit|A matching actual production|Refresh the authenticated|Budget audit facts|Use an absolute budget|Keep budget audit)/.test(error.message);
    process.stderr.write(`Production budget audit failed. No key was minted or inference attempted.${safe ? ` ${error.message}` : " Inspect the nonsecret model/rate contract before retrying."}\n`);
    process.exitCode = 1;
  }
}
