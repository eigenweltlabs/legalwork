import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { startServer } from "../server.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { writeConnectorConnections } from "../connectors/store.js";
import { saveConnectorWriteSetting } from "../connectors/settings.js";
import { savedConnectorStatus } from "../connectors/broker.js";
import { StorageStore } from "./store.js";
import { storageInputSchema } from "./schema.js";
import { connectorRuntimeCapability } from "../connectors/capability.js";
import { ConnectorStorageAccounts } from "./connector-accounts.js";
import { updateProjectRemote, readProjectDetails } from "../project-store.js";
import { connectionFingerprint, ProjectFolderBindings } from "./project-folders.js";
import { TeamStorage } from "./team.js";
import { withStorage } from "./service.js";
import type { StoredStorage } from "./store.js";
import { nativeSegment } from "./native-drive.js";

const nativeFetch = globalThis.fetch;
const keys = ["EIGENWELT_PLATFORM_URL", "LEGALWORK_TOKEN_STORE", "LEGALWORK_RUNTIME_DB", "LEGALWORK_ENV_STORE", "LEGALWORK_STORAGE_STORE", "LEGALWORK_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"];
const prior = new Map(keys.map((key) => [key, process.env[key]]));
const owner = JSON.stringify(["https://storage-broker.test", "firm", "alice"]);
let root: string, config: ServerConfig, base: string;
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let calls: string[];
const googleRoot = { id: "root", name: "Drive", mimeType: "application/vnd.google-apps.folder", parents: [], version: "1" };
const account = { id: "cloud-account", nangoConnectionId: "fixture-capability", createdAt: "2026-10-01T00:00:00Z", needsReconnect: false };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage-account-tests-"));
  for (const key of keys) process.env[key] = key === "EIGENWELT_PLATFORM_URL" ? "https://storage-broker.test" : join(root, key);
  const workspace = join(root, "project"); await mkdir(workspace);
  config = { host: "127.0.0.1", port: 0, token: "fixture-owner", hostToken: "fixture-host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "project", name: "Project", path: workspace, workspaceType: "local", preset: "default" }], authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await writeEigenweltConnection(config, { platformToken: "fixture-platform-token", platformURL: "https://storage-broker.test", account: { userId: "alice", userName: "Alice", userEmail: "alice@example.test", orgId: "firm", orgName: "Firm" } });
  await writeConnectorConnections(config, owner, "google-drive", [account]); calls = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    calls.push(url.pathname);
    if (url.pathname.endsWith("/connection/status")) return Response.json({ connection: { id: account.nangoConnectionId, createdAt: account.createdAt, needsReconnect: false } });
    if (url.pathname.endsWith("/connection/token")) return Response.json({ accessToken: "fixture-provider-token", expiresAt: null });
    if (url.hostname === "www.googleapis.com") return url.pathname.endsWith("/drives") ? Response.json({ drives: [] }) : url.pathname.endsWith("/files") ? Response.json({ files: [] }) : Response.json(googleRoot, { headers: { etag: '"root-version"' } });
    return Response.json({}, { status: 404 });
  }, { preconnect: nativeFetch.preconnect });
});
afterEach(async () => {
  await server?.stop(); server = undefined; globalThis.fetch = nativeFetch;
  for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});
async function serve() { server = await startServer(config); base = `http://127.0.0.1:${server.port}`; }
function scopedToken(scope: "viewer" | "collaborator") {
  return scope === "viewer" ? "owt_retired_viewer" : config.token;
}
async function api(path: string, token?: string, body?: unknown) {
  return nativeFetch(`${base}/workspace/project/storage${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token ?? config.token}`, "Content-Type": "application/json", ...(token === undefined ? { "x-legalwork-host-token": config.hostToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("saved account status and root discovery never request Nango status or tokens", async () => {
  const status = await savedConnectorStatus(config, "google-drive"); expect(status.connectors[0].connections[0].id).toBe(account.id); expect(calls).toHaveLength(0);
  await serve(); calls.length = 0;
  for (let poll = 0; poll < 3; poll++) {
    const response = await api("/roots"); expect(response.status).toBe(200);
    const data = z.object({ roots: z.array(z.object({ id: z.string(), writable: z.boolean(), provider: z.string().optional() })) }).parse(await response.json());
    expect(data.roots).toContainEqual(expect.objectContaining({ id: `connector:google-drive:${account.id}`, writable: false, provider: "google-drive" }));
  }
  expect(calls.some((path) => path.startsWith("/api/connectors"))).toBe(false);
});

test("the managed agent storage routes search and read a shared-drive-only file using the existing account", async () => {
  const priorFetch = globalThis.fetch;
  const company = { ...googleRoot, id: "company-root", name: "Example company", driveId: "company-root" };
  const sharedFile = { id: "company-document", name: "Company-only contract.txt", mimeType: "text/plain", parents: [company.id], driveId: company.id, version: "1" };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "www.googleapis.com") return priorFetch(input, init);
    if (url.pathname.endsWith("/drives")) return Response.json({ drives: [{ id: company.id, name: company.name }] });
    if (url.pathname.endsWith("/files")) return Response.json({ files: url.searchParams.get("corpora") === "drive" ? [sharedFile] : [] });
    if (url.searchParams.get("alt") === "media") return new Response("Shared company contract");
    return Response.json(url.pathname.endsWith(`/${sharedFile.id}`) ? sharedFile : url.pathname.endsWith(`/${company.id}`) ? company : googleRoot, { headers: { etag: '"fixture-version"' } });
  }, { preconnect: nativeFetch.preconnect });
  await serve();
  const id = encodeURIComponent(`connector:google-drive:${account.id}`);
  const headers = { Authorization: `Bearer ${config.token}`, "x-legalwork-connector-token": connectorRuntimeCapability(config), "Content-Type": "application/json" };
  const filenameResult = await nativeFetch(`${base}/workspace/project/storage/${id}/filename-search`, { method: "POST", headers, body: JSON.stringify({ query: "Company-only", match: "path" }) });
  expect(filenameResult.status).toBe(200);
  const page = z.object({ entries: z.array(z.object({ id: z.string(), path: z.string() })), complete: z.boolean() }).parse(await filenameResult.json());
  expect(page.entries[0]?.id).toBe(sharedFile.id); expect(page.complete).toBe(true);
  expect(page.entries[0]?.path).toContain(nativeSegment(company));
  const content = await nativeFetch(`${base}/workspace/project/storage/${id}/file?${new URLSearchParams({ path: page.entries[0]!.path })}`, { headers });
  expect(content.status).toBe(200);
  const parentPath = page.entries[0]!.path.split("/").slice(0, -1).join("/");
  const write = await nativeFetch(`${base}/workspace/project/storage/${id}/folders`, { method: "POST", headers, body: JSON.stringify({ path: `${parentPath}/New folder` }) });
  expect(write.status).toBe(403);
  const locations = await nativeFetch(`${base}/connectors/google-drive/storage-locations?${new URLSearchParams({ connectionId: account.id, kind: "drives" })}`, { headers: { Authorization: `Bearer ${config.token}`, "x-legalwork-host-token": config.hostToken } });
  expect(locations.status).toBe(200);
  expect(await locations.json()).toEqual({ drives: [{ id: company.id, name: company.name }], nextPageToken: null });
  expect((await savedConnectorStatus(config, "google-drive")).connectors[0].connections).toHaveLength(1);
});

test("write settings stay default-off and folder views reuse one saved account", async () => {
  const bridge = new ConnectorStorageAccounts(config); const first = await bridge.list("project"); expect(first[0].readOnly).toBe(true);
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true }); expect((await bridge.list("project"))[0].readOnly).toBe(false);
  const store = new StorageStore(config); await store.save("project", storageInputSchema.parse({ name: "Subfolder", config: { kind: "oauth", provider: "google-drive", accountId: account.id, root: "folder" }, readOnly: true }));
  expect((await savedConnectorStatus(config, "google-drive")).connectors[0].connections).toHaveLength(1); expect(calls).toHaveLength(0);
});

test("personal roots and every generic read/write path remain owner-only", async () => {
  await serve();
  const id = encodeURIComponent(`connector:google-drive:${account.id}`);
  expect((await api("/roots", scopedToken("viewer"))).status).toBe(401);
  const scopes: ("collaborator")[] = ["collaborator"];
  for (const scope of scopes) {
    const token = await scopedToken(scope);
    const roots = z.object({ roots: z.array(z.object({ id: z.string() })) }).parse(await (await api("/roots", token)).json()); expect(roots.roots).toHaveLength(0);
    for (const suffix of ["/capabilities", "/children", "/search?mode=content&query=test", "/file?path=File.txt"]) expect((await api(`/${id}${suffix}`, token)).status).toBe(403);
    for (const entry of [{ suffix: "/checkout", body: { path: "File.txt" } }, { suffix: "/filename-search", body: { query: "test" } }, { suffix: "/folders", body: { path: "Folder" } }, { suffix: "/local-copy", body: { localPath: "File.txt", targetPath: "Copy.txt" } }]) expect((await api(`/${id}${entry.suffix}`, token, entry.body)).status).toBe(403);
  }
  expect(calls.some((path) => path.startsWith("/drive") || path.startsWith("/api/connectors"))).toBe(false);
});

test("a bound project link cannot bypass personal-account isolation", async () => {
  const bridge = new ConnectorStorageAccounts(config); const connection = (await bridge.list("project"))[0];
  const folder = { id: "00000000-0000-4000-8000-000000000001", connectionId: connection.id, connectionName: connection.name, connectionFingerprint: connectionFingerprint(connection), folder: { path: "", id: "root", name: "Drive", namespace: `google-drive:${account.id}:root` } };
  const workspace = config.workspaces[0]; const details = await readProjectDetails(workspace.path);
  await updateProjectRemote(workspace.path, { version: 1, folders: [folder], initialization: "ready" }, details.revision);
  await new ProjectFolderBindings(new StorageStore(config).path).save(workspace.id, folder, workspace.id);
  await serve(); const token = await scopedToken("collaborator"); calls.length = 0;
  expect((await api(`/project%3A${folder.id}/children`, token)).status).toBe(403);
  const response = await nativeFetch(`${base}/workspace/project/project/remote-folders`, { headers: { Authorization: `Bearer ${token}` } });
  const result = z.object({ folders: z.array(z.object({ status: z.string() })) }).parse(await response.json()); expect(result.folders[0].status).toBe("denied");
  expect(calls.some((path) => path.startsWith("/drive") || path.startsWith("/api/connectors"))).toBe(false);
});

test("a switched Eigenwelt account cannot inherit a saved cloud folder view", async () => {
  const input = storageInputSchema.parse({ name: "Drive", config: { kind: "oauth", provider: "google-drive", accountId: account.id, root: "" } });
  await writeEigenweltConnection(config, { platformToken: "bob-platform", platformURL: "https://storage-broker.test", account: { userId: "bob", userName: "Bob", userEmail: "bob@example.test", orgId: "firm", orgName: "Firm" } });
  const bridge = new ConnectorStorageAccounts(config); expect(await bridge.list("project")).toHaveLength(0);
  await expect(bridge.validate(input)).rejects.toMatchObject({ code: "storage_disconnected" }); expect(calls).toHaveLength(0);
});

test("sharing a member location removes the personal handle and makes no Nango request", async () => {
  const priorFetch = globalThis.fetch;
  let published: unknown;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/storage-connections" && init?.method === "POST") {
      published = JSON.parse(String(init.body)); return Response.json({ connection: { id: "af506b2e-82eb-40cd-936a-fef613abc765" } });
    }
    return priorFetch(input, init);
  }, { preconnect: nativeFetch.preconnect });
  await serve(); calls.length = 0;
  const response = await nativeFetch(`${base}/workspace/project/storage/team`, { method: "POST", headers: { "x-legalwork-host-token": config.hostToken, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Drive", config: { kind: "oauth", provider: "google-drive", accountId: account.id, root: "", sharingMode: "member" } }) });
  expect(response.status).toBe(201);
  expect(published).toMatchObject({ config: { provider: "google-drive", sharingMode: "member" }, secrets: {} });
  expect(JSON.stringify(published)).not.toContain(account.id);
  expect(calls.some(path => path.startsWith("/api/connectors"))).toBe(false);
});


test("the owner's managed agent can use generic storage while ordinary collaborators cannot", async () => {
  await serve(); const capability = connectorRuntimeCapability(config);
  const headers = { Authorization: `Bearer ${config.token}`, "x-legalwork-connector-token": capability };
  const roots = z.object({ roots: z.array(z.object({ id: z.string() })) }).parse(await (await nativeFetch(`${base}/workspace/project/storage/roots`, { headers })).json());
  expect(roots.roots).toHaveLength(1);
  const response = await nativeFetch(`${base}/workspace/project/storage/${encodeURIComponent(roots.roots[0].id)}/children`, { headers }); expect(response.status).toBe(200);
  expect(calls).toContain("/api/connectors/google-drive/connection/token");
  const viewer = await scopedToken("viewer");
  expect((await nativeFetch(`${base}/workspace/project/storage/${encodeURIComponent(roots.roots[0].id)}/children`, { headers: { Authorization: `Bearer ${viewer}`, "x-legalwork-connector-token": capability } })).status).toBe(401);
});

test("own OAuth storage remains available without Eigenwelt sign-in and creates no second grant", async () => {
  const { OAuthVault, oauthVaultPath } = await import("./oauth/vault.js");
  const { connectorOAuthClientInputSchema, connectorConnectionSchema } = await import("../connectors/schema.js");
  const vault = new OAuthVault(oauthVaultPath(config));
  const stateSchema = z.object({ client: connectorOAuthClientInputSchema, revision: z.string(), connections: z.array(connectorConnectionSchema.extend({ readOnly: z.boolean(), authorizedWrites: z.array(z.string()), grantKey: z.string() })) });
  const grant = "synthetic-own-oauth-grant";
  await vault.setEntry(JSON.stringify(["connector-oauth-app", "google-drive"]), stateSchema, { client: { clientId: "synthetic-client", tenantId: "" }, revision: "revision", connections: [{ id: "own-account", source: "custom", createdAt: null, needsReconnect: false, readOnly: true, authorizedWrites: [], grantKey: grant }] });
  await vault.set(grant, { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600_000 });
  await writeEigenweltConnection(config, { platformURL: "https://storage-broker.test", platformToken: null, refreshToken: null, account: null });
  const bridge = new ConnectorStorageAccounts(config); const roots = await bridge.list("project"); expect(roots[0].config).toMatchObject({ accountId: "own-account", provider: "google-drive" });
  await bridge.validate(roots[0]); expect(calls).toHaveLength(0);
  await serve(); const response = await api(`/${encodeURIComponent(roots[0].id)}/children`); expect(response.status).toBe(200);
  expect(calls.some((path) => path.startsWith("/api/connectors"))).toBe(false);
  expect((await savedConnectorStatus(config, "google-drive")).connectors[0].connections).toHaveLength(1);
});


function sharedCloud(mode: "team" | "member"): StoredStorage {
  return { ...storageInputSchema.parse({ name: "Firm drive", config: { kind: "oauth", provider: "google-drive", root: "", sharingMode: mode }, readOnly: false }),
    id: "team:af506b2e-82eb-40cd-936a-fef613abc765", workspaceId: "project", updatedAt: 1,
    team: { orgId: "firm", version: 1, installed: true } };
}
test("shared accounts use a team token without looking up the server owner's personal account", async () => {
  const item = sharedCloud("team"), team = new TeamStorage(config);
  team.list = async () => ({ connections: [item], status: { connected: true, canManage: false } });
  let tokens = 0;
  team.accessToken = async (_workspace, id, version) => { expect(id).toBe(item.id); expect(version).toBe(1); tokens++; return "shared-storage-access"; };
  const bound = await new ConnectorStorageAccounts(config, team).bind(item);
  const adapter = await withStorage(bound, async adapter => { await adapter.list(""); return adapter; });
  expect(tokens).toBe(1); expect(calls.some(path => path.startsWith("/api/connectors"))).toBe(false);
  item.enabled = false;
  await expect(adapter.list("")).rejects.toMatchObject({ code: "storage_team_unavailable" });
});
test("member locations reuse the sole personal account and preserve default-off write control", async () => {
  const item = sharedCloud("member"), team = new TeamStorage(config);
  const bound = await new ConnectorStorageAccounts(config, team).bind(item);
  expect(bound.readOnly).toBe(true);
  await withStorage(bound, async adapter => {
    expect((await adapter.list("")).entries.map(entry => entry.name)).toContain("Shared drives");
    await expect(adapter.mkdir("Unsafe")).rejects.toMatchObject({ code: "connector_writes_disabled" });
  });
  expect(calls).toContain("/api/connectors/google-drive/connection/token");
  expect((await savedConnectorStatus(config, "google-drive")).connectors[0].connections).toHaveLength(1);
});
test("unconnected member locations stay visible without looking up Nango accounts", async () => {
  await writeConnectorConnections(config, owner, "google-drive", []);
  const item = await new ConnectorStorageAccounts(config, new TeamStorage(config)).bind(sharedCloud("member"));
  await expect(withStorage(item, adapter => adapter.list(""))).rejects.toMatchObject({ code: "storage_signin_required" });
  expect(calls).toHaveLength(0);
});


test("binding a cached team location never overwrites its admin write policy", async () => {
  const item = sharedCloud("member"), bridge = new ConnectorStorageAccounts(config, new TeamStorage(config));
  expect((await bridge.bind(item)).readOnly).toBe(true);
  expect(item.readOnly).toBe(false);
  await saveConnectorWriteSetting(config, "google-drive", { writeAccess: true });
  expect((await bridge.bind(item)).readOnly).toBe(false);
});
