import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { readConnectorConnections, writeConnectorConnections } from "./store.js";
import { oauthVaultPath } from "../file-storage/oauth/vault.js";
import { connectorAccessToken, listConnectorConnections, savedConnectorConnections, setConnectorActivation } from "./broker.js";
import { createConnectorRequest } from "./request.js";
import { connectorSettings, recordConnectorActivation, saveConnectorWriteSetting } from "./settings.js";
import { connectorCloudAccess, saveConnectorCloudAccess, synchronizeConnectorBindings, startConnectorSync } from "./sync.js";

type Policy = { active: boolean; cloudEnabled: boolean; writeAccess: boolean };
type Binding = { id: string; provider: string; revision: number; deleted: boolean; cleanupPending?: boolean; createdAt: string; policies: Record<string, Policy> };
const platform = "https://connector-sync.test";
const owner = JSON.stringify([platform, "org_alice", "alice"]);
const nativeFetch = globalThis.fetch;
const savedEnv = new Map<string, string | undefined>();
let root: string;
let desktop: ServerConfig;
let worker: ServerConfig;
let bindings: Binding[];
let requests: { path: string; body: unknown; token: string | null }[];
let registryError = false;
let beforeRegistry: (() => Promise<void>) | undefined;
let stops: (() => void)[];
function config(name: string, role: "companion" | "executor"): ServerConfig {
  const value: ServerConfig = { host: "127.0.0.1", port: 0, token: "local", hostToken: "host", configPath: join(root, name, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    cloudSync: { role, canExecute: () => true, prepareWorkspace: async () => {}, shouldSyncFiles: () => true, deviceName: name } };
  stops.push(startConnectorSync(value));
  return value;
}
async function login(target: ServerConfig, userId = "alice") {
  await writeEigenweltConnection(target, { platformURL: platform, platformToken: `api-${userId}`,
    account: { userId, orgId: `org_${userId}`, orgName: "Test org", userName: null, userEmail: null } });
}
async function seed(id = "gmail", handle = "desktop-account", ref = "private-nango-reference") {
  await writeConnectorConnections(desktop, owner, id, [{ id: handle, nangoConnectionId: ref, createdAt: null, needsReconnect: false }]);
}
beforeEach(async () => {
  for (const key of ["LEGALWORK_RUNTIME_DB", "LEGALWORK_STORAGE_STORE", "EIGENWELT_PLATFORM_URL"]) {
    savedEnv.set(key, process.env[key]); delete process.env[key];
  }
  process.env.EIGENWELT_PLATFORM_URL = platform;
  root = await mkdtemp(join(tmpdir(), "connector-cloud-sync-"));
  stops = [];
  desktop = config("desktop", "companion"); worker = config("worker", "executor");
  await login(desktop); await login(worker);
  bindings = []; requests = []; registryError = false; beforeRegistry = undefined;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    const token = new Headers(init?.headers).get("Authorization");
    requests.push({ path: url.pathname, body, token });
    if (url.origin === platform) {
      if (url.pathname === "/api/connectors/bindings") {
        await beforeRegistry?.();
        return registryError ? Response.json({}, { status: 503 }) : Response.json({ bindings: token === "Bearer api-alice" ? bindings : [] });
      }
      if (url.pathname === "/api/connectors/bindings/adopt") {
        const value = z.object({ connectorId: z.string(), connectionId: z.string(), active: z.boolean(), cloudEnabled: z.boolean(), activeConnectorIds: z.array(z.string()).optional() }).parse(body);
        const provider = value.connectorId === "outlook-calendar" ? "outlook" : value.connectorId;
        let binding = bindings.find(item => item.provider === provider);
        if (binding?.deleted) return Response.json({}, { status: 409 });
        if (!binding) {
          binding = { id: randomUUID(), provider, revision: 1, deleted: false, createdAt: "2026-10-19T00:00:00Z",
            policies: Object.fromEntries((provider === "outlook" ? ["outlook", "outlook-calendar"] : [provider]).map(id => [id,
              { active: value.activeConnectorIds?.includes(id) ?? (id === value.connectorId && value.active),
                cloudEnabled: (value.activeConnectorIds?.includes(id) ?? (id === value.connectorId && value.active)) && value.cloudEnabled, writeAccess: false }])) };
          bindings.push(binding);
        }
        return Response.json({ binding });
      }
      if (url.pathname === "/api/connectors/bindings/policy") {
        const value = z.object({ bindingId: z.string(), connectorId: z.string(), expectedRevision: z.number(),
          policy: z.object({ active: z.boolean(), cloudEnabled: z.boolean(), writeAccess: z.boolean() }) }).parse(body);
        const binding = bindings.find(item => item.id === value.bindingId);
        if (!binding || binding.revision !== value.expectedRevision) return Response.json({}, { status: 409 });
        binding.policies[value.connectorId] = value.policy; binding.revision++;
        return Response.json({ binding });
      }
      if (url.pathname === "/api/connectors/bindings/disconnect") {
        const value = z.object({ bindingId: z.string() }).parse(body);
        const binding = bindings.find(item => item.id === value.bindingId);
        if (!binding) return Response.json({}, { status: 404 });
        binding.cleanupPending = false; return Response.json({ disconnected: true });
      }
      if (url.pathname === "/api/connectors/bindings/token" || url.pathname === "/api/connectors/bindings/status") {
        const value = z.object({ bindingId: z.string(), connectorId: z.string() }).parse(body);
        const binding = bindings.find(item => item.id === value.bindingId && !item.deleted);
        if (!binding?.policies[value.connectorId]?.cloudEnabled || !binding.policies[value.connectorId].active) return Response.json({}, { status: 403 });
        return url.pathname.endsWith("/token") ? Response.json({ accessToken: "provider-token", expiresAt: null })
          : Response.json({ connection: { id: binding.id, createdAt: binding.createdAt, needsReconnect: false } });
      }
    }
    if (url.origin === "https://gmail.googleapis.com") return Response.json({ emailAddress: "alice@example.test" });
    throw new Error(`Unexpected request ${url.origin}${url.pathname}`);
  }, { preconnect: nativeFetch.preconnect });
});
afterEach(async () => {
  for (const stop of stops) stop();
  globalThis.fetch = nativeFetch;
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});

test("desktop adoption preserves its handle, then a fresh VM discovers Gmail without any private Nango reference", async () => {
  await seed(); await saveConnectorWriteSetting(desktop, "gmail", { writeAccess: true });
  await synchronizeConnectorBindings(desktop, { publish: true });
  const original = await readConnectorConnections(desktop, owner, "gmail");
  expect(original[0].id).toBe("desktop-account"); expect(original[0].bindingId).toBe(bindings[0].id);
  const readsBefore = requests.length;
  await synchronizeConnectorBindings(worker);
  expect(requests.slice(readsBefore).map(item => item.path)).toEqual(["/api/connectors/bindings"]);
  const restored = await readConnectorConnections(worker, owner, "gmail");
  expect(restored).toHaveLength(1); expect(restored[0].bindingId).toBe(bindings[0].id); expect(restored[0].nangoConnectionId).toBeUndefined();
  expect((await connectorSettings(worker)).writeAccess.gmail).toBe(false);
  const request = await createConnectorRequest(worker, "gmail");
  expect(await request("/gmail/v1/users/me/profile")).toEqual({ emailAddress: "alice@example.test" });
  const tokenRequests = requests.filter(item => item.path.endsWith("/token"));
  expect(tokenRequests).toHaveLength(1); expect(tokenRequests[0].body).toEqual({ bindingId: bindings[0].id, connectorId: "gmail", forceRefresh: false });
  expect((await readFile(oauthVaultPath(worker))).includes(Buffer.from("private-nango-reference"))).toBe(false);
  await expect(request("/gmail/v1/users/me/drafts", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_writes_disabled" });
});
test("cloud disable stops an already prepared provider request, survives resume and preserves desktop credentials", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true }); await synchronizeConnectorBindings(worker);
  const request = await createConnectorRequest(worker, "gmail");
  expect((await saveConnectorCloudAccess(desktop, "gmail", { enabled: false })).enabled).toBe(false);
  const providerCount = requests.filter(item => item.path === "/gmail/v1/users/me/profile").length;
  await expect(request("/gmail/v1/users/me/profile")).rejects.toMatchObject({ code: "connector_account_changed" });
  expect(requests.filter(item => item.path === "/gmail/v1/users/me/profile")).toHaveLength(providerCount);
  const resumed = config("worker", "executor"); await synchronizeConnectorBindings(resumed);
  expect(await savedConnectorConnections(resumed, "gmail")).toEqual([]);
  expect((await readConnectorConnections(desktop, owner, "gmail"))[0].nangoConnectionId).toBe("private-nango-reference");
  await synchronizeConnectorBindings(desktop, { publish: true, force: true });
  expect(bindings[0].policies.gmail.cloudEnabled).toBe(false);
});
test("Outlook mail/calendar retain independent activation and cloud permissions", async () => {
  await seed("outlook"); await recordConnectorActivation(desktop, "outlook-calendar", "desktop-account", true);
  await synchronizeConnectorBindings(desktop, { publish: true }); await synchronizeConnectorBindings(worker);
  expect(await savedConnectorConnections(worker, "outlook")).toEqual([]);
  expect(await savedConnectorConnections(worker, "outlook-calendar")).toHaveLength(1);
  expect((await connectorSettings(worker)).activeAccounts).toEqual({ "outlook-calendar": bindings[0].id });
  await setConnectorActivation(desktop, "outlook-calendar", "desktop-account", false);
  await synchronizeConnectorBindings(worker, { force: true });
  expect(await savedConnectorConnections(worker, "outlook-calendar")).toEqual([]);
});
test("a fresh desktop imports the shared Outlook handle and activation without inheriting write access", async () => {
  await seed("outlook"); await recordConnectorActivation(desktop, "outlook-calendar", "desktop-account", true);
  await synchronizeConnectorBindings(desktop, { publish: true });
  const fresh = config("fresh-desktop", "companion"); await login(fresh);
  await synchronizeConnectorBindings(fresh);
  const restored = await readConnectorConnections(fresh, owner, "outlook");
  expect(restored).toHaveLength(1); expect(restored[0].id).toBe(bindings[0].id);
  expect((await connectorSettings(fresh)).activeAccounts).toEqual({ "outlook-calendar": bindings[0].id });
  expect((await connectorSettings(fresh)).writeAccess["outlook-calendar"]).toBe(false);
});
test("registry reads coalesce and do not repeat for every tool or settings read", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true });
  requests.length = 0;
  await Promise.all(Array.from({ length: 12 }, () => synchronizeConnectorBindings(worker)));
  await savedConnectorConnections(worker, "gmail"); await connectorSettings(worker); await savedConnectorConnections(worker, "google-calendar");
  expect(requests.map(item => item.path)).toEqual(["/api/connectors/bindings"]);
});
test("a disconnected binding removes cached handles and cannot be adopted by a stale desktop", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true }); await synchronizeConnectorBindings(worker);
  bindings[0].deleted = true; bindings[0].revision++;
  await synchronizeConnectorBindings(worker, { force: true }); await synchronizeConnectorBindings(desktop, { force: true });
  expect(await readConnectorConnections(worker, owner, "gmail")).toEqual([]);
  expect(await readConnectorConnections(desktop, owner, "gmail")).toEqual([]);
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true });
  expect(bindings[0].deleted).toBe(true); expect(await savedConnectorConnections(worker, "gmail")).toEqual([]);
});
test("desktop sync retries pending provider deletion while the VM keeps the connection disabled", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true }); await synchronizeConnectorBindings(worker);
  bindings[0].deleted = true; bindings[0].cleanupPending = true; bindings[0].revision++;
  await synchronizeConnectorBindings(worker, { force: true });
  expect(bindings[0].cleanupPending).toBe(true);
  expect(await savedConnectorConnections(worker, "gmail")).toEqual([]);
  await synchronizeConnectorBindings(desktop, { force: true });
  expect(bindings[0].cleanupPending).toBe(false);
  expect(requests.filter(item => item.path === "/api/connectors/bindings/disconnect")).toHaveLength(1);
});
test("switching accounts hides all previous connections and rejects an in-flight old-owner registry response", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true });
  let release: (() => void) | undefined; let reached = false;
  beforeRegistry = async () => { reached = true; await new Promise<void>(resolve => { release = resolve; }); };
  const pending = synchronizeConnectorBindings(worker);
  while (!reached) await new Promise(resolve => setTimeout(resolve, 1));
  await login(worker, "bob"); beforeRegistry = undefined; release?.();
  await expect(pending).rejects.toMatchObject({ code: "connector_account_changed" });
  expect(await savedConnectorConnections(worker, "gmail")).toEqual([]);
  expect((await connectorSettings(worker)).writeAccess.gmail).toBe(false);
  await login(worker); await synchronizeConnectorBindings(worker, { force: true });
  expect(await savedConnectorConnections(worker, "gmail")).toHaveLength(1);
});
test("cloud provider requests fail closed during a registry outage, including a reused request object", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true }); await synchronizeConnectorBindings(worker);
  const request = await createConnectorRequest(worker, "gmail"); registryError = true;
  await expect(request("/gmail/v1/users/me/profile")).rejects.toMatchObject({ code: "connectors_not_configured" });
  await expect(request("/gmail/v1/users/me/profile")).rejects.toMatchObject({ code: "connectors_not_configured" });
  expect(requests.filter(item => item.path === "/gmail/v1/users/me/profile")).toHaveLength(0);
});
test("cloud settings do not grant access to a different local account or allow the worker to change grants", async () => {
  await seed(); await synchronizeConnectorBindings(desktop, { publish: true });
  const secondDesktop = config("second-desktop", "companion"); await login(secondDesktop);
  await writeConnectorConnections(secondDesktop, owner, "gmail", [{ id: "other-handle", nangoConnectionId: "other-reference", createdAt: null, needsReconnect: false }]);
  // Model a registration conflict: the account registry refers to the first connection.
  delete secondDesktop.cloudSync;
  expect((await connectorCloudAccess(secondDesktop, "gmail")).available).toBe(false);
  await expect(saveConnectorCloudAccess(worker, "gmail", { enabled: true })).rejects.toMatchObject({ code: "connector_desktop_required" });
  await expect(connectorAccessToken(worker, "gmail", "other-handle")).rejects.toMatchObject({ code: "connector_not_connected" });
});
