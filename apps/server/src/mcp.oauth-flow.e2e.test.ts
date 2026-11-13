import { expect, test } from "bun:test";
import { z } from "zod";
import { zipSync, strToU8 } from "fflate";
import { normalizeImportedConnector } from "./connector-imports.js";
import { resolvePluginImports } from "./plugin-imports.js";
import { preparePluginImport, reviewedPluginImport } from "./plugin-import-checks.js";
import { nativeOpencodeConfig } from "./native-opencode-config.js";
import { nativeMcpBinary, nativeMcpEngine, nativeOAuthProvider } from "./native-mcp-engine.test-support.js";
import { beginNativeMcpOAuth, nativeMcpOAuthStatus, waitForNativeFixture, waitForNativeMcpOAuth } from "./native-mcp.test-support.js";

async function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port; server.stop(true);
  if (!port) throw new Error("No fixture port");
  return port;
}
const requestLog = z.object({ requests: z.array(z.object({ method: z.string(), path: z.string() })) });
function remote(config: Record<string, unknown>) {
  const value = nativeOpencodeConfig({ mcp: { fixture: { type: "remote", ...config } } }).config.mcp?.servers?.fixture;
  if (!value) throw new Error("Missing converted MCP config");
  return value;
}
async function fixture(action: (provider: Awaited<ReturnType<typeof nativeOAuthProvider>>, engine: Awaited<ReturnType<typeof nativeMcpEngine>>) => Promise<void>, environment: Record<string, string> = {}, configuration: Record<string, unknown> = {}) {
  const provider = await nativeOAuthProvider(environment);
  const engine = await nativeMcpEngine({ mcp: { servers: { fixture: { type: "remote", url: `${provider.url}/mcp`, ...configuration } } } });
  try { await action(provider, engine); } finally { await engine.close(); await provider.close(); }
}
const released = test.skipIf(!nativeMcpBinary);

released("native OAuth completes discovery/DCR/PKCE and keeps its credential across engine restart", async () => fixture(async (provider, engine) => {
  const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
  const authorization = new URL(attempt.url);
  expect(attempt.mode).toBe("auto");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
  expect(authorization.searchParams.get("state")).toBeTruthy();
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  await client.mcp.connect({ location: engine.location, server: "fixture" });
  expect((await client.mcp.list({ location: engine.location })).data.find(server => server.name === "fixture")?.status.status).toBe("connected");
  const credentials = await client.credential.list(), saved = credentials.find(entry => entry.integrationID === attempt.integrationID);
  expect(saved?.value.type).toBe("oauth");
  if (!saved || saved.value.type !== "oauth") throw new Error("Native OAuth credential missing");
  expect(saved.value.access).toStartWith("mock-access-");
  const log = requestLog.parse(await provider.requests());
  const paths = log.requests.map(request => `${request.method} ${request.path}`);
  expect(paths).toContain("POST /register"); expect(paths).toContain("GET /authorize"); expect(paths).toContain("POST /token"); expect(paths).toContain("POST /mcp");
  await engine.restart();
  expect((await engine.client().credential.list()).find(entry => entry.id === saved.id)?.value).toEqual(saved.value);
  await engine.client().model.list({ location: engine.location });
  await waitForNativeFixture(async () => (await engine.client().mcp.list({ location: engine.location })).data.find(server => server.name === "fixture")?.status.status, status => status === "connected", "restored authenticated MCP");
}), 30_000);

released("Context7's canonical imported callback survives provider normalization and native token exchange", async () => fixture(async (provider, engine) => {
  const client = engine.client(), before = await beginNativeMcpOAuth(client, engine.location, "fixture");
  const rejected = await fetch(before.url, { redirect: "manual" });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain("registered redirect URLs");
  await client.integration.oauth.cancel({ ...before, location: engine.location });
  const callbackPort = await freePort();
  const imported = normalizeImportedConnector({ url: "https://mcp.context7.com/mcp?client=claude-code-plugin", oauth: { callbackPort } }, []);
  await client.mcp.add({ location: engine.location, server: "imported", config: remote({ ...imported, url: `${provider.url}/mcp`, enabled: true }) });
  const attempt = await beginNativeMcpOAuth(client, engine.location, "imported");
  const oauth = z.object({ redirectUri: z.string() }).parse(imported.oauth);
  expect(new URL(attempt.url).searchParams.get("redirect_uri")).toBe(oauth.redirectUri);
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
}, { NORMALIZE_LOOPBACK_CALLBACK: "1" }), 30_000);

released("native disconnect and credential removal drop OAuth without editing another integration", async () => fixture(async (_provider, engine) => {
  const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
  await fetch(attempt.url); await waitForNativeMcpOAuth(client, engine.location, attempt);
  const credential = (await client.credential.list()).find(entry => entry.integrationID === attempt.integrationID);
  if (!credential) throw new Error("Native credential missing");
  await client.mcp.disconnect({ location: engine.location, server: "fixture" });
  await client.credential.remove({ credentialID: credential.id });
  expect((await client.credential.list()).find(entry => entry.integrationID === attempt.integrationID)).toBeUndefined();
}), 30_000);

released("a provider refusing DCR accepts the explicitly registered client credentials", async () => fixture(async (provider, engine) => {
  const client = engine.client();
  await expect(beginNativeMcpOAuth(client, engine.location, "fixture")).rejects.toBeDefined();
  const registrations = requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register").length;
  await client.mcp.add({ location: engine.location, server: "registered", config: { type: "remote", url: `${provider.url}/mcp`, oauth: { client_id: "legalwork-test-client", client_secret: "legalwork-test-secret" } } });
  const attempt = await beginNativeMcpOAuth(client, engine.location, "registered");
  expect(new URL(attempt.url).searchParams.get("client_id")).toBe("legalwork-test-client");
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  expect(requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register")).toHaveLength(registrations);
}, { DYNAMIC_REGISTRATION: "0", CLIENT_ID: "legalwork-test-client", CLIENT_SECRET: "legalwork-test-secret" }), 30_000);

released("manual completion cannot bypass a native automatic attempt's callback or state", async () => fixture(async (_provider, engine) => {
  const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "fixture");
  const response = await fetch(attempt.url, { redirect: "manual" });
  const callback = response.headers.get("location"); if (!callback) throw new Error("Callback missing");
  const code = new URL(callback).searchParams.get("code"); if (!code) throw new Error("Code missing");
  await expect(client.integration.oauth.complete({ integrationID: attempt.integrationID, attemptID: attempt.attemptID, location: engine.location, code })).rejects.toBeDefined();
  expect((await nativeMcpOAuthStatus(client, engine.location, attempt)).status).toBe("pending");
  expect((await fetch(callback)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
}), 30_000);

released("an import-prepared client completes native OAuth without a second registration", async () => fixture(async (provider, engine) => {
  const redirectUri = `http://127.0.0.1:${await freePort()}/callback/imported`;
  const files = { ".claude-plugin/plugin.json": '{"name":"prepared"}', ".mcp.json": JSON.stringify({ mcpServers: { prepared: { type: "http", url: `${provider.url}/mcp`, oauth: { redirectUri } } } }) };
  const [plan] = await resolvePluginImports({ source: { provider: "claude", zipBase64: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))).toString("base64") }, scope: "project" }, engine.directory);
  if (!plan) throw new Error("Missing import plan");
  const target = { workspace: engine.directory, scope: "project", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
  const prepared = await preparePluginImport(plan, target);
  expect(prepared.preview.connectors?.[0]?.status).toBe("setup");
  const reviewed = reviewedPluginImport(plan, target, prepared.preview.validationId), component = reviewed.preview.components[0], config = reviewed.connectorConfigs?.[component.installedName];
  if (!config) throw new Error("Prepared connection missing");
  const registrations = requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register").length;
  const client = engine.client();
  await client.mcp.add({ location: engine.location, server: component.installedName, config: remote({ ...config, enabled: true }) });
  const attempt = await beginNativeMcpOAuth(client, engine.location, component.installedName);
  expect(new URL(attempt.url).searchParams.get("redirect_uri")).toBe(redirectUri);
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  expect(requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register")).toHaveLength(registrations);
}), 30_000);

released("LegalWork metadata identity retains its callback and does not dynamically register again", async () => fixture(async (provider, engine) => {
  const identity = "https://legalwork.example/oauth/client.json", redirectUri = `http://127.0.0.1:${await freePort()}/mcp/oauth/callback`;
  const files = { ".claude-plugin/plugin.json": '{"name":"metadata-identity"}', ".mcp.json": JSON.stringify({ mcpServers: { metadata: { url: `${provider.url}/mcp`, oauth: { redirectUri } } } }) };
  const [plan] = await resolvePluginImports({ source: { provider: "claude", zipBase64: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))).toString("base64") }, scope: "project" }, engine.directory);
  if (!plan) throw new Error("Missing metadata import");
  const prepared = await preparePluginImport(plan, { workspace: engine.directory, scope: "project", current: {} }, { clientMetadataUrl: identity, fetch: (input, init) => String(input) === identity ? Promise.resolve(Response.json({ client_id: identity, client_name: "LegalWork", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })) : fetch(input, init) });
  const component = prepared.preview.components[0], config = prepared.connectorConfigs?.[component.installedName];
  expect(config?.oauth).toMatchObject({ client_id: identity, redirect_uri: redirectUri });
  if (!config) throw new Error("Prepared metadata connection missing");
  const registrations = requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register").length;
  const client = engine.client();
  await client.mcp.add({ location: engine.location, server: component.installedName, config: remote({ ...config, enabled: true }) });
  const attempt = await beginNativeMcpOAuth(client, engine.location, component.installedName);
  expect(new URL(attempt.url).searchParams.get("client_id")).toBe(identity);
  expect(new URL(attempt.url).searchParams.get("redirect_uri")).toBe(redirectUri);
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  expect(requestLog.parse(await provider.requests()).requests.filter(request => request.path === "/register")).toHaveLength(registrations);
}, { CLIENT_ID: "https://legalwork.example/oauth/client.json", CLIENT_METADATA_DOCUMENT_SUPPORTED: "1" }), 30_000);

released("native configured scopes are verified against the exact authorization request", async () => fixture(async (_provider, engine) => {
  const attempt = await beginNativeMcpOAuth(engine.client(), engine.location, "fixture");
  expect(new URL(attempt.url).searchParams.get("scope")).toBe("mcp:read");
  await engine.client().integration.oauth.cancel({ integrationID: attempt.integrationID, attemptID: attempt.attemptID, location: engine.location });
}, {}, { oauth: { scope: "mcp:read" } }), 30_000);
