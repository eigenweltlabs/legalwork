import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { closeEigenweltConnectionForTests, readEigenweltConnection, readEigenweltEntitlementsView, writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { eigenweltConnectionPlatformUrl } from "./eigenwelt-endpoints.js";
import { ensureFreshPlatformToken, revokeEigenweltConnection } from "./eigenwelt-refresh.js";
import { readCachedEigenweltPaidManifest, writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { bootstrapRuntimeOpencodeConfig, closeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { saveSandboxDefault, syncSandboxSettings, sandboxSyncStatus } from "./agent-sandbox/sync.js";
import { prepareConnectorStorage, writeConnectorConnections } from "./connectors/store.js";
import { listConnectorConnections, savedConnectorConnections } from "./connectors/broker.js";

const shared = "https://platform.eigenweltlabs.com";
const originalURL = process.env.EIGENWELT_PLATFORM_URL;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (originalURL === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = originalURL;
});

function accessToken(overrides: Record<string, unknown> = {}) {
  const claims = { iss: "eigenwelt-platform", aud: "legalwork-desktop", sub: "user_fixture", org: "org_fixture",
    deploymentRegion: "eu", deploymentRoutingVersion: 1, ...overrides };
  return `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
}

async function fixture(platformURL: string | null = shared) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-regional-refresh-"));
  const config = backOfficeTestConfig(root);
  cleanups.push(async () => { await closeEigenweltConnectionForTests(config); await rm(root, { recursive: true, force: true }); });
  delete process.env.EIGENWELT_PLATFORM_URL;
  await writeEigenweltConnection(config, { platformURL, platformToken: "old-access", refreshToken: "old-refresh", accessTokenExpiresAt: 1,
    account: { userId: "user_fixture", orgId: "org_fixture", orgName: "Fixture firm", userName: null, userEmail: null } });
  return config;
}

function mockNetwork(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    return handler(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init);
  }, { preconnect: globalThis.fetch.preconnect }));
  cleanups.push(() => mock.mockRestore());
}

test.each(["eu", "us"])("upgrades an existing shared login to %s, keeps its paid key and persists across reopen", async region => {
  const config = await fixture();
  const regional = `https://${region}.platform.eigenweltlabs.com`;
  const token = accessToken({ deploymentRegion: region });
  await writeCachedEigenweltPaidManifest(config, { baseURL: `${shared}/v1`, apiKey: "fixture-paid-key", models: [] });
  const calls: string[] = [];
  let rotations = 0;
  mockNetwork((url, init) => {
    calls.push(url);
    expect(init?.redirect).toBe("error");
    if (url.endsWith("/api/desktop/revoke")) return new Response(null, { status: 204 });
    if (url.endsWith("/api/desktop/refresh")) {
      expect(url).toBe(`${rotations ? regional : shared}/api/desktop/refresh`);
      rotations++;
      // The deployed legacy wrapper strips placement fields and rewrites this
      // optional URL. Only the fresh token retains the authoritative placement.
      return Response.json({ platformToken: token, refreshToken: `rotated-${rotations}`, accessTokenExpiresAt: Date.now() + 900_000,
        platformURL: rotations === 1 ? shared : regional });
    }
    expect(url).toBe(`${regional}/api/desktop/models`);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    return Response.json({ baseURL: `${regional}/v1`, models: [{ id: "fixture-model" }] });
  });
  expect(await ensureFreshPlatformToken(config)).toBe(token);
  expect((await readEigenweltEntitlementsView(config)).platformURL).toBe(regional);
  expect(await readCachedEigenweltPaidManifest(config)).toMatchObject({ baseURL: `${regional}/v1`, apiKey: "fixture-paid-key" });
  await closeEigenweltConnectionForTests(config);
  expect(eigenweltConnectionPlatformUrl(await readEigenweltConnection(config))).toBe(regional);
  expect(await ensureFreshPlatformToken(config, { force: true })).toBe(token);
  const saved = await readEigenweltConnection(config);
  expect(saved.platformURL).toBe(shared); // Local data retains its account identity.
  expect(saved.regionalPlatformURL).toBe(regional);
  expect(calls).toEqual([`${shared}/api/desktop/refresh`, `${regional}/api/desktop/models`, `${regional}/api/desktop/refresh`]);
  await revokeEigenweltConnection(config);
  expect((await readEigenweltConnection(config)).regionalPlatformURL).toBeNull();
});

test("a legacy null origin upgrades, but an older app's account rewrite cannot inherit its route", async () => {
  const config = await fixture(null);
  mockNetwork(url => {
    expect(url).toBe(`${shared}/api/desktop/refresh`);
    return Response.json({ platformToken: accessToken(), refreshToken: "rotated", accessTokenExpiresAt: Date.now() + 900_000 });
  });
  await ensureFreshPlatformToken(config);
  expect((await readEigenweltConnection(config)).platformURL).toBe(shared);
  expect(eigenweltConnectionPlatformUrl(await readEigenweltConnection(config))).toBe("https://eu.platform.eigenweltlabs.com");
  await closeEigenweltConnectionForTests(config);
  if (!config.configPath) throw new Error("fixture path missing");
  const sqlite = new Database(join(dirname(config.configPath), "runtime.sqlite"));
  try {
    sqlite.run("UPDATE eigenwelt_connections SET account_json=?", [JSON.stringify({ userId: "other-user", orgId: "other-org" })]);
  } finally { sqlite.close(); }
  expect((await readEigenweltConnection(config)).regionalPlatformURL).toBeNull();
});

test.each([
  { deploymentRegion: undefined }, { deploymentRegion: "ap" }, { deploymentRoutingVersion: 2 }, { org: "other-org" },
  { sub: "other-user" }, { iss: "foreign-platform" }, { aud: "another-app" },
])("keeps compatibility routing when placement is missing or mismatches: %j", async overrides => {
  const config = await fixture();
  mockNetwork(() => Response.json({ platformToken: accessToken(overrides), refreshToken: "rotated", accessTokenExpiresAt: Date.now() + 900_000 }));
  await ensureFreshPlatformToken(config);
  expect(eigenweltConnectionPlatformUrl(await readEigenweltConnection(config))).toBe(shared);
  expect((await readEigenweltConnection(config)).refreshToken).toBe("rotated");
});

test("a regional outage preserves the upgraded account and never retries another region or shared", async () => {
  const config = await fixture();
  let calls = 0;
  mockNetwork(url => {
    calls++;
    expect(url).toBe(`${calls === 1 ? shared : "https://eu.platform.eigenweltlabs.com"}/api/desktop/refresh`);
    return calls === 1 ? Response.json({ platformToken: accessToken(), refreshToken: "rotated", accessTokenExpiresAt: Date.now() + 900_000 })
      : new Response(null, { status: 503 });
  });
  await ensureFreshPlatformToken(config);
  await ensureFreshPlatformToken(config, { force: true });
  expect(calls).toBe(2);
  expect(await readEigenweltConnection(config)).toMatchObject({ refreshToken: "rotated", regionalPlatformURL: "https://eu.platform.eigenweltlabs.com", refreshError: "http_503" });
});

test("queued sandbox preferences upload to the regional endpoint under the same account", async () => {
  const config = await fixture();
  await bootstrapRuntimeOpencodeConfig(config);
  cleanups.push(() => closeRuntimeOpencodeConfig(config));
  await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active", features: ["settings_presets"] }) });
  await saveSandboxDefault(config, { enabled: true, networkMode: "block" });
  const calls: string[] = [];
  mockNetwork((url, init) => {
    calls.push(url);
    if (url === `${shared}/api/desktop/refresh`) return Response.json({ platformToken: accessToken(), refreshToken: "rotated", accessTokenExpiresAt: Date.now() + 900_000 });
    expect(url).toBe("https://eu.platform.eigenweltlabs.com/api/desktop/settings");
    if (init?.method === "PUT") {
      expect(JSON.parse(String(init.body))).toEqual({ revision: 0, sandbox: { enabled: true, networkMode: "block" } });
      return Response.json({ revision: 1, sandbox: { enabled: true, networkMode: "block" } });
    }
    return Response.json({ revision: 0, sandbox: { enabled: false, networkMode: "allow" } });
  });
  await syncSandboxSettings(config);
  expect(sandboxSyncStatus(config)).toBe("synced");
  expect(calls).toEqual([`${shared}/api/desktop/refresh`, "https://eu.platform.eigenweltlabs.com/api/desktop/settings", "https://eu.platform.eigenweltlabs.com/api/desktop/settings"]);
});

test("a response arriving after another sign-in cannot install its old region", async () => {
  const config = await fixture();
  let release: () => void = () => { throw new Error("request not started"); };
  let started: () => void = () => {};
  const received = new Promise<void>(resolve => { started = resolve; });
  mockNetwork(() => new Promise<Response>(resolve => {
    release = () => resolve(Response.json({ platformToken: accessToken(), refreshToken: "old-rotated", accessTokenExpiresAt: Date.now() + 900_000 }));
    started();
  }));
  const pending = ensureFreshPlatformToken(config);
  await received;
  await writeEigenweltConnection(config, { platformURL: "https://us.platform.eigenweltlabs.com", platformToken: "new-access", refreshToken: "new-refresh" });
  release(); await pending;
  expect(await readEigenweltConnection(config)).toMatchObject({ platformURL: "https://us.platform.eigenweltlabs.com", regionalPlatformURL: null, refreshToken: "new-refresh" });
});

test("saved connector grants survive an upgrade during a rejected broker request", async () => {
  const config = await fixture();
  await bootstrapRuntimeOpencodeConfig(config);
  cleanups.push(() => closeRuntimeOpencodeConfig(config));
  await prepareConnectorStorage(config);
  await writeEigenweltConnection(config, { accessTokenExpiresAt: Date.now() + 900_000 });
  const connection = { id: "local-drive", nangoConnectionId: "fixture-private-grant", createdAt: "2026-11-01T00:00:00Z", needsReconnect: false };
  await writeConnectorConnections(config, JSON.stringify([shared, "org_fixture", "user_fixture"]), "google-drive", [connection]);
  const calls: string[] = [];
  mockNetwork((url, init) => {
    calls.push(url);
    if (url === `${shared}/api/desktop/refresh`) return Response.json({ platformToken: accessToken(), refreshToken: "rotated", accessTokenExpiresAt: Date.now() + 900_000 });
    if (url === `${shared}/api/connectors/google-drive/connection/status`) return new Response(null, { status: 401 });
    expect(url).toBe("https://eu.platform.eigenweltlabs.com/api/connectors/google-drive/connection/status");
    expect(JSON.parse(String(init?.body))).toEqual({ connectionId: connection.nangoConnectionId });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken()}`);
    return Response.json({ connection: { ...connection, id: connection.nangoConnectionId } });
  });
  expect(await listConnectorConnections(config, "google-drive")).toMatchObject([{ id: connection.id, needsReconnect: false }]);
  expect(await savedConnectorConnections(config, "google-drive")).toMatchObject([{ id: connection.id }]);
  expect(calls).toEqual([`${shared}/api/connectors/google-drive/connection/status`, `${shared}/api/desktop/refresh`, "https://eu.platform.eigenweltlabs.com/api/connectors/google-drive/connection/status"]);
});
