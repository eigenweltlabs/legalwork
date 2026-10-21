import { closeTestRuntime, removeTestDirectory } from "../runtime.test-helpers.js";
import { z } from "zod";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorDefinitions, connectorOAuthClientInputSchema } from "@legalwork/types/connectors";
import type { ServerConfig } from "../types.js";
import { connectorStatus, createConnectorFlows, connectorAccessToken, disconnectConnector, setConnectorActivation } from "./broker.js";
import { localOAuthClient, saveLocalOAuthClient, removeLocalOAuthClient, localOAuthConnections, requireLocalOAuthSendAccess } from "./local-oauth.js";
import { connectorOAuthProvider } from "./oauth-providers.js";
import { connectorSettings, connectorSettingsPath, saveConnectorWriteSetting } from "./settings.js";
import { callConnectorExtensionAction, CONNECTOR_EXTENSION_ACTIONS } from "./index.js";
import { createConnectorRequest } from "./request.js";
import { OAuthVault, oauthVaultPath } from "../file-storage/oauth/vault.js";
import { startServer } from "../server.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { writeConnectorConnections } from "./store.js";

const nativeFetch = globalThis.fetch;
const priorEnvironment = new Map(["EIGENWELT_PLATFORM_URL", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE", "LEGALWORK_STORAGE_STORE"].map((key) => [key, process.env[key]]));
let root: string;
let config: ServerConfig;
let requests: { url: URL; fields?: URLSearchParams; headers: Headers; method: string }[];
let respond: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const cancellations: (() => Promise<unknown>)[] = [];
const secret = "private-test-client-secret";
const access = "private-test-access-token";
const refresh = "private-test-refresh-token";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "connector-own-oauth-"));
  process.env.EIGENWELT_PLATFORM_URL = "https://broker.test";
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  delete process.env.LEGALWORK_STORAGE_STORE;
  config = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  requests = [];
  respond = (url) => url.pathname.endsWith("/token")
    ? Response.json({ access_token: access, refresh_token: refresh, expires_in: 3600 })
    : Response.json({ emailAddress: "local@example.com", id: "drive", value: [] });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return nativeFetch(input, init);
    requests.push({ url, fields: init?.body instanceof URLSearchParams ? init.body : undefined, headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    if (url.hostname === "broker.test" || url.hostname.includes("nango")) throw new Error("Custom OAuth must not contact the broker or Nango");
    return respond(url, init);
  }, { preconnect: nativeFetch.preconnect });
});

afterEach(async () => {
  while (cancellations.length) await cancellations.pop()?.();
  globalThis.fetch = nativeFetch;
  await closeTestRuntime(config);
  for (const [key, value] of priorEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await removeTestDirectory(root);
});

async function start(id = "gmail", connectionId?: string) {
  const flows = createConnectorFlows(config);
  const flow = await flows.start(id, connectionId, "custom");
  cancellations.push(async () => flows.cancel(flow.flowId));
  return { flows, flow, authorization: new URL(flow.connectUrl) };
}
async function callback(authorization: URL, state = authorization.searchParams.get("state")!) {
  const url = new URL(authorization.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({ state, code: "authorization-code" }).toString();
  return nativeFetch(url);
}
async function connected(id = "gmail") {
  const started = await start(id);
  expect((await callback(started.authorization)).status).toBe(200);
  const status = await started.flows.status(started.flow.flowId);
  expect(status.status).toBe("connected");
  if (!status.connection) throw new Error("Expected a connected fixture account");
  return { ...started, connection: status.connection };
}

test("signed-out Gmail uses PKCE and the encrypted vault without Nango or Eigenwelt", async () => {
  const details = await saveLocalOAuthClient(config, "gmail", { clientId: "desktop-client", clientSecret: secret });
  expect(details.configured).toBe(true);
  expect(details.hasClientSecret).toBe(true);
  expect(JSON.stringify(details)).not.toContain(secret);
  const started = await start();
  expect(started.authorization.origin).toBe("https://accounts.google.com");
  expect(started.authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(started.authorization.searchParams.has("client_secret")).toBe(false);
  expect((await callback(started.authorization, "wrong-state")).status).toBe(400);
  expect(requests).toHaveLength(0);
  expect((await callback(started.authorization)).status).toBe(200);
  expect(requests[0].fields?.get("code_verifier")?.length).toBeGreaterThan(42);
  expect(requests[0].fields?.get("client_secret")).toBe(secret);
  const activated = await started.flows.status(started.flow.flowId);
  expect(activated.connection?.source).toBe("custom");
  expect(activated.connection).not.toHaveProperty("accessToken");
  const status = await connectorStatus(config, "gmail");
  expect(status.requiresSignIn).toBe(true); // Managed sign-in still requires an Eigenwelt account.
  expect(status.connectors[0].customConfigured).toBe(true);
  expect(status.connectors[0].connections).toHaveLength(1);
  for (const value of [secret, access, refresh]) {
    expect(JSON.stringify(status)).not.toContain(value);
    expect((await readFile(oauthVaultPath(config))).includes(Buffer.from(value))).toBe(false);
  }
  const reloaded = { ...config };
  const connection = status.connectors[0].connections[0];
  expect(await connectorAccessToken(reloaded, "gmail", connection.id)).toBe(access);
  const request = await createConnectorRequest(reloaded, "gmail", connection.id);
  await request("/gmail/v1/users/me/profile");
  expect(requests.at(-1)?.url.hostname).toBe("gmail.googleapis.com");
  expect(requests.at(-1)?.headers.get("Authorization")).toBe(`Bearer ${access}`);
  expect(requests.every((item) => ["oauth2.googleapis.com", "gmail.googleapis.com"].includes(item.url.hostname))).toBe(true);
});

test("a direct account prevents a second connection through either method and can be replaced after disconnect", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const original = await connected();
  const requestsBefore = requests.length;
  for (const method of ["custom", "nango"]) {
    const flows = createConnectorFlows(config);
    await expect(flows.start("gmail", undefined, method === "custom" ? "custom" : "nango")).rejects.toMatchObject({ code: "connector_already_connected" });
  }
  expect(requests).toHaveLength(requestsBefore);
  expect(await localOAuthConnections(config, "gmail")).toHaveLength(1);
  expect(await connectorAccessToken(config, "gmail", original.connection.id)).toBe(access);
  await disconnectConnector(config, "gmail", original.connection.id);
  const replacement = await connected();
  expect(replacement.connection.id).not.toBe(original.connection.id);
  expect(await localOAuthConnections(config, "gmail")).toHaveLength(1);
});

test("pending direct Outlook consent reserves the shared slot across methods and calendar until cancelled", async () => {
  await saveLocalOAuthClient(config, "outlook", { clientId: "client" });
  const pending = await start("outlook");
  const other = createConnectorFlows({ ...config });
  await expect(other.start("outlook-calendar", undefined, "nango")).rejects.toMatchObject({ code: "connector_connection_pending" });
  await expect(other.start("outlook-calendar", undefined, "custom")).rejects.toMatchObject({ code: "connector_connection_pending" });
  expect(requests).toHaveLength(0);
  await pending.flows.cancel(pending.flow.flowId);
  const connectedCalendar = await connected("outlook-calendar");
  expect(await localOAuthConnections(config, "outlook")).toHaveLength(1);
  expect((await connectedCalendar.flows.status(connectedCalendar.flow.flowId)).status).toBe("connected");
});

test("an account appearing during direct consent blocks activation without replacing or deleting it", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const pending = await start();
  expect((await callback(pending.authorization)).status).toBe(200);
  await writeEigenweltConnection(config, { platformToken: "platform-token", platformURL: "https://broker.test",
    account: { userId: "alice", userName: "Alice", userEmail: null, orgId: "firm", orgName: "Firm" } });
  const managed = { id: "managed-handle", nangoConnectionId: "managed-private", createdAt: null, needsReconnect: false };
  await writeConnectorConnections(config, JSON.stringify(["https://broker.test", "firm", "alice"]), "gmail", [managed]);
  await expect(pending.flows.status(pending.flow.flowId)).rejects.toMatchObject({ code: "connector_already_connected" });
  await pending.flows.cancel(pending.flow.flowId);
  expect(await localOAuthConnections(config, "gmail")).toHaveLength(0);
  expect(requests.map((item) => item.url.hostname)).toEqual(["oauth2.googleapis.com"]);
  const vault = new OAuthVault(oauthVaultPath(config));
  const saved = await vault.getEntry(JSON.stringify(["nango", JSON.stringify(["https://broker.test", "firm", "alice"]), "gmail"]), z.array(z.object({ id: z.string() })));
  expect(saved).toEqual([{ id: managed.id }]);
});

test("every Google and Microsoft connector offers a fixed provider and matching scopes", async () => {
  expect(connectorDefinitions.some((item) => item.id === "dropbox-files")).toBe(false);
  for (const definition of connectorDefinitions) {
    const details = await localOAuthClient(config, definition.id);
    expect(details.configured).toBe(false);
    expect(details.scopes.length).toBeGreaterThan(0);
    expect(details.family).toBe(definition.id.startsWith("google-") || definition.id === "gmail" ? "google" : "microsoft");
  }
  expect((await localOAuthClient(config, "outlook")).scopes).toContain("https://graph.microsoft.com/Calendars.Read");
  expect((await localOAuthClient(config, "google-drive")).scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
  expect(connectorOAuthProvider("gmail", { clientId: "client" }, []).application.scopes(true)).not.toContain("https://www.googleapis.com/auth/gmail.compose");
  expect(connectorOAuthProvider("outlook", { clientId: "client" }, []).application.scopes(true)).not.toContain("https://graph.microsoft.com/Mail.ReadWrite");
  expect(connectorOAuthClientInputSchema.safeParse({ clientId: "id", tenantId: "../attacker.test" }).success).toBe(false);
  await expect(saveLocalOAuthClient(config, "outlook", { clientId: "id", clientSecret: secret })).rejects.toMatchObject({ code: "connector_oauth_public_client" });
  expect(requests).toHaveLength(0);
});

test("an existing direct grant still permits reads after the server becomes read-only", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const result = await connected();
  config.readOnly = true;
  expect((await localOAuthConnections(config, "gmail"))[0].needsReconnect).toBe(false);
  expect(await connectorAccessToken(config, "gmail", result.connection.id)).toBe(access);
});

test("legacy mixed-method accounts block tools locally; signing out keeps the sole direct account usable", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const result = await connected();
  await writeEigenweltConnection(config, { platformToken: "platform-token", platformURL: "https://broker.test",
    account: { userId: "alice", userName: "Alice", userEmail: null, orgId: "firm", orgName: "Firm" } });
  await writeConnectorConnections(config, JSON.stringify(["https://broker.test", "firm", "alice"]), "gmail", [{ id: "managed-handle", nangoConnectionId: "managed-private", createdAt: null, needsReconnect: false }]);
  await expect(createConnectorRequest(config, "gmail", result.connection.id)).rejects.toMatchObject({ code: "connector_multiple_accounts" });
  expect(requests.every((item) => ["oauth2.googleapis.com", "gmail.googleapis.com"].includes(item.url.hostname))).toBe(true);
  // Cached Eigenwelt account metadata must not block the sole local account
  // after the platform credentials have been removed.
  await writeEigenweltConnection(config, { platformToken: null, refreshToken: null });
  const signedOut = await createConnectorRequest(config, "gmail");
  await signedOut("/gmail/v1/users/me/profile");
  expect(requests.every((item) => ["oauth2.googleapis.com", "gmail.googleapis.com"].includes(item.url.hostname))).toBe(true);
});

test("Outlook email and calendar share a local public-client connection while signed out", async () => {
  await saveLocalOAuthClient(config, "outlook-calendar", { clientId: "microsoft-desktop", tenantId: "organizations" });
  const result = await connected("outlook");
  expect(result.authorization.pathname).toBe("/organizations/oauth2/v2.0/authorize");
  expect(requests[0].fields?.has("client_secret")).toBe(false);
  expect((await localOAuthConnections(config, "outlook-calendar"))[0].id).toBe(result.connection.id);
  await expect(connectorAccessToken(config, "outlook-calendar", result.connection.id)).rejects.toMatchObject({ code: "connector_inactive" });
  await setConnectorActivation(config, "outlook-calendar", result.connection.id, true);
  expect(await connectorAccessToken(config, "outlook-calendar", result.connection.id)).toBe(access);
  await disconnectConnector(config, "outlook-calendar", result.connection.id);
  expect(await localOAuthConnections(config, "outlook")).toEqual([]);
  expect(requests.every((item) => item.url.hostname === "login.microsoftonline.com")).toBe(true);
});

test("Outlook activation is independent in either connection order, persists, and never follows write settings or old flow polls", async () => {
  for (const id of ["outlook", "outlook-calendar"]) {
    const sibling = id === "outlook" ? "outlook-calendar" : "outlook";
    await saveLocalOAuthClient(config, id, { clientId: "client" });
    const account = await connected(id);
    const initial = await connectorStatus(config);
    expect(initial.connectors.find((item) => item.id === id)?.active).toBe(true);
    expect(initial.connectors.find((item) => item.id === sibling)?.active).toBe(false);
    expect(initial.connectors.find((item) => item.id === sibling)?.connections[0].id).toBe(account.connection.id);
    const before = requests.length;
    await expect(createConnectorRequest(config, sibling)).rejects.toMatchObject({ code: "connector_inactive" });
    await expect(connectorAccessToken(config, sibling, account.connection.id)).rejects.toMatchObject({ code: "connector_inactive" });
    await saveConnectorWriteSetting(config, sibling, { writeAccess: true });
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(false);
    expect((await connectorStatus(config, id)).connectors[0].active).toBe(true);
    await setConnectorActivation(config, sibling, account.connection.id, true);
    expect(requests).toHaveLength(before); // Activation uses saved metadata, with no OAuth request.
    expect((await connectorStatus({ ...config }, sibling)).connectors[0].active).toBe(true);
    const cached = await createConnectorRequest(config, id, account.connection.id);
    await setConnectorActivation(config, id, account.connection.id, false);
    await expect(cached("/v1.0/me")).rejects.toMatchObject({ code: "connector_inactive" });
    await account.flows.status(account.flow.flowId);
    expect((await connectorStatus(config, id)).connectors[0].active).toBe(false);
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(true);
    expect(requests).toHaveLength(before);
    expect(await localOAuthConnections(config, id)).toHaveLength(1);
    await (await createConnectorRequest(config, sibling, account.connection.id))("/v1.0/me");
    await disconnectConnector(config, sibling, account.connection.id);
    expect((await connectorSettings(config)).activeAccounts).toEqual({});
    const replacement = await connected(id);
    expect(replacement.connection.id).not.toBe(account.connection.id);
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(false);
    await removeLocalOAuthClient(config, id);
    expect((await connectorSettings(config)).activeAccounts).toEqual({});
  }
});

test("Outlook activation routes validate local ownership and read-only mode without contacting an OAuth service", async () => {
  await saveLocalOAuthClient(config, "outlook", { clientId: "client" });
  const account = await connected("outlook");
  const server = await startServer(config);
  cancellations.push(async () => server.stop());
  const base = `http://127.0.0.1:${server.port}/connectors`;
  const path = `${base}/outlook-calendar/activation`;
  const headers = { "X-LegalWork-Host-Token": "host", "Content-Type": "application/json" };
  const body = JSON.stringify({ connectionId: account.connection.id, active: true });
  const before = requests.length;
  expect((await nativeFetch(path, { method: "PUT", body })).status).toBe(401);
  expect((await nativeFetch(path, { method: "PUT", body, headers: { Authorization: "Bearer client", "Content-Type": "application/json" } })).status).toBe(401);
  expect((await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ connectionId: "other", active: true }) })).status).toBe(404);
  expect((await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ connectionId: account.connection.id, active: "true" }) })).status).toBe(400);
  expect((await nativeFetch(`${base}/gmail/activation`, { method: "PUT", headers, body })).status).toBe(400);
  expect(await (await nativeFetch(path, { method: "PUT", headers, body })).json()).toEqual({ active: true });
  config.readOnly = true;
  expect((await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ connectionId: account.connection.id, active: false }) })).status).toBe(403);
  expect((await connectorStatus(config, "outlook-calendar")).connectors[0].active).toBe(true);
  expect(requests).toHaveLength(before);
});

test("custom personal OneDrive uses Microsoft Graph and the consumers authority", async () => {
  await saveLocalOAuthClient(config, "onedrive-personal", { clientId: "personal-client" });
  const result = await connected("onedrive-personal");
  expect(result.authorization.pathname).toBe("/consumers/oauth2/v2.0/authorize");
  const request = await createConnectorRequest(config, "onedrive-personal", result.connection.id);
  expect(request.apiOrigin).toBe("https://graph.microsoft.com");
  const { microsoftFilesAdapter } = await import("./files.js");
  await microsoftFilesAdapter({ personal: true }).test(request);
  expect(requests.at(-1)?.url.origin).toBe("https://graph.microsoft.com");
  expect(requests.at(-1)?.url.pathname).toBe("/v1.0/me/drive");
});

test("a rejected direct token refreshes once with the user's app and rotated refresh token", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const result = await connected();
  const previous = respond;
  respond = (url, init) => url.hostname === "oauth2.googleapis.com"
    ? Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    : new Headers(init?.headers).get("Authorization") === `Bearer ${access}` ? new Response(null, { status: 401 }) : previous(url, init);
  const request = await createConnectorRequest(config, "gmail", result.connection.id);
  await request("/gmail/v1/users/me/profile");
  const tokenRequests = requests.filter((item) => item.url.hostname === "oauth2.googleapis.com");
  expect(tokenRequests).toHaveLength(2);
  expect(tokenRequests[1].fields?.get("grant_type")).toBe("refresh_token");
  expect(tokenRequests[1].fields?.get("refresh_token")).toBe(refresh);
  expect(await connectorAccessToken(config, "gmail", result.connection.id, true)).toBe("rotated-access");
  expect(requests.at(-1)?.fields?.get("refresh_token")).toBe("rotated-refresh");
});

test("revoked direct credentials require reconnect and do not leak provider errors", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const result = await connected();
  respond = () => Response.json({ error: "invalid_grant", error_description: secret }, { status: 400 });
  await expect(connectorAccessToken(config, "gmail", result.connection.id, true)).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect((await localOAuthConnections(config, "gmail"))[0].needsReconnect).toBe(true);
  const count = requests.length;
  await expect(connectorAccessToken(config, "gmail", result.connection.id)).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect(requests).toHaveLength(count);
});

test("changing app details invalidates grants, preserves an omitted secret and cancels pending consent", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client", clientSecret: secret });
  const result = await connected();
  const pending = await start("gmail", result.connection.id);
  expect((await saveLocalOAuthClient(config, "gmail", { clientId: "client" })).hasClientSecret).toBe(true);
  await expect(pending.flows.status(pending.flow.flowId)).rejects.toMatchObject({ code: "connector_flow_not_found" });
  expect((await localOAuthConnections(config, "gmail"))[0].needsReconnect).toBe(true);
  await expect(connectorAccessToken(config, "gmail", result.connection.id)).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect((await saveLocalOAuthClient(config, "gmail", { clientId: "another-client" })).hasClientSecret).toBe(false);
});

test("cancelling after a consent callback cannot activate or retain a new grant", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const pending = await start();
  expect((await callback(pending.authorization)).status).toBe(200);
  await pending.flows.cancel(pending.flow.flowId);
  await expect(pending.flows.status(pending.flow.flowId)).rejects.toMatchObject({ code: "connector_flow_not_found" });
  expect(await localOAuthConnections(config, "gmail")).toEqual([]);
});

test("disconnect waits for refresh, removes the grant and blocks the late token", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client" });
  const result = await connected();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  respond = async () => { started.resolve(); await release.promise; return Response.json({ access_token: "late", refresh_token: "late-refresh", expires_in: 3600 }); };
  const refreshing = connectorAccessToken(config, "gmail", result.connection.id, true);
  await started.promise;
  const disconnecting = disconnectConnector(config, "gmail", result.connection.id);
  try {
    // Release the upstream refresh only after disconnect has removed the
    // account metadata and is waiting to erase its in-flight grant.
    for (let attempt = 0; attempt < 50 && (await localOAuthConnections(config, "gmail")).length; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await localOAuthConnections(config, "gmail")).toEqual([]);
    release.resolve();
    await expect(refreshing).rejects.toMatchObject({ code: "connector_not_connected" });
    await disconnecting;
  } finally { release.resolve(); await Promise.allSettled([refreshing, disconnecting]); }
  expect(await localOAuthConnections(config, "gmail")).toEqual([]);
  await expect(connectorAccessToken(config, "gmail", result.connection.id)).rejects.toMatchObject({ code: "connector_signin_required" });
});

test("removing app details deletes its credentials but preserves unrelated OAuth grants", async () => {
  await saveLocalOAuthClient(config, "gmail", { clientId: "client", clientSecret: secret });
  await connected();
  const vault = new OAuthVault(oauthVaultPath(config));
  await vault.set("other-grant", { accessToken: "other", refreshToken: "other-refresh", expiresAt: 123 });
  await removeLocalOAuthClient(config, "gmail");
  expect((await localOAuthClient(config, "gmail")).configured).toBe(false);
  expect(await localOAuthConnections(config, "gmail")).toEqual([]);
  expect((await vault.get("other-grant"))?.accessToken).toBe("other");
});

test("custom client routes require owner privileges and respect read-only mode", async () => {
  const server = await startServer(config);
  cancellations.push(async () => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const path = `${base}/connectors/gmail/oauth-client`;
  expect((await nativeFetch(path)).status).toBe(401);
  expect((await nativeFetch(path, { headers: { Authorization: "Bearer client" } })).status).toBe(401);
  const headers = { "X-LegalWork-Host-Token": "host", "Content-Type": "application/json" };
  const saved = await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ clientId: "client", clientSecret: secret }) });
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain(secret);
  config.readOnly = true;
  expect((await nativeFetch(path, { method: "DELETE", headers })).status).toBe(403);
  expect((await nativeFetch(`${base}/connectors/gmail/connect`, { method: "POST", headers, body: JSON.stringify({ method: "custom" }) })).status).toBe(403);
  expect(requests).toHaveLength(0);
});

const privateStateSchema = z.object({
  client: z.object({ clientId: z.string(), tenantId: z.string() }), revision: z.string(),
  connections: z.array(z.object({ id: z.string(), createdAt: z.string().nullable(), needsReconnect: z.boolean(), readOnly: z.boolean(), authorizedWrites: z.array(z.string()).optional(), grantKey: z.string().optional() })),
});
const privateStateKey = (id: string) => JSON.stringify(["connector-oauth-app", id === "outlook-calendar" ? "outlook" : id]);
async function privateState(id: string) {
  const saved = await new OAuthVault(oauthVaultPath(config)).getEntry(privateStateKey(id), privateStateSchema);
  if (!saved) throw new Error("Expected saved app state");
  return saved;
}

test("every connector defaults to blocked writes before credentials; preferences persist independently and legacy global flags grant nothing", async () => {
  const writes = CONNECTOR_EXTENSION_ACTIONS.filter((item) => item.writes);
  expect(writes).toContainEqual(expect.objectContaining({ extensionId: "google-calendar", action: "update_event" }));
  for (const action of writes) await expect(callConnectorExtensionAction(config, action.extensionId, action.action, {}, {})).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests).toHaveLength(0);
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  expect((await connectorSettings({ ...config })).writeAccess.outlook).toBe(true);
  expect((await connectorSettings(config)).writeAccess["outlook-calendar"]).toBe(false);
  if (process.platform !== "win32") expect((await stat(connectorSettingsPath(config))).mode & 0o777).toBe(0o600);
  await writeFile(connectorSettingsPath(config), JSON.stringify({ writeAccess: true }));
  expect(Object.values((await connectorSettings(config)).writeAccess).every((value) => !value)).toBe(true);
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  expect((await connectorSettings(config)).writeAccess["google-drive"]).toBe(false);
  await expect(saveConnectorWriteSetting(config, "unknown", { writeAccess: true })).rejects.toMatchObject({ code: "connector_not_found" });
  await expect(saveConnectorWriteSetting(config, "gmail", { writeAccess: "true" })).rejects.toMatchObject({ code: "invalid_payload" });
  await writeFile(connectorSettingsPath(config), "broken");
  await expect(callConnectorExtensionAction(config, "gmail", "create_draft", {}, {})).rejects.toMatchObject({ code: "connector_settings_unreadable" });
  expect(requests).toHaveLength(0);
});

test("enabling one Outlook connector requests the union of independently selected writes; read-only server still narrows consent", async () => {
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  let scopes = (await localOAuthClient(config, "outlook-calendar")).scopes;
  expect(scopes).toContain("https://graph.microsoft.com/Mail.ReadWrite");
  expect(scopes).toContain("https://graph.microsoft.com/Calendars.Read");
  expect(scopes).not.toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: false });
  scopes = (await localOAuthClient(config, "outlook")).scopes;
  expect(scopes).toContain("https://graph.microsoft.com/Mail.Read");
  expect(scopes).toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  for (const id of ["gmail", "google-calendar", "google-drive", "onedrive", "onedrive-personal", "sharepoint-files"]) {
    await saveConnectorWriteSetting(config, id, { writeAccess: true });
    const permissions = (await localOAuthClient(config, id)).scopes;
    expect(permissions.some((scope) => scope.endsWith("gmail.compose") || scope.endsWith("calendar.events") || scope.endsWith("/drive") || scope.endsWith("Files.ReadWrite.All"))).toBe(true);
  }
  config.readOnly = true;
  expect((await localOAuthClient(config, "outlook")).scopes).not.toContain("https://graph.microsoft.com/Calendars.ReadWrite");
  expect((await localOAuthClient(config, "google-drive")).scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
  await expect(saveConnectorWriteSetting(config, "gmail", { writeAccess: true })).rejects.toMatchObject({ code: "read_only" });
  expect(requests).toHaveLength(0);
});

test("scope upgrades preserve reads, cancelled consent preserves the old grant, activation erases obsolete grants, and Outlook flags stay independent", async () => {
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await saveLocalOAuthClient(config, "outlook", { clientId: "client" });
  const account = await connected("outlook");
  const oldState = await privateState("outlook");
  const oldKey = oldState.connections[0].grantKey;
  if (!oldKey) throw new Error("Expected a private grant key");
  await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
  await setConnectorActivation(config, "outlook-calendar", account.connection.id, true);
  const calendarRequest = await createConnectorRequest(config, "outlook-calendar", account.connection.id);
  await expect(calendarRequest("/v1.0/me/events", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_write_reconnect_required" });
  expect(await connectorAccessToken(config, "outlook-calendar", account.connection.id)).toBe(access);
  expect((await localOAuthConnections(config, "outlook"))[0].needsReconnect).toBe(false);
  const cancelled = await start("outlook-calendar", account.connection.id);
  expect(cancelled.authorization.searchParams.get("scope")).toContain("Calendars.ReadWrite");
  expect((await callback(cancelled.authorization)).status).toBe(200);
  await cancelled.flows.cancel(cancelled.flow.flowId);
  expect(await connectorAccessToken(config, "outlook", account.connection.id)).toBe(access);
  expect(await new OAuthVault(oauthVaultPath(config)).get(oldKey)).toBeDefined();
  const upgraded = await start("outlook-calendar", account.connection.id);
  expect((await callback(upgraded.authorization)).status).toBe(200);
  expect((await upgraded.flows.status(upgraded.flow.flowId)).status).toBe("connected");
  const newState = await privateState("outlook");
  const newKey = newState.connections[0].grantKey;
  if (!newKey) throw new Error("Expected an upgraded private grant key");
  expect(newKey).not.toBe(oldKey);
  expect(newState.connections[0].authorizedWrites).toEqual(["outlook", "outlook-calendar"]);
  expect(await new OAuthVault(oauthVaultPath(config)).get(oldKey)).toBeUndefined();
  respond = () => Response.json({ id: "event" });
  await (await createConnectorRequest(config, "outlook-calendar", account.connection.id))("/v1.0/me/events", { method: "POST", body: {} });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: false });
  const mailRequest = await createConnectorRequest(config, "outlook", account.connection.id);
  await expect(mailRequest("/v1.0/me/messages", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await (await createConnectorRequest(config, "outlook-calendar", account.connection.id))("/v1.0/me/events", { method: "POST", body: {} });
  await disconnectConnector(config, "outlook", account.connection.id);
  expect(await new OAuthVault(oauthVaultPath(config)).get(newKey)).toBeUndefined();
});

test("legacy storage grants never authorize writes, while old Outlook write grants remain usable under each independent flag", async () => {
  for (const id of ["google-drive", "outlook"]) {
    await saveLocalOAuthClient(config, id, { clientId: "client" });
    const account = await connected(id);
    const saved = await privateState(id);
    const currentKey = saved.connections[0].grantKey;
    if (!currentKey) throw new Error("Expected a staged grant");
    const vault = new OAuthVault(oauthVaultPath(config));
    const legacyKey = JSON.stringify(["connector-oauth-grant", id, saved.revision, account.connection.id, false]);
    await vault.set(legacyKey, { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 100_000 });
    await vault.setEntry(privateStateKey(id), privateStateSchema, { ...saved, connections: [{ id: account.connection.id, createdAt: account.connection.createdAt, needsReconnect: false, readOnly: false }] });
    await vault.set(currentKey, undefined);
    await saveConnectorWriteSetting(config, id, { writeAccess: true });
    const request = await createConnectorRequest(config, id, account.connection.id);
    if (id === "google-drive") {
      await expect(request("/drive/v3/files", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_write_reconnect_required" });
      expect(await connectorAccessToken(config, id, account.connection.id)).toBe(access);
    } else {
      await request("/v1.0/me/messages", { method: "POST", body: {} });
      await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
      await setConnectorActivation(config, "outlook-calendar", account.connection.id, true);
      await (await createConnectorRequest(config, "outlook-calendar", account.connection.id))("/v1.0/me/events", { method: "POST", body: {} });
    }
  }
});

test("all storage actions use direct provider requests after consent, including scoped raw content and ETags", async () => {
  for (const id of ["google-drive", "onedrive", "onedrive-personal", "sharepoint-files"]) {
    await saveConnectorWriteSetting(config, id, { writeAccess: true });
    await saveLocalOAuthClient(config, id, { clientId: "client" });
    const account = await connected(id);
    const prior = respond;
    respond = async (url, init) => {
      if (url.pathname.endsWith("/token")) return prior(url, init);
      expect(init?.redirect).toBe("error");
      if (init?.body instanceof Blob) {
        expect(init.method).toBe(id === "google-drive" ? "POST" : "PUT");
        if (init.method === "POST") expect(await init.body.text()).toContain("contents");
        else expect(await init.body.text()).toBe("contents");
      }
      return Response.json(id === "google-drive" ? { id: "file", name: "Test.txt", mimeType: "text/plain" } : { id: "file", name: "Test.txt", eTag: '"version"', file: { mimeType: "text/plain" } });
    };
    const common = { connectionId: account.connection.id, ...id === "google-drive" ? {} : { driveId: "library" } };
    await callConnectorExtensionAction(config, id, "upload_file", { ...common, folderId: "folder", name: "Test.txt", mimeType: "text/plain", dataBase64: Buffer.from("contents").toString("base64") }, {});
    await callConnectorExtensionAction(config, id, "create_folder", { ...common, name: "Cases" }, {});
    respond = (url, init) => {
      if (init?.method === "PUT" || init?.method === "PATCH") expect(new Headers(init.headers).get("If-Match")).toBe('"version"');
      return Response.json(id === "google-drive" ? { id: "file", name: "Test.txt", mimeType: "text/plain" } : { id: "file", name: "Test.txt", file: { mimeType: "text/plain" }, eTag: '"version"' }, { headers: { ETag: '"version"' } });
    };
    await callConnectorExtensionAction(config, id, "update_file", { ...common, fileId: "file", mimeType: "text/plain", dataBase64: "", etag: '"version"' }, {});
    expect(requests.filter((item) => item.method !== "GET" && !item.url.pathname.endsWith("/token")).every((item) => ["www.googleapis.com", "graph.microsoft.com"].includes(item.url.hostname))).toBe(true);
    respond = prior;
  }
});

test("disabling a connector after request creation or metadata lookup blocks unsent writes and retains reading", async () => {
  await saveConnectorWriteSetting(config, "onedrive", { writeAccess: true });
  await saveLocalOAuthClient(config, "onedrive", { clientId: "client" });
  const account = await connected("onedrive");
  const request = await createConnectorRequest(config, "onedrive", account.connection.id);
  await saveConnectorWriteSetting(config, "onedrive", { writeAccess: false });
  const before = requests.length;
  await expect(request("/v1.0/me/drive/root/children", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests).toHaveLength(before);
  await request("/v1.0/me/drive");
  await saveConnectorWriteSetting(config, "onedrive", { writeAccess: true });
  respond = async (_url, init) => {
    expect(init?.method).toBe("GET");
    await saveConnectorWriteSetting(config, "onedrive", { writeAccess: false });
    return Response.json({ id: "file", name: "Test.txt", file: { mimeType: "text/plain" }, eTag: '"version"' });
  };
  await expect(callConnectorExtensionAction(config, "onedrive", "update_file", { connectionId: account.connection.id, fileId: "file", dataBase64: "", etag: '"version"' }, {})).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests.filter((item) => item.method === "PUT")).toHaveLength(0);
});

test("disabling during a rejected token blocks the write retry; provider permission and conflict failures are never retried", async () => {
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  await saveLocalOAuthClient(config, "google-drive", { clientId: "client" });
  const account = await connected("google-drive");
  const native = respond;
  respond = async (url, init) => {
    if (url.pathname.endsWith("/token")) return native(url, init);
    await saveConnectorWriteSetting(config, "google-drive", { writeAccess: false });
    return new Response(null, { status: 401 });
  };
  const request = await createConnectorRequest(config, "google-drive", account.connection.id);
  await expect(request("/drive/v3/files", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests.filter((item) => item.url.hostname === "www.googleapis.com")).toHaveLength(1);
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  for (const [status, code] of [[403, "connector_permission_required"], [409, "connector_item_conflict"], [412, "connector_file_changed"], [500, "connector_api_failed"]]) {
    if (typeof status !== "number") throw new Error("Expected HTTP status");
    respond = () => new Response(null, { status });
    const before = requests.length;
    await expect(request("/drive/v3/files", { method: "POST", body: {} })).rejects.toMatchObject({ code });
    expect(requests).toHaveLength(before + 1);
  }
});

test("connector preference API needs owner authorization, rejects invalid input and never contacts Nango", async () => {
  const server = await startServer(config);
  cancellations.push(async () => server.stop());
  const path = `http://127.0.0.1:${server.port}/connectors/gmail/settings`;
  expect((await nativeFetch(path)).status).toBe(401);
  expect((await nativeFetch(path, { headers: { Authorization: "Bearer client" } })).status).toBe(401);
  const headers = { "X-LegalWork-Host-Token": "host", "Content-Type": "application/json" };
  expect(await (await nativeFetch(path, { headers })).json()).toEqual({ writeAccess: false, readOnly: false });
  expect((await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ writeAccess: "true" }) })).status).toBe(400);
  expect(await (await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ writeAccess: true }) })).json()).toEqual({ writeAccess: true, readOnly: false });
  config.readOnly = true;
  expect((await nativeFetch(path, { method: "PUT", headers, body: JSON.stringify({ writeAccess: false }) })).status).toBe(403);
  expect(requests).toHaveLength(0);
});

test("Outlook requests Mail.Send only with mail writes, and older write grants cannot silently gain sending access", async () => {
  await saveLocalOAuthClient(config, "outlook", { clientId: "client" });
  expect((await localOAuthClient(config, "outlook")).scopes).not.toContain("https://graph.microsoft.com/Mail.Send");
  await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
  expect((await localOAuthClient(config, "outlook")).scopes).not.toContain("https://graph.microsoft.com/Mail.Send");
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  expect((await localOAuthClient(config, "outlook")).scopes).toContain("https://graph.microsoft.com/Mail.Send");
  const account = await connected("outlook");
  await requireLocalOAuthSendAccess(config, "outlook", account.connection.id);
  const request = await createConnectorRequest(config, "outlook", account.connection.id);
  const saved = await privateState("outlook"); // This legacy fixture schema intentionally omits authorizedSends.
  await new OAuthVault(oauthVaultPath(config)).setEntry(privateStateKey("outlook"), privateStateSchema, saved);
  const count = requests.length;
  await expect(requireLocalOAuthSendAccess(config, "outlook", account.connection.id)).rejects.toMatchObject({ code: "connector_write_reconnect_required" });
  await expect(request("/v1.0/me/messages/draft/send", { method: "POST", send: true, empty: true })).rejects.toMatchObject({ code: "connector_write_reconnect_required" });
  expect(requests).toHaveLength(count);
});

test("late invalid_grant from an obsolete refresh cannot poison a successfully upgraded account", async () => {
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await saveLocalOAuthClient(config, "outlook", { clientId: "client" });
  const account = await connected("outlook");
  const oldKey = (await privateState("outlook")).connections[0].grantKey;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const previous = respond;
  respond = async (url, init) => {
    if (init?.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token") {
      started.resolve(); await release.promise;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return previous(url, init);
  };
  const refreshing = connectorAccessToken(config, "outlook", account.connection.id, true);
  const refreshResult = refreshing.then(() => undefined, (error: unknown) => error);
  await started.promise;
  await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
  const reconnect = await start("outlook-calendar", account.connection.id);
  expect((await callback(reconnect.authorization)).status).toBe(200);
  const activating = reconnect.flows.status(reconnect.flow.flowId);
  try {
    for (let attempt = 0; attempt < 50 && (await privateState("outlook")).connections[0].grantKey === oldKey; attempt++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await privateState("outlook")).connections[0].grantKey).not.toBe(oldKey);
    release.resolve();
    expect(await refreshResult).toMatchObject({ code: "connector_reconnect_required" });
    expect((await activating).status).toBe("connected");
    expect((await localOAuthConnections(config, "outlook"))[0].needsReconnect).toBe(false);
    expect(await connectorAccessToken(config, "outlook-calendar", account.connection.id)).toBe(access);
  } finally { release.resolve(); await Promise.allSettled([refreshing, activating]); }
});
