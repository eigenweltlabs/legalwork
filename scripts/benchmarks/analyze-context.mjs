// Offline, credential-free summaries of full captured requests. Byte counts
// describe sections; provider-reported tokens remain the only token counts.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint, inside, privateWrite, readJson, sha256 } from "./evidence.mjs";
import { summarizeContextUsage } from "./context-usage.mjs";

const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const root = option("--root");
if (!root) throw new Error("--root is required");
const source = option("--traces", join(root, "provider-traces/requests"));
const run=option("--run");
const runResult=run ? await readJson(join(run,"result.json")):null;
const selectedIDs=runResult?.providerTraces?.map(trace=>trace.id);
if(run && (!selectedIDs?.length || new Set(selectedIDs).size!==selectedIDs.length))throw new Error("Run has no complete unique provider request identity set");
const bytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null));
const rows = [];
for (const id of selectedIDs ?? await readdir(source)) {
  const directory = inside(source, id);
  const body = await readJson(join(directory, "request.json"));
  const trace = await readJson(join(directory, "trace.json"));
  const system = body.messages?.filter(message => ["system", "developer"].includes(message.role)) ?? [];
  const toolSchemas = (body.tools ?? []).map(tool => ({ name: tool.function?.name, bytes: bytes(tool), descriptionBytes: bytes(tool.function?.description), parameterBytes: bytes(tool.function?.parameters) })).sort((a, b) => b.bytes - a.bytes);
  const contextParts = Object.fromEntries(["system", "developer", "user", "assistant", "tool"].map(role => [role, { messages: body.messages?.filter(message => message.role === role).length ?? 0, bytes: bytes(body.messages?.filter(message => message.role === role) ?? []) }]));
  rows.push({ requestId: id, startedAt: trace.startedAt, elapsedMs: trace.elapsedMs, firstByteMs: trace.firstByteMs, actualBackend: trace.actualBackend, generationSettings: trace.generationSettings, toolCount: body.tools?.length ?? 0, toolSchemaBytes: bytes(body.tools ?? []), toolCatalogSha256: sha256(JSON.stringify(body.tools ?? [])), systemBytes: bytes(system), systemPrefixSha256: sha256(JSON.stringify(system)), systemChunks: system.map((message, index) => ({ index, bytes: bytes(message.content), sha256: sha256(JSON.stringify(message.content)) })), contextParts, toolSchemas, providerUsage: trace.usage, gatewayCostHeader: trace.gatewayReportedCost, gatewayUsageReportedCostEur: typeof trace.usage?.raw?.cost === "number" ? trace.usage.raw.cost : null });
}
rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const totals = summarizeContextUsage(rows);
const report = { timestamp: new Date().toISOString(), selection:run ? {scope:"exact-run-request-identities",run,sourceResult:await fingerprint(join(run,"result.json")),requestIDs:selectedIDs}:{scope:"entire-trace-directory",source}, measurement: "Exact serialized section bytes plus actual provider token/billing reports; no section-token estimates", limitations: ["A single observed task does not establish causal performance improvements or reliability.", "Cache usage is reported when exposed; a missing field is not assumed zero.", "Auxiliary classification from tool count/settings is a heuristic; every captured request remains included.", "Raw source requests remain private and complete; this summary contains no source/system prompt text."], totals, requests: rows };
const output = option("--output", join(root, "context-analysis.json"));
await privateWrite(output, report);
console.log(JSON.stringify({ report: output, totals, requestComposition: rows.map(row => ({ id: row.requestId, toolCount: row.toolCount, toolSchemaBytes: row.toolSchemaBytes, systemBytes: row.systemBytes, inputTokens: row.providerUsage?.input, cacheReadTokens: row.providerUsage?.cacheRead, costEur: row.gatewayUsageReportedCostEur })), largestToolSchemas: rows.find(row => row.toolCount)?.toolSchemas.slice(0, 10) }, null, 2));
