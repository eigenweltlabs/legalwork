import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { privateWrite, sha256 } from "./evidence.mjs";
import { responseUsage } from "./protocol.mjs";
import { auditedGatewayDeployments, auditedGatewayDeploymentsSha256 } from "./budget-rates.mjs";

const safeResponseHeaders = new Set(["content-type", "x-request-id", "request-id", "x-litellm-response-cost", "x-litellm-model-id", "x-litellm-cache-hit", "retry-after"]);

export function requestDiagnostics(headers) {
  const names = ["anthropic-version", "anthropic-beta", "x-opencode-session-id", "x-opencode-parent-session-id", "x-opencode-project", "x-opencode-client", "x-session-affinity", "x-session-id", "x-parent-session-id", "x-opencode-session", "x-opencode-request"];
  const retained = Object.fromEntries(names.flatMap(name => typeof headers[name] === "string" ? [[name, headers[name]]] : []));
  const sessions = [...new Set(["x-opencode-session-id", "x-session-id", "x-session-affinity", "x-opencode-session"].map(name => retained[name]).filter(Boolean))];
  const parents = [...new Set(["x-opencode-parent-session-id", "x-parent-session-id"].map(name => retained[name]).filter(Boolean))];
  return { headers: retained, context: { sessionID: sessions.length === 1 ? sessions[0] : null, parentSessionID: parents.length === 1 ? parents[0] : null, attributionConflict: sessions.length > 1 || parents.length > 1, project: retained["x-opencode-project"] ?? null, client: retained["x-opencode-client"] ?? null, kindAttribution: "unavailable-wire-headers-do-not-identify-main-title-or-compaction" } };
}

function authorized(request, token) {
  const actual = Buffer.from(String(request.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }

export async function startCaptureProxy({ root, baseURL, apiKey, localToken, models, budgetEvidence, budgetGuard, fixtureMode = false, port = 0 }) {
  if (!apiKey || !localToken || !models?.length) throw new Error("Explicit gateway credential, local token and model allowlist are required");
  const upstreamBase = new URL(baseURL);
  if (!["http:", "https:"].includes(upstreamBase.protocol) || upstreamBase.username || upstreamBase.password || upstreamBase.search) throw new Error("Invalid gateway URL");
  if (!budgetGuard && !(fixtureMode && upstreamBase.hostname === "127.0.0.1")) throw new Error("An operational budget guard is mandatory outside explicit loopback protocol fixtures");
  await mkdir(join(root, "requests"), { recursive: true, mode: 0o700 });
  let activeRequests = 0;
  const records = new Map();
  const inFlight = new Set();
  const captureErrors = [];
  async function handle(request, response) {
    if (!authorized(request, localToken)) return json(response, 401, { error: "Unauthorized" });
    if (request.url === "/health" && request.method === "GET") return json(response, 200, { ok: captureErrors.length === 0, captureErrors, activeRequests, budgetEvidence: budgetGuard ? await budgetGuard.health() : budgetEvidence, budgetGuardOperational: Boolean(budgetGuard), models, bodyMutation: false, outputCaps: false });
    if (request.url === "/traces" && request.method === "GET") return json(response, 200, { items: [...records.values()] });
    if (request.url === "/v1/models" && request.method === "GET") return json(response, 200, { object: "list", data: models.map(id => ({ id, object: "model" })) });
    const routes = new Map([["/v1/chat/completions", "openai"], ["/v1/messages", "anthropic"], ["/v1/responses", "responses"]]);
    const protocol = routes.get(request.url);
    if (!protocol || request.method !== "POST") return json(response, 404, { error: "Unsupported inference route" });
    const id = randomUUID();
    const directory = join(root, "requests", id);
    const controller = new AbortController();
    const started = performance.now();
    let record = { id, protocol, startedAt: new Date().toISOString(), status: "receiving", budgetEvidence };
    let capture;
    let ownsRequest = false;
    let reservation;
    let upstreamHeaders;
    response.on("close", () => { if (!response.writableFinished) controller.abort(new Error("Client disconnected")); });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const parsed = JSON.parse(raw.toString());
      if (!models.includes(parsed.model)) return json(response, 400, { error: "Model outside migration benchmark allowlist" });
      record = { ...record, model: parsed.model, requestBytes: raw.length, requestSha256: sha256(raw), generationSettings: Object.fromEntries(Object.entries(parsed).filter(([name]) => !["messages", "tools", "functions", "system", "model"].includes(name))), toolCatalogSha256: sha256(JSON.stringify(parsed.tools ?? parsed.functions ?? [])), systemPrefixSha256: sha256(JSON.stringify(parsed.system ?? parsed.messages?.filter(message => ["system", "developer"].includes(message.role)) ?? [])), status: "forwarding" };
      await privateWrite(join(directory, "request.json"), raw);
      // These diagnostic headers affect native Anthropic behavior; credentials are never persisted.
      const diagnostics = requestDiagnostics(request.headers);
      const nativeHeaders = diagnostics.headers;
      record.requestContext = diagnostics.context;
      await privateWrite(join(directory, "request-headers.json"), nativeHeaders);
      await privateWrite(join(directory, "trace.json"), record);
      records.set(id, record);
      if (budgetGuard) reservation = await budgetGuard.reserve({ model: parsed.model, route: request.url, body: parsed, requestId: id });
      activeRequests++; ownsRequest = true;
      const removedRequestHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "authorization", "x-api-key", "x-goog-api-key", "proxy-authorization"]);
      const forwardedHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => !removedRequestHeaders.has(name) && typeof value === "string"));
      const upstream = await fetch(`${baseURL.replace(/\/$/, "")}/${request.url.slice(4)}`, {
        method: "POST", headers: { ...forwardedHeaders, "content-type": request.headers["content-type"] ?? "application/json", authorization: `Bearer ${apiKey}`, ...(protocol === "anthropic" ? { "x-api-key": apiKey, ...nativeHeaders } : {}) }, body: raw, signal: controller.signal,
      });
      record.httpStatus = upstream.status;
      record.headersReceivedMs = performance.now() - started;
      const headers = Object.fromEntries([...upstream.headers].filter(([name]) => safeResponseHeaders.has(name)));
      upstreamHeaders = Object.fromEntries(upstream.headers);
      await privateWrite(join(directory, "response-headers.json"), headers);
      const removedResponseHeaders = new Set(["connection", "transfer-encoding", "content-length", "content-encoding", "set-cookie"]);
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !removedResponseHeaders.has(name))));
      capture = await open(join(directory, "response.raw"), "wx", 0o600);
      const responseChunks = [];
      let responseBytes = 0;
      for await (const chunk of upstream.body ?? []) {
        if (record.firstByteMs === undefined) record.firstByteMs = performance.now() - started;
        await capture.write(chunk);
        responseChunks.push(chunk);
        responseBytes += chunk.byteLength;
        if (!response.destroyed && !response.write(chunk)) await Promise.race([once(response, "drain"), once(response, "close")]);
      }
      record.responseBytes = responseBytes;
      record.usage = responseUsage(Buffer.concat(responseChunks).toString(), protocol);
      const deploymentId = headers["x-litellm-model-id"];
      record.actualBackend = { deploymentId: deploymentId ?? null, ...(auditedGatewayDeployments[deploymentId] ?? {}), mappingSha256: auditedGatewayDeploymentsSha256, verifiedMapping: Boolean(auditedGatewayDeployments[deploymentId]), reportedModels: record.usage.reportedModels };
      record.gatewayReportedCost = headers["x-litellm-response-cost"] ?? null;
      record.gatewayHeaderReportedCostEur = headers["x-litellm-response-cost"] !== undefined && Number.isFinite(Number(headers["x-litellm-response-cost"])) ? Number(headers["x-litellm-response-cost"]) : null;
      record.gatewayUsageReportedCostEur = typeof record.usage?.raw?.cost === "number" && Number.isFinite(record.usage.raw.cost) && record.usage.raw.cost >= 0 ? record.usage.raw.cost : null;
      record.gatewayReportedCostEur = record.gatewayHeaderReportedCostEur ?? record.gatewayUsageReportedCostEur;
      record.gatewayReportedCostSource = record.gatewayHeaderReportedCostEur !== null ? "x-litellm-response-cost" : record.gatewayUsageReportedCostEur !== null ? "usage.cost" : "unavailable";
      record.costCurrency = budgetGuard ? "EUR-audited-gateway-contract" : "test-fixture-only";
      record.status = "completed";
      response.end();
    } catch (error) {
      record.status = controller.signal.aborted ? "cancelled" : "failed";
      record.error = String(error);
      if (!response.destroyed) { if (!response.headersSent) json(response, reservation ? 502 : error.code ? 402 : 502, { error: { code: error.code ?? "benchmark_upstream_or_capture_failed", message: error.code ? error.message : "Benchmark upstream/capture failed; see private trace" } }); else response.end(); }
    } finally {
      controller.abort();
      await capture?.close();
      if (ownsRequest) activeRequests--;
      if (reservation) {
        try { record.budget = await budgetGuard.reconcile(reservation, { httpStatus: record.httpStatus, responseHeaders: upstreamHeaders, usage: record.usage, completed: record.status === "completed", error: record.error, cancelled: record.status === "cancelled" }); }
        catch (error) { record.budgetReconciliationError = String(error); record.status = "budget-reconciliation-failed"; }
      }
      record.finishedAt = new Date().toISOString();
      record.elapsedMs = performance.now() - started;
      await privateWrite(join(directory, "trace.json"), record);
      records.set(id, record);
    }
  }
  const server = http.createServer((request, response) => {
    const operation = handle(request, response);
    inFlight.add(operation);
    operation.catch(error => {
      captureErrors.push(String(error));
      if (!response.destroyed) { if (!response.headersSent) json(response, 500, { error: "Trace capture failed; evidence is incomplete" }); else response.end(); }
    }).finally(() => inFlight.delete(operation));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { baseURL: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...inFlight]); } };
}
