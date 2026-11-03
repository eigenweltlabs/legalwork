import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerConfig } from "../types.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { bootstrapRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { prepareConnectorStorage, writeConnectorConnections } from "./store.js";
import { saveConnectorWriteSetting } from "./settings.js";
import { disconnectConnector } from "./broker.js";
import { createConnectorRequest } from "./request.js";

const nativeFetch = globalThis.fetch;
const envKeys = ["EIGENWELT_PLATFORM_URL", "LEGALWORK_RUNTIME_DB", "LEGALWORK_STORAGE_STORE"];
const previous = new Map(envKeys.map(key => [key, process.env[key]]));
const account = { userId: "alice", userName: "Alice", userEmail: "alice@example.test", orgId: "firm", orgName: "Firm" };
const connection = { id: "drive-account", nangoConnectionId: "private-grant", createdAt: "2026-11-01T00:00:00Z", needsReconnect: false };
const owner = JSON.stringify(["https://credential-broker.test", "firm", "alice"]);
let directory: string, config: ServerConfig, now: number;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let calls: { path: string; method: string; token: string | null }[];
let statusAllowed: boolean, statusUnavailable: boolean, providerRejects: boolean, tokenLoads: number;
let rejectedToken: string;
let brokerConnection = connection;
let tokenHandler: (() => Promise<Response>) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "connector-credential-reuse-"));
  process.env.EIGENWELT_PLATFORM_URL = "https://credential-broker.test";
  process.env.LEGALWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  process.env.LEGALWORK_STORAGE_STORE = join(directory, "file-storage.json");
  config = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await bootstrapRuntimeOpencodeConfig(config);
  await prepareConnectorStorage(config);
  await writeEigenweltConnection(config, { platformToken: "platform-session", account });
  await writeConnectorConnections(config, owner, "google-drive", [connection]);
  now = Date.now();
  clock = spyOn(Date, "now").mockImplementation(() => now);
  calls = []; statusAllowed = true; statusUnavailable = false; providerRejects = false; tokenLoads = 0; tokenHandler = undefined; brokerConnection = connection;
  rejectedToken = "Bearer provider-1";
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const token = new Headers(init?.headers).get("Authorization");
    calls.push({ path: url.pathname, method: init?.method ?? "GET", token });
    if (url.pathname === "/api/connectors") return Response.json({ configured: true, providers: [{ id: "google-drive" }] });
    if (url.pathname.endsWith("/status") && statusUnavailable) return Response.json({}, { status: 503 });
    if (url.pathname.endsWith("/status")) return statusAllowed
      ? Response.json({ connection: { ...brokerConnection, id: brokerConnection.nangoConnectionId } })
      : Response.json({}, { status: 403 });
    if (url.pathname.endsWith("/token")) {
      tokenLoads++;
      if (tokenHandler) return tokenHandler();
      return Response.json({ accessToken: `provider-${tokenLoads}`, expiresAt: new Date(now + 3_600_000).toISOString() });
    }
    if (url.pathname.endsWith("/disconnect")) return Response.json({ ok: true });
    return providerRejects && token === rejectedToken ? Response.json({}, { status: 401 }) : Response.json({ ok: true });
  }, { preconnect: nativeFetch.preconnect });
});
afterEach(async () => {
  globalThis.fetch = nativeFetch;
  clock?.mockRestore();
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(directory, { recursive: true, force: true });
});
const request = () => createConnectorRequest(config, "google-drive", connection.id);
const providerCalls = () => calls.filter(call => call.path === "/drive/v3/files");
const statuses = () => calls.filter(call => call.path.endsWith("/status")).length;

test("separate operations reuse a valid token while authorization renews every thirty seconds", async () => {
  const first = await request();
  await first("/drive/v3/files");
  await (await request())("/drive/v3/files");
  expect(tokenLoads).toBe(1); expect(statuses()).toBe(1);
  now += 30_001;
  await first("/drive/v3/files");
  expect(tokenLoads).toBe(1); expect(statuses()).toBe(2);
  now += 3_510_000;
  await (await request())("/drive/v3/files");
  expect(tokenLoads).toBe(2);
});

test("concurrent folder operations share status and token retrieval", async () => {
  await Promise.all(Array.from({ length: 5 }, async () => (await request())("/drive/v3/files")));
  expect(tokenLoads).toBe(1); expect(statuses()).toBe(1); expect(providerCalls()).toHaveLength(5);
});

test("writes force cloud authorization despite a cached read lease, and long writes renew it", async () => {
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  const first = await request();
  await first("/drive/v3/files");
  await first("/drive/v3/files", { method: "POST", body: { name: "new" } });
  expect(statuses()).toBe(2);
  await first("/drive/v3/files", { method: "PATCH", body: {} });
  expect(statuses()).toBe(2);
  now += 30_001;
  await first("/drive/v3/files", { method: "DELETE" });
  expect(statuses()).toBe(3);
  await (await request())("/drive/v3/files", { method: "POST", body: {} });
  expect(statuses()).toBe(4); expect(tokenLoads).toBe(1);
});

test("cloud revocation blocks writes immediately and reads when the lease expires", async () => {
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  const first = await request();
  await first("/drive/v3/files");
  statusAllowed = false;
  await expect(first("/drive/v3/files", { method: "DELETE" })).rejects.toMatchObject({ code: "connector_access_denied" });
  now += 30_001;
  await expect(request()).rejects.toMatchObject({ code: "connector_access_denied" });
  expect(providerCalls()).toHaveLength(1);
});

test("a local write-permission change invalidates old requests and cached credentials", async () => {
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  const first = await request();
  await first("/drive/v3/files");
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: false });
  await expect(first("/drive/v3/files", { method: "DELETE" })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await (await request())("/drive/v3/files");
  expect(tokenLoads).toBe(2); expect(providerCalls().every(call => call.method === "GET")).toBe(true);
});

test("a rejected provider token refreshes once and the refreshed token is reused", async () => {
  providerRejects = true;
  await (await request())("/drive/v3/files");
  await (await request())("/drive/v3/files");
  expect(tokenLoads).toBe(2);
  expect(providerCalls().map(call => call.token)).toEqual(["Bearer provider-1", "Bearer provider-2", "Bearer provider-2"]);
});

test("a long-lived request can refresh again when its replacement token is later rejected", async () => {
  providerRejects = true;
  const first = await request();
  await first("/drive/v3/files");
  rejectedToken = "Bearer provider-2";
  await first("/drive/v3/files");
  expect(tokenLoads).toBe(3);
  expect(providerCalls().map(call => call.token)).toEqual(["Bearer provider-1", "Bearer provider-2", "Bearer provider-2", "Bearer provider-3"]);
});

test("disconnect rejects a delayed token response and prevents any provider request", async () => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  tokenHandler = () => { started.resolve(); return response.promise; };
  const pending = request().then(value => ({ value }), (error: unknown) => ({ error }));
  await started.promise;
  await disconnectConnector(config, "google-drive", connection.id);
  response.resolve(Response.json({ accessToken: "late-secret", expiresAt: new Date(now + 3_600_000).toISOString() }));
  expect(await pending).toMatchObject({ error: { code: "connector_account_changed" } });
  await expect(request()).rejects.toMatchObject({ code: "connector_not_connected" });
  expect(providerCalls()).toHaveLength(0);
});

test("signing out and back into the same account cannot revive an old request or token", async () => {
  const first = await request();
  await first("/drive/v3/files");
  await writeEigenweltConnection(config, { account: null, platformToken: null });
  await expect(first("/drive/v3/files")).rejects.toMatchObject({ code: "connector_account_changed" });
  await writeEigenweltConnection(config, { account, platformToken: "new-platform-session" });
  await expect(first("/drive/v3/files")).rejects.toMatchObject({ code: "connector_account_changed" });
  await (await request())("/drive/v3/files");
  expect(tokenLoads).toBe(2);
});

test("a delayed token cannot survive sign-out and a new sign-in by the same user", async () => {
  const started = Promise.withResolvers<void>(), response = Promise.withResolvers<Response>();
  tokenHandler = () => { started.resolve(); return response.promise; };
  const pending = request().then(value => ({ value }), (error: unknown) => ({ error }));
  await started.promise;
  await writeEigenweltConnection(config, { account: null, platformToken: null });
  await writeEigenweltConnection(config, { account, platformToken: "new-session" });
  tokenHandler = undefined;
  response.resolve(Response.json({ accessToken: "old-session-token", expiresAt: new Date(now + 3_600_000).toISOString() }));
  expect(await pending).toMatchObject({ error: { code: "connector_account_changed" } });
  await (await request())("/drive/v3/files");
  expect(providerCalls().map(call => call.token)).toEqual(["Bearer provider-2"]);
});

test("switching organization and user never reuses another tenant's credential", async () => {
  const first = await request();
  await first("/drive/v3/files");
  const bob = { ...account, userId: "bob", orgId: "another-firm" };
  await writeEigenweltConnection(config, { account: bob, platformToken: "bob-session" });
  brokerConnection = { ...connection, nangoConnectionId: "bob-grant" };
  await writeConnectorConnections(config, JSON.stringify(["https://credential-broker.test", bob.orgId, bob.userId]), "google-drive", [brokerConnection]);
  await expect(first("/drive/v3/files")).rejects.toMatchObject({ code: "connector_account_changed" });
  await (await request())("/drive/v3/files");
  expect(providerCalls().map(call => call.token)).toEqual(["Bearer provider-1", "Bearer provider-2"]);
});

test("broker outages stop access when the authorization lease expires despite a valid token", async () => {
  const first = await request();
  await first("/drive/v3/files");
  statusUnavailable = true;
  now += 30_001;
  await expect(first("/drive/v3/files")).rejects.toMatchObject({ code: "connectors_not_configured" });
  expect(providerCalls()).toHaveLength(1); expect(tokenLoads).toBe(1);
});
