import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { resolvePluginImports, type PluginImportPlan } from "./plugin-imports.js";
import { preparePluginImport, reviewedPluginImport } from "./plugin-import-checks.js";
import { installPluginImport } from "./plugin-import-install.js";
import { readInstalledCloudPlugins } from "./cloud-plugins.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import { normalizeImportedConnector } from "./connector-imports.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()?.(); });
const skill = "---\nname: review\ndescription: Review documents\n---\nReview.";
const target = { workspace: "/import-test", scope: "project", current: {} } satisfies Parameters<typeof preparePluginImport>[1];
function request(servers: Record<string, unknown>, provider: "claude" | "chatgpt" = "claude", includeSkill = true) {
  const files: Record<string, string> = { [provider === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json"]: JSON.stringify({ name: "check-import" }), ".mcp.json": JSON.stringify({ mcpServers: servers }), ...(includeSkill ? { "skills/review/SKILL.md": skill } : {}) };
  return { source: { provider, zipBase64: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, strToU8(value)])))).toString("base64") }, scope: target.scope };
}
async function plan(servers: Record<string, unknown>, provider: "claude" | "chatgpt" = "claude", includeSkill = true): Promise<PluginImportPlan> {
  const [result] = await resolvePluginImports(request(servers, provider, includeSkill), target.workspace);
  if (!result) throw new Error("Missing test import");
  return result;
}
function provider(options: { dcr?: boolean; cimd?: boolean; refused?: boolean; authMethods?: string[]; open?: boolean; legacySse?: boolean; response?: () => Response } = {}) {
  let registrations = 0;
  let registeredMetadata: unknown;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    if (url.pathname === "/mcp") {
      if (options.legacySse && req.method === "POST") return new Response("Method not allowed", { status: 405 });
      if (options.response) return options.response();
      if (options.open) return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } });
      return Response.json({}, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(options.dcr ? { registration_endpoint: `${origin}/register` } : {}), ...(options.cimd ? { client_id_metadata_document_supported: true } : {}), ...(options.authMethods ? { token_endpoint_auth_methods_supported: options.authMethods } : {}) });
    if (url.pathname === "/register") {
      registrations++;
      registeredMetadata = await req.json();
      return options.refused ? Response.json({ error: "access_denied", error_description: "Approved apps only" }, { status: 403 }) : Response.json({ client_id: "legalwork-client", token_endpoint_auth_method: "none", client_secret: "irrelevant-public-secret" }, { status: 201 });
    }
    return new Response("Not found", { status: 404 });
  } });
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}/mcp`, registrations: () => registrations, metadata: () => registeredMetadata };
}

test("source-specific requirements are blocked before lossy normalization; supported skills survive", async () => {
  const blocked = {
    websocket: { type: "ws", url: "https://example.com/mcp" },
    sdk: { type: "sdk" },
    helper: { url: "https://example.com/mcp", http_headers_helper: "read-credentials" },
    metadata: { url: "https://example.com/mcp", oauth: { authServerMetadataUrl: "https://auth.example/metadata" } },
    jwt: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "provided", clientId: "client", tokenEndpointAuthMethod: "private_key_jwt" } } } } },
    basic: { url: "https://example.com/mcp", oauth: { clientId: "client", tokenEndpointAuthMethod: "client_secret_basic" } },
    session: { url: "https://example.com/mcp", auth: "chatgpt" },
    executor: { command: "node", env_vars: [{ name: "REMOTE_SECRET", source: "remote" }] },
    identity: { url: "https://example.com/mcp", oauth: { clientId: "https://chatgpt.com/oauth/codex/client.json" } },
    callback: { url: "https://example.com/mcp", oauth: { clientId: "client", callbackUrl: "https://original-app.example/callback" } },
  };
  for (const source of ["chatgpt", "claude"] satisfies Array<"chatgpt" | "claude">) {
    const imported = await plan(blocked, source);
    expect(imported.preview.connectors).toHaveLength(Object.keys(blocked).length);
    expect(imported.preview.connectors?.every(check => check.status === "blocked")).toBe(true);
    expect(imported.preview.components.map(component => component.type)).toEqual(["skill"]);
    const checked = await preparePluginImport(imported, target, { fetch: async () => { throw new Error("Blocked configurations must not contact providers"); } });
    expect(checked.resolved.plugin.excludedConnectors).toHaveLength(Object.keys(blocked).length);
    expect(checked.resolved.memberships.some(item => item.configObject?.objectType === "mcp")).toBe(false);
  }
});

test("scope pins, callback paths, environment objects and portable credentials are preserved", async () => {
  const imported = await plan({
    scopes: { url: "https://example.com/mcp", oauth: { clientId: "registered", callbackPort: 4321, scopes: "read" } },
    program: { command: "node", env_vars: [{ name: "LOCAL_TOKEN", source: "local" }] },
    key: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "api_key", headerScheme: "custom_header", headerName: "X-Provider-Token" } } } },
    confidential: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "provided", clientId: "registered", tokenEndpointAuthMethod: "client_secret_post" }, defaultScopes: ["read"] } } } },
  });
  const config = (name: string) => imported.connectorConfigs?.[imported.preview.connectors?.find(check => check.name === name)?.installedName ?? ""];
  expect(config("scopes")?.oauth).toEqual({ clientId: "registered", callbackPort: 4321, scope: "read", redirectUri: "http://localhost:4321/callback" });
  expect(config("program")?.env).toMatchObject({ LOCAL_TOKEN: "${LOCAL_TOKEN}" });
  expect(config("key")?.headers).toMatchObject({ "X-Provider-Token": "${API_KEY}" });
  expect(config("confidential")?.oauth).toMatchObject({ clientId: "registered", clientSecret: "${OAUTH_CLIENT_SECRET}", scope: "read" });
  expect(imported.preview.connectors?.find(check => check.name === "scopes")?.status).not.toBe("blocked");
  expect(imported.preview.connectors?.find(check => check.name === "confidential")?.status).not.toBe("blocked");
  expect(imported.preview.connectors?.filter(check => !["scopes", "confidential"].includes(check.name)).every(check => check.status !== "blocked")).toBe(true);
});

test("portable fixed default scopes are supported without flattening required/default scope rules", async () => {
  const imported = await plan({
    fixed: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", defaultScopes: ["mcp:read"] } } } },
    fixedWithNoRequiredScopes: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", baseScopes: [], defaultScopes: ["mcp:read"] } } } },
    noDefaults: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", defaultScopes: [] } } } },
    requiredAndDefaults: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", baseScopes: ["mcp:read"], defaultScopes: ["mcp:write"] } } } },
    requiredWithProviderDefaults: { url: "https://example.com/mcp", extensions: { "com.openai": { auth: { type: "oauth", baseScopes: ["mcp:read"] } } } },
  });
  for (const name of ["fixed", "fixedWithNoRequiredScopes"]) {
    const check = imported.preview.connectors?.find(check => check.name === name);
    expect(check?.status).not.toBe("blocked");
    expect(imported.connectorConfigs?.[check?.installedName ?? ""]?.oauth).toEqual({ scope: "mcp:read" });
  }
  for (const name of ["noDefaults", "requiredAndDefaults", "requiredWithProviderDefaults"]) {
    expect(imported.preview.connectors?.find(check => check.name === name)).toMatchObject({ status: "blocked", code: "pinned_scopes" });
  }
});

test("empty or unsupported explicit scope values are refused before normalization can widen sign-in permissions", async () => {
  const imported = await plan({
    emptyScope: { url: "https://example.com/mcp", oauth: { scope: "" } },
    whitespaceScopes: { url: "https://example.com/mcp", oauth: { scopes: "   " } },
    emptyList: { url: "https://example.com/mcp", oauth: { scopes: [] } },
    unsupportedList: { url: "https://example.com/mcp", oauth: { scopes: ["mcp:read"] } },
    emptyCodexList: { url: "https://example.com/mcp", scopes: [] },
    conflictingPins: { url: "https://example.com/mcp", scopes: ["mcp:read"], oauth: { scope: "mcp:write" } },
  });
  expect(imported.preview.connectors).toHaveLength(6);
  expect(imported.preview.connectors?.every(check => check.status === "blocked" && check.code === "pinned_scopes")).toBe(true);
  expect(imported.preview.components.some(component => component.type === "skill")).toBe(true);
});

test("Codex fixed scope lists and Claude scope strings reach the same native scope without widening", async () => {
  const imported = await plan({
    codex: { url: "https://example.com/mcp", scopes: ["mcp:read", "profile"] },
    matching: { url: "https://example.com/mcp", scopes: ["mcp:read", "profile"], oauth: { scopes: "profile mcp:read" } },
  });
  for (const check of imported.preview.connectors ?? []) {
    expect(check.status).not.toBe("blocked");
    const config = imported.connectorConfigs?.[check.installedName];
    expect(config?.oauth).toEqual({ scope: check.name === "codex" ? "mcp:read profile" : "profile mcp:read" });
    expect(config?.scopes).toBeUndefined();
  }
  expect(normalizeImportedConnector({ url: "https://example.com/mcp", scopes: ["mcp:read"], oauth: false }, []).oauth).toBe(false);
});

test("automatic registration is checked once and its exact callback/scopes survive installation preparation", async () => {
  const remote = provider({ dcr: true, cimd: true });
  const imported = await plan({ remote: { url: remote.url, oauth: { scope: "read write", callbackUrl: "http://localhost:4321/callback/registered" } } }, "chatgpt");
  const checked = await preparePluginImport(imported, target);
  expect(checked.preview.connectors?.[0]).toMatchObject({ status: "setup", code: "sign_in" });
  expect(remote.metadata()).toMatchObject({ redirect_uris: ["http://localhost:4321/callback/registered"], scope: "read write", token_endpoint_auth_method: "none" });
  const same = await preparePluginImport(imported, target);
  expect(same.preview.validationId).toBe(checked.preview.validationId);
  expect(remote.registrations()).toBe(1);
  const ready = reviewedPluginImport(imported, target, checked.preview.validationId);
  expect(JSON.stringify(ready.resolved)).toContain('"client_id":"legalwork-client"');
  expect(JSON.stringify(ready.resolved)).not.toContain("irrelevant-public-secret");
  expect(JSON.stringify(checked.preview)).not.toContain("legalwork-client");
  expect(JSON.stringify(checked.preview)).not.toContain("irrelevant-public-secret");
  expect(() => reviewedPluginImport(imported, { ...target, workspace: "/other" }, checked.preview.validationId)).toThrow("review expired");
  expect(() => reviewedPluginImport(imported, target, "forged")).toThrow("review expired");
});

test("registration refusals and CIMD-only providers cannot be installed as working connectors", async () => {
  for (const remote of [provider({ dcr: true, refused: true }), provider({ cimd: true })]) {
    const imported = await plan({ remote: { url: remote.url } }, "claude", false);
    const checked = await preparePluginImport(imported, target);
    expect(checked.preview.connectors?.[0]?.status).toBe("blocked");
    expect(checked.preview.components).toEqual([]);
    expect(() => reviewedPluginImport(imported, target, checked.preview.validationId)).toThrow("None of these connectors");
  }
});

test("OAuth on a legacy SSE-only endpoint is blocked before registration rather than failing during sign-in", async () => {
  const remote = provider({ legacySse: true, dcr: true });
  const checked = await preparePluginImport(await plan({ legacy: { type: "sse", url: remote.url } }), target);
  expect(checked.preview.connectors?.[0]).toMatchObject({ status: "blocked", code: "legacy_sse_oauth" });
  expect(remote.registrations()).toBe(0);
});

test("known provider approval and local dependency requirements are actionable before installation", async () => {
  const imported = await plan({ figma: { type: "http", url: "https://mcp.figma.com/mcp" }, absent: { command: "legalwork-test-program-that-does-not-exist" } });
  const checked = await preparePluginImport(imported, target);
  expect(checked.preview.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ name: "figma", code: "provider_approval", status: "blocked", documentationUrl: expect.stringContaining("figma.com") }), expect.objectContaining({ name: "absent", code: "program_missing", status: "blocked", retryable: true })]));
});

test("bare GitHub imports use its documented token setup without copying another host's OAuth registration", async () => {
  const imported = await plan({ github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { "X-MCP-Readonly": "true" } } });
  const checked = await preparePluginImport(imported, target, { fetch: async () => new Response("Forbidden", { status: 403 }) });
  expect(checked.preview.connectors?.[0]).toMatchObject({ status: "setup", inputs: ["GITHUB_TOKEN"] });
  expect(checked.preview.connectors?.[0]?.message).toContain("personal access token");
  expect(JSON.stringify(checked.resolved)).toContain('"Authorization":"Bearer ${GITHUB_TOKEN}"');
  expect(JSON.stringify(checked.resolved)).toContain('"X-MCP-Readonly":"true"');
  const explicit = await plan({ github: { url: "https://api.githubcopilot.com/mcp/", oauth: { clientId: "own-registered-app" } } });
  expect(JSON.stringify(explicit.resolved)).not.toContain("GITHUB_TOKEN");
  expect(normalizeImportedConnector({ type: "remote", url: "https://api.githubcopilot.com/mcp/" }, [], "legalwork")).toEqual({ type: "remote", url: "https://api.githubcopilot.com/mcp/" });
});

test("temporary network failures can be rechecked; a denial is not automatically diagnosed as IP blocking", async () => {
  let reachable = false;
  const imported = await plan({ retry: { url: "https://retry.example/mcp" } });
  const options = { fetch: async () => { if (!reachable) throw new Error("offline"); return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" } } }); } };
  const first = await preparePluginImport(imported, target, options);
  expect(first.preview.connectors?.[0]).toMatchObject({ status: "blocked", retryable: true, code: "unreachable" });
  reachable = true;
  const second = await preparePluginImport(imported, target, options, true);
  expect(second.preview.connectors?.[0]?.status).toBe("compatible");
  const refused = provider({ response: () => new Response("Forbidden", { status: 403 }) });
  const denied = await preparePluginImport(await plan({ denied: { url: refused.url } }), target);
  expect(denied.preview.connectors?.[0]?.code).toBe("access_refused");
  expect(denied.preview.connectors?.[0]?.message).toContain("any IP allowlist");
  expect(denied.preview.connectors?.[0]?.message).not.toContain("IP address is blocked");
});

test("a JSON or HTML success page is not an MCP endpoint; exact source addresses do not silently change", async () => {
  for (const response of [() => Response.json({ success: true }), () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })]) {
    const remote = provider({ response });
    const checked = await preparePluginImport(await plan({ remote: { url: remote.url } }), target);
    expect(checked.preview.connectors?.[0]?.status).toBe("blocked");
  }
});

test("credential requirements use setup; secrets are never sent to anonymous discovery or returned in review", async () => {
  const remote = provider({ response: () => new Response("Forbidden", { status: 403 }) });
  const imported = await plan({ token: { url: remote.url, headers: { Authorization: "Bearer ${USER_TOKEN}" } } });
  const checked = await preparePluginImport(imported, target);
  expect(checked.preview.connectors?.[0]).toMatchObject({ status: "setup", inputs: ["USER_TOKEN"] });
  const post = provider({ authMethods: ["client_secret_post"] });
  const registered = await preparePluginImport(await plan({ post: { url: post.url, oauth: { clientId: "approved" } } }), target);
  expect(registered.preview.connectors?.[0]).toMatchObject({ status: "setup", inputs: ["OAUTH_CLIENT_SECRET"] });
});

test("reimport checks existing owned setup and invalidates review if that setup changes", async () => {
  const imported = await plan({ figma: { url: "https://mcp.figma.com/mcp" } });
  const name = imported.preview.connectors?.[0]?.installedName;
  if (!name) throw new Error("Missing test connector");
  const owned = { ...target, current: { [name]: { type: "remote", url: "https://mcp.figma.com/mcp", disabled: false, headers: { Authorization: "Bearer existing-private-token" }, oauth: false } }, installed: { pluginId: imported.preview.id, name: imported.preview.name, marketplaceId: null, description: null, updatedAt: null, importedAt: 1, files: [{ objectType: "mcp", path: `opencode.jsonc#mcp.${name}`, title: "Figma", configObjectId: "test", versionId: null, updatedAt: null }] } };
  // A static token alone is not interpreted as an approved OAuth registration.
  const approved = { ...owned, current: { [name]: { type: "remote", url: "https://mcp.figma.com/mcp", disabled: false, oauth: { client_id: "approved-legalwork-client", client_secret: "private" } } } };
  const remote = provider();
  const checked = await preparePluginImport(imported, approved, { fetch: async (url, init) => fetch(String(url).replace("https://mcp.figma.com", new URL(remote.url).origin), init) });
  expect(checked.preview.connectors?.[0]?.status).toBe("setup");
  expect(checked.preview.components).toHaveLength(2);
  expect(JSON.stringify(checked.preview)).not.toContain("private");
  expect(JSON.stringify(checked.resolved.plugin.connectorDefaults)).not.toContain("private");
  expect(() => reviewedPluginImport(imported, { ...approved, current: {} }, checked.preview.validationId)).toThrow("review expired");
});

test("rechecking a prepared client preserves its identity without a second registration", async () => {
  const remote = provider({ dcr: true });
  const imported = await plan({ remote: { url: remote.url } });
  const [first, duplicate] = await Promise.all([preparePluginImport(imported, target), preparePluginImport(imported, target)]);
  expect(remote.registrations()).toBe(1);
  expect(first.preview.validationId).toBe(duplicate.preview.validationId);
  const rechecked = await preparePluginImport(imported, target, {}, true);
  expect(rechecked.preview.validationId).not.toBe(first.preview.validationId);
  expect(remote.registrations()).toBe(1);
  expect(() => reviewedPluginImport(imported, target, first.preview.validationId)).toThrow("review expired");
  expect(reviewedPluginImport(imported, target, rechecked.preview.validationId).preview.connectors?.[0]?.status).toBe("setup");
});

test("a narrower explicit scope is kept while credentials embedded in an address are not transmitted", async () => {
  const remote = provider({ dcr: true });
  const narrowed = await preparePluginImport(await plan({ remote: { url: remote.url, oauth: { scope: "read" } } }), target);
  expect(narrowed.preview.connectors?.[0]).toMatchObject({ status: "setup", code: "sign_in" });
  expect(remote.registrations()).toBe(1);
  expect(remote.metadata()).toMatchObject({ scope: "read" });
  const credentialUrl = await preparePluginImport(await plan({ remote: { url: "https://example.com/mcp?api_key=source-private-key" } }), target, { fetch: async () => { throw new Error("Credential address must not be transmitted during import"); } });
  expect(credentialUrl.preview.connectors?.[0]).toMatchObject({ status: "setup", code: "address_credentials" });
  expect(JSON.stringify(credentialUrl.preview)).not.toContain("source-private-key");
});

test("the import API enforces server-owned review and persists partial-package exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "import-check-api-"));
  const previousDb = process.env.LEGALWORK_RUNTIME_DB;
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 0 }, corsOrigins: [], workspaces: [{ id: "test", name: "Test", path: root, preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  const server = await startServer(config);
  const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
  const base = `http://127.0.0.1:${server.port}/workspace/test/plugin-imports`;
  try {
    const payload = request({ remote: { type: "ws", url: "https://example.com/mcp" } });
    const preview = await (await fetch(`${base}/preview`, { method: "POST", headers, body: JSON.stringify(payload) })).json();
    const reviewed = preview.items[0];
    expect(reviewed.connectors[0].status).toBe("blocked");
    const forged = await fetch(`${base}/install`, { method: "POST", headers, body: JSON.stringify({ ...payload, root: reviewed.root, digest: reviewed.digest, validationId: "forged" }) });
    expect(forged.status).toBe(409);
    const installed = await fetch(`${base}/install`, { method: "POST", headers, body: JSON.stringify({ ...payload, root: reviewed.root, digest: reviewed.digest, validationId: reviewed.validationId, acknowledgePartial: true }) });
    expect(installed.status).toBe(200);
    const record = await installed.json();
    expect(record.item.files.some((file: { objectType: string }) => file.objectType === "mcp")).toBe(false);
    expect(record.item.excludedConnectors[0].name).toBe("remote");
    expect((await readInstalledCloudPlugins(config, "test")).plugins[record.item.pluginId]?.excludedConnectors?.[0]?.name).toBe("remote");
    expect((await readRuntimeOpencodeConfig(config, "test")).mcp ?? {}).toEqual({});
    const only = request({ remote: { type: "ws", url: "https://example.com/mcp" } }, "claude", false);
    const onlyPreview = await (await fetch(`${base}/preview`, { method: "POST", headers, body: JSON.stringify(only) })).json();
    const blocked = await fetch(`${base}/install`, { method: "POST", headers, body: JSON.stringify({ ...only, root: onlyPreview.items[0].root, digest: onlyPreview.items[0].digest, validationId: onlyPreview.items[0].validationId }) });
    expect(blocked.status).toBe(400);
  } finally {
    await server.stop();
    if (previousDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});


test("operator-owned metadata identities validate the exact callback and never trigger DCR", async () => {
  const remote = provider({ dcr: true, cimd: true });
  const identity = "https://legalwork.example/oauth/client.json";
  const redirectUri = "http://127.0.0.1:19876/mcp/oauth/callback";
  const imported = await plan({ metadata: { url: remote.url } });
  const options = (callback: string) => ({ clientMetadataUrl: identity, fetch: (input: string | URL | Request, init?: RequestInit) => String(input) === identity ? Promise.resolve(Response.json({ client_id: identity, client_name: "LegalWork", redirect_uris: [callback], token_endpoint_auth_method: "none" })) : fetch(input, init) });
  const valid = await preparePluginImport(imported, target, options(redirectUri), true);
  expect(valid.preview.connectors?.[0]).toMatchObject({ status: "setup", code: "sign_in" });
  expect(remote.registrations()).toBe(0);
  const invalid = await preparePluginImport(imported, target, options("https://other-app.example/callback"), true);
  expect(invalid.preview.connectors?.[0]).toMatchObject({ status: "blocked", code: "client_metadata" });
  expect(remote.registrations()).toBe(0);
});


test("portable HTTP declarations do not silently install an SSE fallback", async () => {
  const remote = provider({ legacySse: true, dcr: true });
  const imported = await plan({ remote: { type: "http", url: remote.url } });
  imported.preview.connectors![0].declaredTransport = "streamable-http";
  const checked = await preparePluginImport(imported, target);
  expect(checked.preview.connectors?.[0]).toMatchObject({ status: "blocked", code: "transport_mismatch" });
  expect(remote.registrations()).toBe(0);
});
