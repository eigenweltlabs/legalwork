/** Run with Bun, or bundle for Node 22+ with esbuild (module/main resolution, external @napi-rs/canvas and bun:sqlite,
 * define process.versions.bun=undefined). Uses a private temporary profile and a loopback fault-injection engine.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { currentAssistantQuery, resolveAssistantChat } from "../src/react-app/shell/assistant-navigation";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { createAssistantRuntime } from "../../server/src/assistant-runtime.js";
import { ApprovalService } from "../../server/src/approvals.js";
import { ReloadEventStore } from "../../server/src/events.js";
import { TokenService } from "../../server/src/tokens.js";
import { ScheduledTaskStore } from "../../server/src/scheduled-tasks/store.js";
import { matchRoute, type Route } from "../../server/src/routes/registry.js";
import { ApiError } from "../../server/src/errors.js";
import { writeEigenweltConnection } from "../../server/src/eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../../server/src/eigenwelt-auth.js";
import { assistantRouteRequiresSubscription, requireAssistantSubscription } from "../../server/src/assistant-subscription.js";
import type { ServerConfig, WorkspaceInfo } from "../../server/src/types.js";

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

async function listen(handler: (request: Request) => Promise<Response>) {
  const server = createServer(async (incoming: IncomingMessage, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers,
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET") ? {} : { body: Buffer.concat(chunks).toString() }) });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.log(JSON.stringify({ stage: "request-error", message: error instanceof Error ? error.message : String(error) }));
      outgoing.writeHead(error instanceof ApiError ? error.status : 500, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

const root = await mkdtemp(join(tmpdir(), "legalwork-assistant-recovery-"));
// All stores, including connector/entitlement stores, must stay inside this fixture.
process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
process.env.OPENCODE_DB = join(root, "engine.sqlite");
let listings = 0, creations = 0, currentRequests = 0, statusRequests = 0, created = false, stall = true;
const session = { id: "recovered-daily-chat", title: "", projectID: "fixture", location: { directory: root },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now(), updated: Date.now() } };
const engine = await listen(async request => {
  const path = new URL(request.url).pathname;
  if (path === "/api/session" && request.method === "GET") {
    listings++;
    if (stall) await sleep(11_000);
    return Response.json({ data: created ? [session] : [], cursor: { next: null, previous: null } });
  }
  if (path === "/api/session" && request.method === "POST") {
    const input = record(await request.json());
    assert.equal(typeof input.title, "string");
    session.title = String(input.title); created = true; creations++;
    return Response.json({ data: session });
  }
  if (path === `/api/session/${session.id}`) return created ? Response.json({ data: session }) : new Response(null, { status: 404 });
  return new Response(null, { status: 404 });
});
const workspace: WorkspaceInfo = { id: "assistant", name: "Assistant", path: root, preset: "main-assistant", workspaceType: "local" };
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "synthetic-fixture-token", hostToken: "synthetic-host-token",
  configPath: join(root, "server.json"), opencodeBaseUrl: engine.url, workspaces: [workspace], authorizedRoots: [root],
  approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(),
  tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
const runtime = await createAssistantRuntime(config, {
  scheduledTasks: await ScheduledTaskStore.open(process.env.LEGALWORK_RUNTIME_DB),
  resolveWorkspace: async id => { assert.equal(id, workspace.id); return workspace; }, changed: () => {}, tokenActive: async () => true,
});
// The entitlement is synthetic; no platform or inference requests are made.
await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active" }), platformToken: "synthetic-no-network" });
const routes: Route[] = [];
await runtime.register(routes, {
  jsonResponse: (value, status = 200) => Response.json(value, { status }),
  readJsonBodyLimited: async request => { const text = await request.text(); return text ? record(JSON.parse(text)) : {}; },
  ensureWritable: value => assert.equal(value.readOnly, false),
  requireClientScope: ctx => assert.equal(ctx.actor?.type, "host"),
  requireApproval: async () => { throw new Error("Unexpected approval in recovery fixture"); },
});
const approvals = new ApprovalService(config.approval), reloadEvents = new ReloadEventStore(), tokens = new TokenService(config);
const api = await listen(async request => {
  if (request.headers.get("Authorization") !== `Bearer ${config.token}`) return new Response(null, { status: 401 });
  const url = new URL(request.url), route = matchRoute(routes, request.method, url.pathname);
  if (!route) return new Response(null, { status: 404 });
  if (url.pathname === "/assistant/current") currentRequests++;
  if (url.pathname === "/assistant") statusRequests++;
  if (assistantRouteRequiresSubscription(request.method, url.pathname)) await requireAssistantSubscription(config);
  return route.handler({ request, url, params: route.params, config, approvals, reloadEvents, tokens, actor: { type: "host" } });
});
const statuses: number[] = [];
const httpClient = createLegalworkServerClient({ baseUrl: api.url, token: config.token });
const client = { baseUrl: api.url, mainAssistantCurrent: async () => {
  try { const result = await httpClient.mainAssistantCurrent(); statuses.push(200); return result; }
  catch (error) { statuses.push(error instanceof LegalworkServerError ? error.status : 0); throw error; }
} };
const cache = new QueryClient({ defaultOptions: { queries: { retry: 3 } } });
const observer = new QueryObserver(cache, currentAssistantQuery(client)), unsubscribe = observer.subscribe(() => {});
try {
  await sleep(200);
  assert.equal(currentRequests, 0, "Mounting the observer must not initialize Assistant");
  const started = performance.now();
  await assert.rejects(resolveAssistantChat(client, cache));
  const timeoutMs = Math.round(performance.now() - started);
  assert(timeoutMs >= 9500 && timeoutMs < 15_000, `Production deadline took ${timeoutMs}ms`);
  assert.equal(currentRequests, 1); assert.equal(listings, 1); assert.equal(creations, 0);
  console.log(JSON.stringify({ stage: "timeout", timeoutMs, currentRequests, listings, creations }));
  stall = false;
  // Longer than the former 77-second retry/poll cycle. Passive status reads must never issue initialization POSTs.
  for (let index = 0; index < 8; index++) {
    const response = await fetch(`${api.url}/assistant`, { headers: { Authorization: `Bearer ${config.token}` } });
    assert.equal(response.status, 200); await sleep(10_000);
  }
  assert.equal(currentRequests, 1, "No automatic initialization retries after failure");
  const retryStarted = performance.now(), recovered = await resolveAssistantChat(client, cache);
  const recoveryMs = Math.round(performance.now() - retryStarted);
  assert.equal(recovered.day.sessionId, session.id); assert.equal(currentRequests, 2); assert.equal(creations, 1);
  assert.equal((await resolveAssistantChat(client, cache)).day.sessionId, session.id);
  assert.equal(currentRequests, 2, "Opening the recovered chat must use the saved identity");
  assert.equal(observer.getCurrentResult().data?.day.sessionId, session.id);
  const result = { passed: true, platform: process.platform, node: process.version, timestamp: new Date().toISOString(),
    timeoutMs, recoveryMs, observedIdleMs: 80_000, currentRequests, statusRequests, statuses, listings, creations,
    backgroundInitializationRequests: 0, duplicateDailyChats: 0, scope: "Production Assistant runtime/routes and renderer query policy, synthetic loopback engine, isolated local profile" };
  await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  unsubscribe(); cache.clear(); await runtime.close(); api.close(); engine.close();
}
