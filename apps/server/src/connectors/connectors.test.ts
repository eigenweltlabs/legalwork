import { bootstrapRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { prepareConnectorStorage } from "./store.js";
import { recordConnectorActivation, saveConnectorWriteSetting } from "./settings.js";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { connectorDefinitions, connectorIsConnected } from "@legalwork/types/connectors";
import type { ServerConfig } from "../types.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { callExperimentalExtensionAction, listExperimentalExtensionActions } from "../extensions/index.js";
import { connectorStatus, createConnectorFlows, disconnectConnector, connectorAccessToken, listConnectorConnections, setConnectorActivation } from "./broker.js";
import { readConnectorConnections, readConnectorState, writeConnectorConnections as persistConnectorConnections } from "./store.js";
import { OAuthVault, oauthVaultPath } from "../file-storage/oauth/vault.js";
import { openSqlite } from "../runtime-db.js";
import { createConnectorRequest } from "./request.js";
import { gmailAdapter, outlookAdapter, mailDraftInput, mailListInput } from "./mail.js";
import { startServer } from "../server.js";
import { EnvService } from "../env-file.js";
import { connectorRuntimeCapability } from "./capability.js";
import { applyMailOrganization, previewMailOrganization, listMailContainers, createMailContainer, mailContainerCreateInput, mailContainersInput, mailOrganizeInput } from "./mail-organization.js";

// Fixture accounts use a known capability unless a privacy test supplies one explicitly.
const writeConnectorConnections = (config: ServerConfig, owner: string, id: string,
  connections: { id: string; createdAt: string | null; needsReconnect: boolean; nangoConnectionId?: string }[]) =>
  persistConnectorConnections(config, owner, id, connections.map((connection) => ({ ...connection, nangoConnectionId: connection.nangoConnectionId ?? connection.id })));

const nativeFetch = globalThis.fetch;
const nativeWebSocket = globalThis.WebSocket;
class AuthSocket extends EventTarget {
  constructor(url: string) {
    super(); expect(url).toBe("wss://api.nango.dev/");
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ message_type: "connection_ack", ws_client_id: "socket-id" }) }));
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ message_type: "success", provider_config_key: "google-mail", connection_id: connection.id }) }));
    });
  }
  close() { this.dispatchEvent(new Event("close")); }
}

const priorPlatform = process.env.EIGENWELT_PLATFORM_URL;
const priorTokenStore = process.env.LEGALWORK_TOKEN_STORE;
const priorRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
let root: string;
let config: ServerConfig;
let response: (url: URL, init?: RequestInit) => Response | Promise<Response>;
const requests: { url: URL; init?: RequestInit }[] = [];
const connection = { id: "mail-account", createdAt: "2026-10-13T10:00:00Z", needsReconnect: false };
const localOwner = JSON.stringify(["https://broker.test", "firm", "alice"]);
let connections = [connection];
const stops: (() => void | Promise<void>)[] = [];

const downloadedAttachment = z.object({ path: z.string(), relativePath: z.string(), filename: z.string(), mimeType: z.string().nullable(), size: z.number() });

function attachmentFixture(provider: "gmail" | "outlook", bytes: Buffer, filename = "Contract.pdf") {
  config.workspaces = [{ id: "project", path: root, name: "Project", preset: "starter", workspaceType: "local" }];
  config.authorizedRoots = [root];
  const previous = response;
  response = (url, init) => {
    if (url.hostname !== (provider === "gmail" ? "gmail.googleapis.com" : "graph.microsoft.com")) return previous(url, init);
    if (!url.pathname.includes("/attachments/")) return Response.json({ id: "message", payload: { parts: [
      { filename, mimeType: "application/pdf", body: { attachmentId: "attachment", size: bytes.length } },
    ] } });
    if (provider === "outlook" && !url.pathname.endsWith("/$value")) return Response.json({
      "@odata.type": "#microsoft.graph.fileAttachment", name: filename, contentType: "application/pdf", size: bytes.length,
      ...(url.searchParams.has("$select") ? {} : { contentBytes: bytes.toString("base64") }),
    });
    const content = provider === "gmail" ? Buffer.from(JSON.stringify({ data: bytes.toString("base64url"), ...(url.searchParams.get("fields") === "data" ? {} : { size: bytes.length }) })) : bytes;
    let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (offset === content.length) { controller.close(); return; }
      const end = Math.min(offset + 16_381, content.length);
      controller.enqueue(content.subarray(offset, end)); offset = end;
    } }), { headers: { "Content-Type": provider === "gmail" ? "application/json" : "application/pdf" } });
  };
}

async function downloadAttachment(provider: "gmail" | "outlook", context: Record<string, unknown> = { directory: root }, attachmentId = "attachment") {
  if (provider === "outlook") await recordConnectorActivation(config, provider, connection.id, true);
  return callExperimentalExtensionAction(config, new EnvService({ path: join(root, "env.json") }), {
    extensionId: provider, action: "get_attachment", args: { messageId: "message", attachmentId }, context,
  }, { personalConnections: true });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-connectors-"));
  config = { host: "127.0.0.1", port: 0, token: "local-owner", hostToken: "local-host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  process.env.EIGENWELT_PLATFORM_URL = "https://broker.test";
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  await bootstrapRuntimeOpencodeConfig(config);
  await prepareConnectorStorage(config);
  await writeEigenweltConnection(config, { platformToken: "platform-access", platformURL: "https://broker.test",
    account: { userId: "alice", userName: "Alice", userEmail: "alice@example.com", orgId: "firm", orgName: "Firm" } });
  await writeConnectorConnections(config, localOwner, "gmail", [connection]);
  await writeConnectorConnections(config, localOwner, "outlook", [connection]);
  connections = [connection]; requests.length = 0;
  Object.defineProperty(globalThis, "WebSocket", { value: AuthSocket, configurable: true, writable: true });
  response = (url, init) => {
    if (url.hostname === "broker.test") {
      if (url.pathname === "/api/connectors") return Response.json({ configured: true, providers: [{ id: "gmail" }, { id: "outlook" }] });
      if (url.pathname.endsWith("/connection/status")) {
        const input = z.object({ connectionId: z.string() }).parse(JSON.parse(String(init?.body)));
        const item = connections.find((entry) => entry.id === input.connectionId);
        return item ? Response.json({ connection: item }) : Response.json({}, { status: 404 });
      }
      if (url.pathname.endsWith("/disconnect")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/token")) {
        const input = z.object({ forceRefresh: z.boolean() }).parse(typeof init?.body === "string" ? JSON.parse(init.body) : {});
        return Response.json({ accessToken: input.forceRefresh ? "refreshed-mail-token" : "mail-token", expiresAt: null });
      }
      if (url.pathname.endsWith("/connect") || url.pathname.endsWith("/reconnect")) return Response.json({ sessionToken: "short-lived", integrationId: "google-mail", expiresAt: Date.now() + 60_000 });
    }
    return Response.json({ emailAddress: "alice@example.com" });
  };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    requests.push({ url, init });
    return response(url, init);
  }, { preconnect: nativeFetch.preconnect });
});

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  globalThis.fetch = nativeFetch;
  Object.defineProperty(globalThis, "WebSocket", { value: nativeWebSocket, configurable: true, writable: true });
  const restore: [string, string | undefined][] = [["EIGENWELT_PLATFORM_URL", priorPlatform], ["LEGALWORK_TOKEN_STORE", priorTokenStore], ["LEGALWORK_RUNTIME_DB", priorRuntimeDb]];
  for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test("registers discoverable tools for both mail providers", () => {
  for (const id of ["gmail", "outlook"]) {
    expect(listExperimentalExtensionActions(id).map((item) => item.action)).toEqual(["status", "test_connection", "list_messages", "get_message", "get_attachment", "create_draft", "send_draft", ...(id === "gmail" ? ["list_labels", "create_label"] : ["list_folders", "create_folder", "list_categories", "create_category"]), "preview_organize_messages", "apply_organization"]);
  }
});

async function gmailOrganizationFixture() {
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  const state = { labels: ["INBOX", "UNREAD", "keep"], identity: "alice@example.com", writes: 0, fail: false };
  const previous = response;
  response = (url, init) => {
    if (url.hostname !== "gmail.googleapis.com") return previous(url, init);
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: state.identity });
    if (url.pathname.endsWith("/labels")) return Response.json({ labels: [{ id: "matter", name: "Clients/Müller", type: "user" }, { id: "keep", name: "Keep", type: "user" }] });
    if (init?.method === "POST") { state.writes++; return state.fail ? new Response(null, { status: 500 }) : Response.json({ id: "message" }); }
    return Response.json({ id: "message", labelIds: state.labels, payload: { headers: [{ name: "Subject", value: "Contract review" }] } });
  };
  return state;
}

test("Gmail previews without writes, then files the exact message once while preserving other labels", async () => {
  const state = await gmailOrganizationFixture();
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: false });
  const plan = await previewMailOrganization(config, "gmail", { messageIds: ["message"], addLabelIds: ["matter"], archive: true, isRead: true, starred: true });
  expect(plan.messages[0].subject).toBe("Contract review");
  expect(plan.destination).toEqual([{ id: "matter", name: "Clients/Müller", type: "user" }]);
  expect(state.writes).toBe(0);
  await expect(callExperimentalExtensionAction(config, new EnvService({ path: join(root, "env.json") }), { extensionId: "gmail", action: "apply_organization", args: { planId: plan.planId } }, { personalConnections: true })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  const result = await applyMailOrganization(config, "gmail", { planId: plan.planId });
  expect(result.applied).toBe(1);
  const write = requests.find((item) => item.url.pathname.endsWith("/modify"));
  expect(JSON.parse(String(write?.init?.body))).toEqual({ addLabelIds: ["matter", "STARRED"], removeLabelIds: ["INBOX", "UNREAD"] });
  expect(state.writes).toBe(1);
  await expect(applyMailOrganization(config, "gmail", { planId: plan.planId })).rejects.toMatchObject({ code: "connector_organization_preview_required" });
  expect(requests.filter((item) => item.url.hostname === "broker.test").every((item) => !String(item.init?.body).includes("Contract review"))).toBe(true);
});

test("organization plans reject concurrent replay, changed labels, account replacement and expiration", async () => {
  const state = await gmailOrganizationFixture();
  const input = { messageIds: ["message"], archive: true };
  let plan = await previewMailOrganization(config, "gmail", input);
  const concurrent = await Promise.allSettled([applyMailOrganization(config, "gmail", { planId: plan.planId }), applyMailOrganization(config, "gmail", { planId: plan.planId })]);
  expect(concurrent.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(state.writes).toBe(1);
  plan = await previewMailOrganization(config, "gmail", input);
  state.labels.push("external-change");
  expect((await applyMailOrganization(config, "gmail", { planId: plan.planId })).results[0]).toMatchObject({ status: "failed", code: "connector_message_changed" });
  expect(state.writes).toBe(1);
  plan = await previewMailOrganization(config, "gmail", input);
  state.identity = "other@example.com";
  await expect(applyMailOrganization(config, "gmail", { planId: plan.planId })).rejects.toMatchObject({ code: "connector_organization_preview_required" });
  plan = await previewMailOrganization(config, "gmail", input);
  const clock = spyOn(Date, "now").mockReturnValue(plan.expiresAt + 1);
  try { await expect(applyMailOrganization(config, "gmail", { planId: plan.planId })).rejects.toMatchObject({ code: "connector_organization_preview_required" }); }
  finally { clock.mockRestore(); }
  expect(state.writes).toBe(1);
});

test("ambiguous organization writes report uncertainty once and cannot be replayed", async () => {
  const state = await gmailOrganizationFixture();
  const plan = await previewMailOrganization(config, "gmail", { messageIds: ["message"], archive: true });
  state.fail = true;
  const result = await applyMailOrganization(config, "gmail", { planId: plan.planId });
  expect(result.uncertain).toBe(1);
  expect(state.writes).toBe(1);
  await expect(applyMailOrganization(config, "gmail", { planId: plan.planId })).rejects.toMatchObject({ code: "connector_organization_preview_required" });
});

test("one write permission protects every mailbox mutation and is checked again after token refresh", async () => {
  const env = new EnvService({ path: join(root, "env.json") });
  await expect(callExperimentalExtensionAction(config, env, { extensionId: "gmail", action: "create_label", args: { name: "Matter" } }, { personalConnections: true })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests).toHaveLength(0);
  await expect(callExperimentalExtensionAction(config, env, { extensionId: "gmail", action: "create_draft", args: {} }, { personalConnections: true })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  let writes = 0;
  const previous = response;
  response = async (url, init) => {
    if (url.hostname !== "gmail.googleapis.com") return previous(url, init);
    writes++;
    await saveConnectorWriteSetting(config, "gmail", { writeAccess: false });
    return new Response(null, { status: 401 });
  };
  const request = await createConnectorRequest(config, "gmail");
  await expect(request("/gmail/v1/users/me/labels", { method: "POST", organize: true, body: { name: "Matter" } })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(writes).toBe(1);
  config.readOnly = true;
  await expect(callExperimentalExtensionAction(config, env, { extensionId: "gmail", action: "create_label", args: { name: "Matter" } }, { personalConnections: true })).rejects.toMatchObject({ code: "read_only" });
});

test("Outlook organization preserves existing categories, uses versions and stable IDs, and reports partial writes", async () => {
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await setConnectorActivation(config, "outlook", connection.id, true);
  let moveStatus = 201;
  const previous = response;
  response = (url, init) => {
    if (url.hostname !== "graph.microsoft.com") return previous(url, init);
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (url.pathname.includes("/masterCategories")) return Response.json({ value: [{ id: "tag", displayName: "Matter", color: "preset0" }] });
    if (url.pathname.includes("/mailFolders/")) return Response.json({ id: "destination", displayName: "Müller" });
    if (url.pathname.endsWith("/move")) return moveStatus === 201 ? Response.json({ id: "moved" }, { status: 201 }) : new Response(null, { status: moveStatus });
    return Response.json({ id: "message", subject: "Contract", parentFolderId: "inbox", categories: ["Keep", "Remove"], isRead: false, changeKey: "v1", "@odata.etag": 'W/"v1"' });
  };
  const input = { messageIds: ["message"], destinationFolderId: "destination", addCategories: ["Matter"], removeCategories: ["Remove"], isRead: true, flagged: true };
  let plan = await previewMailOrganization(config, "outlook", input);
  const result = await applyMailOrganization(config, "outlook", { planId: plan.planId });
  expect(result.results[0]).toEqual({ messageId: "message", currentMessageId: "moved", status: "applied" });
  const patch = requests.find((item) => item.init?.method === "PATCH");
  expect(JSON.parse(String(patch?.init?.body))).toEqual({ categories: ["Keep", "Matter"], isRead: true, flag: { flagStatus: "flagged" } });
  expect(new Headers(patch?.init?.headers).get("If-Match")).toBe('W/"v1"');
  expect(new Headers(patch?.init?.headers).get("Prefer")).toBe('IdType="ImmutableId"');
  moveStatus = 403;
  plan = await previewMailOrganization(config, "outlook", input);
  expect((await applyMailOrganization(config, "outlook", { planId: plan.planId })).partial).toBe(1);
  moveStatus = 500;
  plan = await previewMailOrganization(config, "outlook", input);
  expect((await applyMailOrganization(config, "outlook", { planId: plan.planId })).uncertain).toBe(1);
});

test("Gmail sublabels use the parent name, while system parents and pagination endpoint changes are rejected", async () => {
  let writePath = "";
  await createMailContainer("gmail", async (path, options) => {
    if (!options?.method) return { id: "parent", name: "Clients", type: "user" };
    writePath = path;
    expect(options.body).toMatchObject({ name: "Clients/Müller" });
    expect(options.organize).toBe(true);
    return { id: "child", name: "Clients/Müller", type: "user" };
  }, mailContainerCreateInput.parse({ name: "Müller", parentId: "parent" }));
  expect(writePath).toBe("/gmail/v1/users/me/labels");
  await expect(createMailContainer("gmail", async () => ({ id: "INBOX", name: "INBOX", type: "system" }), mailContainerCreateInput.parse({ name: "Matter", parentId: "INBOX" }))).rejects.toMatchObject({ code: "invalid_payload" });
  await expect(listMailContainers("outlook", async () => { throw new Error("Must not make a provider request"); }, mailContainersInput.parse({ parentId: "parent", pageToken: "https://graph.microsoft.com/v1.0/me/mailFolders/other/childFolders" }))).rejects.toMatchObject({ code: "invalid_page_token" });
  for (const invalid of [{ messageIds: [] }, { messageIds: ["a", "a"], archive: true }, { messageIds: ["a"], addLabelIds: ["x"], removeLabelIds: ["x"] }, { messageIds: ["a"], archive: true, destinationFolderId: "x" }]) expect(mailOrganizeInput.safeParse(invalid).success).toBe(false);
});

test("Outlook category changes refuse missing or changed versions before writing", async () => {
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await setConnectorActivation(config, "outlook", connection.id, true);
  const previous = response;
  let version: string | undefined;
  let writes = 0;
  response = (url, init) => {
    if (url.hostname !== "graph.microsoft.com") return previous(url, init);
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (url.pathname.includes("/masterCategories")) return Response.json({ value: [{ id: "tag", displayName: "Matter", color: "preset0" }] });
    if (init?.method && init.method !== "GET") writes++;
    return Response.json({ id: "message", subject: "Contract", categories: ["Keep"], changeKey: version, "@odata.etag": version });
  };
  const input = { messageIds: ["message"], addCategories: ["Matter"] };
  await expect(previewMailOrganization(config, "outlook", input)).rejects.toMatchObject({ code: "connector_message_version_required" });
  version = 'W/"1"';
  const plan = await previewMailOrganization(config, "outlook", input);
  version = 'W/"2"';
  const result = await applyMailOrganization(config, "outlook", { planId: plan.planId });
  expect(result.results[0]).toMatchObject({ status: "failed", code: "connector_message_changed" });
  expect(writes).toBe(0);
});

test("native folder creation and folder-scoped message pagination stay in the selected resource", async () => {
  await createMailContainer("outlook", async (path, options) => {
    expect(path).toBe("/v1.0/me/mailFolders/parent%2Fid/childFolders");
    expect(options).toMatchObject({ method: "POST", organize: true, body: { displayName: "Matter" } });
    return { id: "child", displayName: "Matter", parentFolderId: "parent/id" };
  }, mailContainerCreateInput.parse({ parentId: "parent/id", name: "Matter" }));
  const nextPage = "https://graph.microsoft.com/v1.0/me/mailFolders/matter/messages?$skip=10";
  const request: Parameters<typeof outlookAdapter.list>[0] = async (path, options) => {
    expect(path).toStartWith("/v1.0/me/mailFolders/matter/messages?");
    expect(options?.headers?.Prefer).toBe('IdType="ImmutableId"');
    return { value: [{ id: "message", parentFolderId: "matter", categories: ["Keep"], isRead: true, flag: { flagStatus: "flagged" } }], "@odata.nextLink": nextPage };
  };
  const page = await outlookAdapter.list(request, mailListInput.parse({ folderId: "matter" }));
  expect(page.messages[0]).toMatchObject({ folderId: "matter", categories: ["Keep"], isRead: true, flag: "flagged" });
  expect(page.nextPageToken).toBe(nextPage);
  await expect(outlookAdapter.list(request, mailListInput.parse({ folderId: "other", pageToken: nextPage }))).rejects.toMatchObject({ code: "invalid_page_token" });
});

test("all registered connectors expose status and native connection tests", () => {
  for (const definition of connectorDefinitions) {
    const actions = listExperimentalExtensionActions(definition.id).map((item) => item.action);
    expect(actions).toContain("status");
    expect(actions).toContain("test_connection");
  }
});

test("makes direct Gmail requests and refreshes a rejected token once", async () => {
  const previous = response;
  response = (url, init) => {
    if (url.hostname === "gmail.googleapis.com") return new Headers(init?.headers).get("Authorization") === "Bearer mail-token"
      ? new Response(null, { status: 401 }) : Response.json({ emailAddress: "alice@example.com" });
    return previous(url, init);
  };
  expect((await callExperimentalExtensionAction(config, new EnvService({ path: join(root, "env.json") }), { extensionId: "gmail", action: "test_connection" }, { personalConnections: true })).ok).toBe(true);
  const direct = requests.filter((entry) => entry.url.hostname === "gmail.googleapis.com");
  expect(direct).toHaveLength(2);
  expect(new Headers(direct[1].init?.headers).get("Authorization")).toBe("Bearer refreshed-mail-token");
  expect(requests.filter((entry) => entry.url.pathname.endsWith("/token"))).toHaveLength(2);
  expect((await readFile(join(root, "runtime.sqlite"))).includes(Buffer.from("mail-token"))).toBe(false);
  expect(requests.every((entry) => entry.url.hostname !== "api.nango.dev")).toBe(true);
});

test("does not retry persistent 401 responses indefinitely", async () => {
  const previous = response;
  response = (url, init) => url.hostname === "gmail.googleapis.com" ? new Response(null, { status: 401 }) : previous(url, init);
  const request = await createConnectorRequest(config, "gmail");
  await expect(request("/gmail/v1/users/me/profile")).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect(requests.filter((entry) => entry.url.hostname === "gmail.googleapis.com")).toHaveLength(2);
});

test("does not retry ambiguous failed draft creation", async () => {
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  const previous = response;
  response = (url, init) => url.hostname === "gmail.googleapis.com" ? new Response(null, { status: 500 }) : previous(url, init);
  const request = await createConnectorRequest(config, "gmail");
  await expect(gmailAdapter.draft(request, mailDraftInput.parse({ to: ["recipient@example.com"], subject: "Draft", body: "Privileged body" }))).rejects.toMatchObject({ code: "connector_api_failed" });
  expect(requests.filter((entry) => entry.url.hostname === "gmail.googleapis.com")).toHaveLength(1);
  expect(requests.filter((entry) => entry.url.hostname === "broker.test").every((entry) => !String(entry.init?.body).includes("Privileged body"))).toBe(true);
});

test("legacy extra accounts remain saved but block tool use even with an explicit account", async () => {
  connections = [connection, { ...connection, id: "second-account" }];
  await writeConnectorConnections(config, localOwner, "gmail", connections);
  await expect(createConnectorRequest(config, "gmail")).rejects.toMatchObject({ code: "connector_multiple_accounts" });
  await expect(createConnectorRequest(config, "gmail", connection.id)).rejects.toMatchObject({ code: "connector_multiple_accounts" });
  expect(await readConnectorConnections(config, localOwner, "gmail")).toHaveLength(2);
  expect(requests).toHaveLength(0);
});

test("a connected connector rejects another account without contacting the broker, including Outlook's shared calendar", async () => {
  const flows = createConnectorFlows(config);
  for (const id of ["gmail", "outlook", "outlook-calendar"]) await expect(flows.start(id)).rejects.toMatchObject({ code: "connector_already_connected" });
  expect(requests).toHaveLength(0);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toHaveLength(1);
});

test("concurrent connector flows share one slot across server instances, cancellation frees it, and reconnect keeps one account", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  const first = createConnectorFlows(config);
  const second = createConnectorFlows({ ...config });
  const results = await Promise.allSettled([first.start("gmail"), second.start("gmail")]);
  const initial = results[0];
  if (initial.status !== "fulfilled") throw new Error("Expected the first sign-in to reserve the account slot");
  stops.push(async () => { await first.cancel(initial.value.flowId); });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "connector_connection_pending" } });
  expect(requests.filter((item) => item.url.pathname.endsWith("/connect"))).toHaveLength(1);
  first.cancel(initial.value.flowId);
  const next = await second.start("gmail");
  stops.push(async () => { await second.cancel(next.flowId); });
  const result = await second.status(next.flowId);
  if (!result.connection) throw new Error("Expected one activated account");
  expect((await second.status(next.flowId)).status).toBe("connected");
  const reconnect = await first.start("gmail", result.connection.id);
  stops.push(async () => { await first.cancel(reconnect.flowId); });
  expect((await first.status(reconnect.flowId)).connection?.id).toBe(result.connection.id);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toHaveLength(1);
  await expect(second.start("gmail")).rejects.toMatchObject({ code: "connector_already_connected" });
});

test("saved Outlook accounts require manual activation of each connector, without fetching credentials for inactive tools", async () => {
  const initial = await connectorStatus(config);
  for (const id of ["outlook", "outlook-calendar"]) {
    const item = initial.connectors.find((entry) => entry.id === id);
    if (!item) throw new Error("Expected Outlook connector status");
    expect(item.connections).toHaveLength(1);
    expect(item.active).toBe(false);
    expect(connectorIsConnected(item)).toBe(false);
    expect(connectorIsConnected({ ...item, active: undefined })).toBe(false);
  }
  requests.length = 0;
  await setConnectorActivation(config, "outlook", connection.id, true);
  await saveConnectorWriteSetting(config, "outlook-calendar", { writeAccess: true });
  await expect(createConnectorRequest(config, "outlook-calendar")).rejects.toMatchObject({ code: "connector_inactive" });
  await expect(connectorAccessToken(config, "outlook-calendar", connection.id, true)).rejects.toMatchObject({ code: "connector_inactive" });
  expect(requests).toHaveLength(0);
  const selected = await connectorStatus({ ...config });
  expect(connectorIsConnected(selected.connectors.find((item) => item.id === "outlook")!)).toBe(true);
  expect(connectorIsConnected(selected.connectors.find((item) => item.id === "outlook-calendar")!)).toBe(false);
  const cached = await createConnectorRequest(config, "outlook");
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  const before = requests.length;
  await setConnectorActivation(config, "outlook-calendar", connection.id, true);
  await setConnectorActivation(config, "outlook", connection.id, false);
  await expect(cached("/v1.0/me/messages")).rejects.toMatchObject({ code: "connector_inactive" });
  await expect(cached("/v1.0/me/messages", { method: "POST", body: {} })).rejects.toMatchObject({ code: "connector_inactive" });
  expect(requests).toHaveLength(before);
  expect(await readConnectorConnections(config, localOwner, "outlook")).toHaveLength(1);
  const remaining = await connectorStatus(config);
  expect(remaining.connectors.find((item) => item.id === "outlook-calendar")?.active).toBe(true);
  expect(remaining.connectors.find((item) => item.id === "outlook")?.active).toBe(false);
  await disconnectConnector(config, "outlook-calendar", connection.id);
  expect((await connectorStatus(config)).connectors.filter((item) => item.id.startsWith("outlook")).every((item) => !item.active && item.connections.length === 0)).toBe(true);
});

test("Nango consent and reconnect activate only the selected Outlook connector in either connection order", async () => {
  const previous = response;
  response = (url, init) => url.pathname === "/api/connectors" ? Response.json({ configured: true, providers: connectorDefinitions.map(({ id }) => ({ id })) }) : previous(url, init);
  for (const id of ["outlook", "outlook-calendar"]) {
    const sibling = id === "outlook" ? "outlook-calendar" : "outlook";
    await writeConnectorConnections(config, localOwner, "outlook", []);
    const flows = createConnectorFlows(config, async () => ({ connectUrl: "https://auth.test/consent", connectionId: () => connection.id, cancel: () => {} }));
    const flow = await flows.start(id, undefined, "nango");
    stops.push(async () => { await flows.cancel(flow.flowId); });
    const result = await flows.status(flow.flowId);
    if (!result.connection) throw new Error("Expected Outlook account");
    expect((await connectorStatus(config, id)).connectors[0].active).toBe(true);
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(false);
    await setConnectorActivation(config, id, result.connection.id, false);
    await flows.status(flow.flowId);
    expect((await connectorStatus(config, id)).connectors[0].active).toBe(false);
    await setConnectorActivation(config, sibling, result.connection.id, true);
    const reconnect = await flows.start(id, result.connection.id);
    stops.push(async () => { await flows.cancel(reconnect.flowId); });
    expect((await flows.status(reconnect.flowId)).connection?.id).toBe(result.connection.id);
    expect((await connectorStatus(config, id)).connectors[0].active).toBe(true);
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(true);
    await setConnectorActivation(config, sibling, result.connection.id, false);
    await flows.status(reconnect.flowId);
    expect((await connectorStatus(config, sibling)).connectors[0].active).toBe(false);
    await disconnectConnector(config, id, result.connection.id);
  }
});

test("deactivation during a rejected Outlook request prevents credential refresh and provider retry", async () => {
  await setConnectorActivation(config, "outlook", connection.id, true);
  const cached = await createConnectorRequest(config, "outlook");
  const previous = response;
  response = async (url, init) => {
    if (url.hostname !== "graph.microsoft.com") return previous(url, init);
    await setConnectorActivation(config, "outlook", connection.id, false);
    return new Response(null, { status: 401 });
  };
  await expect(cached("/v1.0/me/messages")).rejects.toMatchObject({ code: "connector_inactive" });
  expect(requests.filter((item) => item.url.hostname === "graph.microsoft.com")).toHaveLength(1);
  expect(requests.filter((item) => item.url.pathname.endsWith("/token"))).toHaveLength(1);
});

test("switching Eigenwelt owners cannot activate the previous owner's shared Outlook account", async () => {
  await setConnectorActivation(config, "outlook", connection.id, true);
  await writeEigenweltConnection(config, { account: { userId: "bob", userName: "Bob", userEmail: null, orgId: "other", orgName: "Other" } });
  requests.length = 0;
  await expect(setConnectorActivation(config, "outlook-calendar", connection.id, true)).rejects.toMatchObject({ code: "connector_connection_not_found" });
  expect(requests).toHaveLength(0);
  expect((await connectorStatus(config)).connectors.filter((item) => item.id.startsWith("outlook")).every((item) => !item.active)).toBe(true);
});

test("rejects cross-origin URLs, redirects and invalid Outlook pagination links", async () => {
  await setConnectorActivation(config, "outlook", connection.id, true);
  const request = await createConnectorRequest(config, "outlook");
  await expect(request("//attacker.test/mail")).rejects.toMatchObject({ code: "connector_invalid_endpoint" });
  await expect(outlookAdapter.list(request, mailListInput.parse({ pageToken: "https://attacker.test/mail" }))).rejects.toMatchObject({ code: "invalid_page_token" });
  expect(requests.every((entry) => entry.url.hostname !== "attacker.test")).toBe(true);
});

test("maps broken connections to a reconnect error without requesting credentials", async () => {
  connections = [{ ...connection, needsReconnect: true }];
  await expect(createConnectorRequest(config, "gmail")).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect(requests.every((entry) => !entry.url.pathname.endsWith("/token"))).toBe(true);
});

test("matches connection flows to their tag and expires abandoned flows", async () => {
  const flows = createConnectorFlows(config);
  const flow = await flows.start("gmail", connection.id);
  expect(flow.connectUrl).toStartWith("https://api.nango.dev/oauth/connect/google-mail");
  expect((await flows.status(flow.flowId)).status).toBe("connected");
  expect(requests.every((entry) => !entry.url.pathname.endsWith("/connections"))).toBe(true);
  flows.cancel(flow.flowId);
  await expect(flows.status(flow.flowId)).rejects.toMatchObject({ code: "connector_flow_not_found" });
});

test("does not attach a flow after signing in as another user", async () => {
  const flows = createConnectorFlows(config);
  const flow = await flows.start("gmail", connection.id);
  await writeEigenweltConnection(config, { account: { userId: "bob", userName: null, userEmail: null, orgId: "firm", orgName: "Firm" } });
  await expect(flows.status(flow.flowId)).rejects.toMatchObject({ code: "connector_flow_forbidden" });
});

test("signed-out settings expose no tokens and make no broker requests", async () => {
  await writeEigenweltConnection(config, { platformToken: null, account: null });
  const status = await connectorStatus(config);
  expect(status.requiresSignIn).toBe(true);
  expect(status.connectors.map((item) => item.id)).toEqual(connectorDefinitions.map((item) => item.id));
  expect(requests).toHaveLength(0);
});

test("unused connectors never discover connections or credentials through the broker", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  await writeConnectorConnections(config, localOwner, "outlook", []);
  const status = await connectorStatus(config);
  expect(status.connectors.every((item) => item.connections.length === 0)).toBe(true);
  expect(requests.map((item) => item.url.pathname)).toEqual(["/api/connectors"]);
  requests.length = 0;
  await expect(createConnectorRequest(config, "gmail")).rejects.toMatchObject({ code: "connector_not_connected" });
  await expect(connectorAccessToken(config, "gmail", "mail-account")).rejects.toMatchObject({ code: "connector_not_connected" });
  expect(requests).toHaveLength(0);
});

test("only connected providers refresh and Outlook email/calendar share one lookup", async () => {
  const previous = response;
  response = (url, init) => url.pathname === "/api/connectors"
    ? Response.json({ configured: true, providers: connectorDefinitions.map(({ id }) => ({ id })) }) : previous(url, init);
  await connectorStatus(config);
  expect(requests.filter((item) => item.url.pathname.endsWith("/connection/status")).map((item) => item.url.pathname).sort()).toEqual(["/api/connectors/gmail/connection/status", "/api/connectors/outlook/connection/status"]);
  requests.length = 0;
  await connectorStatus(config, "google-drive");
  expect(requests.map((item) => item.url.pathname)).toEqual(["/api/connectors"]);
});

test("repeated and concurrent settings reads share one status lookup per saved provider", async () => {
  const results = await Promise.all([listConnectorConnections(config, "outlook"), listConnectorConnections({ ...config }, "outlook-calendar")]);
  expect(results.every(items => items.length === 1)).toBe(true);
  for (let i = 0; i < 8; i++) await connectorStatus(config);
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(2);
});

test("a failed status lookup is not cached as successful", async () => {
  const previous = response;
  let fail = true;
  response = (url, init) => fail && url.pathname.endsWith("/connection/status") ? Response.json({}, { status: 429 }) : previous(url, init);
  await expect(listConnectorConnections(config, "gmail")).rejects.toMatchObject({ code: "connector_rate_limited" });
  fail = false;
  expect(await listConnectorConnections(config, "gmail")).toHaveLength(1);
});

test("a connector modal reads only its selected provider through the owner API", async () => {
  const previous = response;
  response = (url, init) => url.pathname === "/api/connectors" ? Response.json({ configured: true, providers: connectorDefinitions.map(({ id }) => ({ id })) }) : previous(url, init);
  const server = await startServer(config); stops.push(() => server.stop());
  const endpoint = `http://127.0.0.1:${server.port}/connectors/outlook-calendar`;
  expect((await nativeFetch(endpoint)).status).toBe(401);
  const result = await nativeFetch(endpoint, { headers: { Authorization: `Bearer ${config.token}`, "X-LegalWork-Host-Token": config.hostToken } });
  expect(result.status).toBe(200);
  const status = await result.json();
  expect(status.connectors.map((item: { id: string }) => item.id)).toEqual(["outlook-calendar"]);
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status")).map(item => item.url.pathname)).toEqual(["/api/connectors/outlook-calendar/connection/status"]);
  requests.length = 0;
  expect((await nativeFetch(endpoint, { headers: { Authorization: `Bearer ${config.token}`, "X-LegalWork-Host-Token": config.hostToken } })).status).toBe(200);
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(0);
  expect((await nativeFetch(`${endpoint}?refresh=true`, { headers: { Authorization: `Bearer ${config.token}`, "X-LegalWork-Host-Token": config.hostToken } })).status).toBe(200);
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(1);
});

test("status metadata expires and changed saved accounts bypass the cache", async () => {
  await listConnectorConnections(config, "gmail");
  const now = Date.now(); const clock = spyOn(Date, "now").mockReturnValue(now + 30_001);
  try { await listConnectorConnections(config, "gmail"); }
  finally { clock.mockRestore(); }
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(2);
  await writeConnectorConnections(config, localOwner, "gmail", [{ ...connection, id: "replacement-account" }]);
  connections = [{ ...connection, id: "replacement-account" }];
  expect((await listConnectorConnections(config, "gmail"))[0]?.id).toBe("replacement-account");
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(3);
});

test("metadata cache is scoped to the current Eigenwelt owner", async () => {
  await listConnectorConnections(config, "gmail");
  await writeEigenweltConnection(config, { account: { userId: "bob", userName: null, userEmail: null, orgId: "firm", orgName: "Firm" } });
  await writeConnectorConnections(config, JSON.stringify(["https://broker.test", "firm", "bob"]), "gmail", [connection]);
  await listConnectorConnections(config, "gmail");
  expect(requests.filter(item => item.url.pathname.endsWith("/connection/status"))).toHaveLength(2);
});

test("opening settings after another firm signs in never discovers that firm's accounts", async () => {
  await writeEigenweltConnection(config, { account: { userId: "alice", userName: "Alice", userEmail: null, orgId: "other-firm", orgName: "Other" } });
  expect((await connectorStatus(config)).connectors.every((item) => item.connections.length === 0)).toBe(true);
  expect(requests.map((item) => item.url.pathname)).toEqual(["/api/connectors"]);
});

test("a completed explicit connect flow persists activation across server instances", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  const flows = createConnectorFlows(config);
  const flow = await flows.start("gmail");
  expect((await flows.status(flow.flowId)).status).toBe("connected");
  flows.cancel(flow.flowId);
  const saved = await readConnectorConnections(config, localOwner, "gmail");
  expect(saved).toHaveLength(1); expect(saved[0].nangoConnectionId).toBe(connection.id);
  expect(saved[0].id).not.toBe(connection.id);
  requests.length = 0;
  expect(await listConnectorConnections({ ...config }, "gmail")).toEqual([{ id: saved[0].id, createdAt: connection.createdAt, needsReconnect: false }]);
  expect(requests).toHaveLength(1);
});

test("cancelling an unfinished flow leaves an unused connector silent", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  const flows = createConnectorFlows(config);
  const flow = await flows.start("gmail");
  flows.cancel(flow.flowId);
  requests.length = 0;
  expect(await listConnectorConnections(config, "gmail")).toEqual([]);
  await expect(flows.status(flow.flowId)).rejects.toMatchObject({ code: "connector_flow_not_found" });
  expect(requests).toHaveLength(0);
});

test("an account needing reconnect uses local status until the user reconnects", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", [{ ...connection, needsReconnect: true }]);
  expect((await listConnectorConnections(config, "gmail"))[0].needsReconnect).toBe(true);
  await expect(createConnectorRequest(config, "gmail")).rejects.toMatchObject({ code: "connector_reconnect_required" });
  expect(requests).toHaveLength(0);
});

test("external removal stops provider lookups after the first status refresh", async () => {
  connections = [];
  expect(await listConnectorConnections(config, "gmail")).toEqual([]);
  requests.length = 0;
  expect(await listConnectorConnections(config, "gmail")).toEqual([]);
  expect(requests).toHaveLength(0);
});

test("disconnecting the last account stops subsequent provider requests", async () => {
  await writeConnectorConnections(config, localOwner, "outlook", []);
  const previous = response;
  response = (url, init) => init?.method === "DELETE" ? Response.json({ ok: true }) : previous(url, init);
  await disconnectConnector(config, "gmail", connection.id);
  requests.length = 0;
  await connectorStatus(config);
  expect(requests.map((item) => item.url.pathname)).toEqual(["/api/connectors"]);
  await expect(createConnectorRequest(config, "gmail")).rejects.toMatchObject({ code: "connector_not_connected" });
});

test("a status response arriving after disconnect cannot revive the account", async () => {
  await writeConnectorConnections(config, localOwner, "outlook", []);
  let release = () => {};
  let metadataStarted = () => {};
  const started = new Promise<void>((resolve) => { metadataStarted = resolve; });
  const previous = response;
  response = (url, init) => url.pathname === "/api/connectors/gmail/connection/status"
    ? new Promise<Response>((resolve) => {
      release = () => resolve(Response.json({ connection }));
      metadataStarted();
    }) : init?.method === "DELETE" ? Response.json({ ok: true }) : previous(url, init);
  const pending = listConnectorConnections(config, "gmail");
  await started;
  await disconnectConnector(config, "gmail", connection.id);
  release();
  expect(await pending).toEqual([]);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toEqual([]);
  requests.length = 0;
  expect(await listConnectorConnections(config, "gmail")).toEqual([]);
  expect(requests).toHaveLength(0);
});

test("a flow response arriving after cancellation cannot activate the connector", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  let release = () => {};
  let metadataStarted = () => {};
  const started = new Promise<void>((resolve) => { metadataStarted = resolve; });
  const previous = response;
  response = (url, init) => url.pathname.endsWith("/connection/status")
    ? new Promise<Response>((resolve) => {
      release = () => resolve(Response.json({ connection }));
      metadataStarted();
    }) : previous(url, init);
  const flows = createConnectorFlows(config);
  const flow = await flows.start("gmail");
  const pending = flows.status(flow.flowId);
  await started;
  flows.cancel(flow.flowId);
  release();
  await expect(pending).rejects.toMatchObject({ code: "connector_flow_not_found" });
  expect(await readConnectorConnections(config, localOwner, "gmail")).toEqual([]);
  requests.length = 0;
  expect(await listConnectorConnections(config, "gmail")).toEqual([]);
  expect(requests).toHaveLength(0);
});

test("read-only servers block draft writes before obtaining a credential", async () => {
  config.readOnly = true;
  await expect(callExperimentalExtensionAction(config, new EnvService({ path: join(root, "env.json") }), {
    extensionId: "gmail", action: "create_draft", args: { to: ["a@example.com"], subject: "Review", body: "Private draft" },
  }, { personalConnections: true })).rejects.toMatchObject({ code: "read_only" });
  expect(requests).toHaveLength(0);
});

test("native Gmail parsing and drafts preserve Unicode and block header injection", async () => {
  let draftBody: unknown;
  const request = async (_path: string, options?: { body?: unknown }) => {
    draftBody = options?.body;
    return { id: "draft-1", message: { id: "message-1" } };
  };
  expect(await gmailAdapter.draft(request, mailDraftInput.parse({ to: ["a@example.com"], subject: "Prüfung § 1", body: "Vertraulicher Entwurf" }))).toEqual({ id: "draft-1", messageId: "message-1", sent: false });
  const payload = z.object({ message: z.object({ raw: z.string() }) }).parse(draftBody);
  const mime = Buffer.from(payload.message.raw, "base64url").toString();
  expect(mime).toContain(Buffer.from("Prüfung § 1").toString("base64"));
  expect(mime).toContain(Buffer.from("Vertraulicher Entwurf").toString("base64"));
  expect(mailDraftInput.safeParse({ to: ["a@example.com"], subject: "Subject\r\nBcc: attacker@example.com", body: "x" }).success).toBe(false);
});

test("Outlook creates a draft directly without a send operation", async () => {
  await setConnectorActivation(config, "outlook", connection.id, true);
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  const previous = response;
  response = (url, init) => url.hostname === "graph.microsoft.com" ? Response.json({ id: "outlook-draft" }) : previous(url, init);
  const request = await createConnectorRequest(config, "outlook");
  expect(await outlookAdapter.draft(request, mailDraftInput.parse({ to: ["a@example.com"], subject: "Review", body: "Private Outlook draft" }))).toEqual({ id: "outlook-draft", messageId: "outlook-draft", sent: false });
  expect(requests.filter((entry) => entry.url.hostname === "graph.microsoft.com").map((entry) => entry.url.pathname)).toEqual(["/v1.0/me/messages"]);
  expect(requests.filter((entry) => entry.url.hostname === "broker.test").every((entry) => !String(entry.init?.body).includes("Private Outlook draft"))).toBe(true);
});

test("Gmail reads nested MIME text and attachment metadata without downloading attachment bytes", async () => {
  const paths: string[] = [];
  const result = await gmailAdapter.get(async (path) => {
    paths.push(path);
    return { id: "message-1", payload: { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Mandat" }], parts: [
      { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Vertraulicher Text").toString("base64url") } }] },
      { mimeType: "application/pdf", filename: "Vertrag.pdf", body: { attachmentId: "attachment-1", size: 123 } },
    ] } };
  }, { messageId: "message-1" });
  expect(result.body).toBe("Vertraulicher Text");
  expect(result.attachments).toEqual([{ id: "attachment-1", filename: "Vertrag.pdf", mimeType: "application/pdf", size: 123 }]);
  expect(paths).toHaveLength(1);
});

test("Gmail search preserves opaque pagination and returns summaries", async () => {
  const paths: string[] = [];
  const result = await gmailAdapter.list(async (path) => {
    paths.push(path);
    return path.includes("format=metadata")
      ? { id: "message-1", payload: { headers: [{ name: "From", value: "client@example.com" }, { name: "Subject", value: "Mandat" }] } }
      : { messages: [{ id: "message-1" }], nextPageToken: "opaque-next", resultSizeEstimate: 2 };
  }, mailListInput.parse({ query: 'subject:"Mandat"', pageToken: "opaque-current", maxResults: 1 }));
  expect(new URL(paths[0], "https://gmail.googleapis.com").searchParams.get("pageToken")).toBe("opaque-current");
  expect(result.messages[0].subject).toBe("Mandat");
  expect(result.nextPageToken).toBe("opaque-next");
});

test("Outlook returns native message bodies and attachment identifiers", async () => {
  const result = await outlookAdapter.get(async (path) => path.includes("/attachments")
    ? { value: [{ id: "attachment-1", name: "Contract.pdf", contentType: "application/pdf", size: 123 }] }
    : { id: "message-1", subject: "Contract", from: { emailAddress: { address: "client@example.com" } },
      body: { contentType: "text", content: "Private Outlook message" }, hasAttachments: true },
  { messageId: "message-1" });
  expect(result.body).toBe("Private Outlook message");
  expect(result.from).toBe("client@example.com");
  expect(result.attachments[0]).toEqual({ id: "attachment-1", filename: "Contract.pdf", mimeType: "application/pdf", size: 123 });
});

for (const provider of ["gmail", "outlook"] satisfies Array<"gmail" | "outlook">) {
  test(`${provider} downloads attachments above the former mail and inline limits to the active workspace`, async () => {
    const bytes = Buffer.alloc(21 * 1024 * 1024 + 5, 137);
    attachmentFixture(provider, bytes, "Vertrag Müller.pdf");
    const result = await downloadAttachment(provider);
    const file = downloadedAttachment.parse(result.result);
    expect(file.relativePath).toMatch(new RegExp(`^\\.legalwork/attachments/email/${provider}-[^/]+/Vertrag Müller\\.pdf$`));
    expect(file.path).toBe(join(await realpath(root), file.relativePath));
    expect(file.filename).toBe("Vertrag Müller.pdf");
    expect(file.mimeType).toBe("application/pdf");
    expect(file.size).toBe(bytes.length);
    expect(Buffer.compare(await readFile(file.path), bytes)).toBe(0);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
    expect(JSON.stringify(result)).not.toContain("dataBase64");
    if (process.platform !== "win32") expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    const contentRequest = requests.filter(({ url }) => url.pathname.includes("/attachments/")).at(-1);
    expect(contentRequest?.init?.signal).toBeDefined();
    if (provider === "gmail") expect(contentRequest?.url.searchParams.get("fields")).toBe("data");
    else expect(contentRequest?.url.pathname.endsWith("/$value")).toBe(true);
  });

  test(`${provider} keeps same-named attachments separate and confines unsafe filenames`, async () => {
    attachmentFixture(provider, Buffer.from("first"), "../../Contract.pdf");
    const first = downloadedAttachment.parse((await downloadAttachment(provider)).result);
    attachmentFixture(provider, Buffer.from("second"), "..\\..\\Contract.pdf");
    const second = downloadedAttachment.parse((await downloadAttachment(provider)).result);
    expect(first.filename).toBe("Contract.pdf");
    expect(second.filename).toBe("Contract.pdf");
    expect(first.path).not.toBe(second.path);
    expect(await readFile(first.path, "utf8")).toBe("first");
    expect(await readFile(second.path, "utf8")).toBe("second");
  });

  test(`${provider} downloads from a nested task directory into its project root`, async () => {
    attachmentFixture(provider, Buffer.alloc(0));
    const nested = join(root, "matter", "notes");
    await mkdir(nested, { recursive: true });
    const file = downloadedAttachment.parse((await downloadAttachment(provider, { directory: nested })).result);
    expect(file.path).toBe(join(await realpath(root), file.relativePath));
    expect((await stat(file.path)).size).toBe(0);
  });

  test(`${provider} requires an authorized project and rejects downloads on a read-only server`, async () => {
    attachmentFixture(provider, Buffer.from("private attachment"));
    await expect(downloadAttachment(provider, {})).rejects.toMatchObject({ code: "connector_workspace_required" });
    config.authorizedRoots = [];
    await expect(downloadAttachment(provider)).rejects.toMatchObject({ code: "workspace_unauthorized" });
    config.authorizedRoots = [root]; config.readOnly = true;
    await expect(downloadAttachment(provider)).rejects.toMatchObject({ code: "read_only" });
    expect(requests).toHaveLength(0);
  });

  test(`${provider} rejects a download folder symlink outside the workspace`, async () => {
    attachmentFixture(provider, Buffer.from("private attachment"));
    const outside = await mkdtemp(join(tmpdir(), "mail-attachment-outside-"));
    try {
      await mkdir(join(root, ".legalwork"), { recursive: true });
      await symlink(outside, join(root, ".legalwork", "attachments"), process.platform === "win32" ? "junction" : "dir");
      await expect(downloadAttachment(provider)).rejects.toMatchObject({ code: "attachment_path_outside_workspace" });
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  test(`${provider} removes partial downloads on a broken provider stream`, async () => {
    attachmentFixture(provider, Buffer.from("private attachment"));
    const previous = response;
    response = (url, init) => {
      if (url.pathname.includes("/attachments/") && (provider === "gmail" || url.pathname.endsWith("/$value"))) {
        let started = false;
        return new Response(new ReadableStream({ pull(controller) {
          if (started) { controller.error(new Error("fixture interrupted")); return; }
          started = true; controller.enqueue(Buffer.from(provider === "gmail" ? '{"data":"cHJpdmF0' : "partial"));
        } }));
      }
      return previous(url, init);
    };
    await expect(downloadAttachment(provider)).rejects.toThrow();
    expect(await readdir(join(root, ".legalwork", "attachments", "email"))).toEqual([]);
  });
}

test("Gmail downloads the same MIME part after provider attachment tokens change between message reads", async () => {
  const bytes = Buffer.from("the second same-named attachment");
  attachmentFixture("gmail", bytes);
  const previous = response;
  let reads = 0;
  response = (url, init) => {
    if (url.hostname === "gmail.googleapis.com" && !url.pathname.includes("/attachments/")) {
      reads++;
      return Response.json({ id: "message", payload: { parts: [
        { partId: "1", filename: "Contract.pdf", mimeType: "application/pdf", body: { attachmentId: `token-${reads}-first`, size: 10 } },
        { partId: "2", filename: "Contract.pdf", mimeType: "application/pdf", body: { attachmentId: `token-${reads}-second`, size: bytes.length } },
      ] } });
    }
    return previous(url, init);
  };
  const message = await gmailAdapter.get(await createConnectorRequest(config, "gmail"), { messageId: "message" });
  expect(message.attachments.map(item => item.id)).toEqual(["part:1", "part:2"]);
  expect(JSON.stringify(message.attachments)).not.toContain("token-1");
  const file = downloadedAttachment.parse((await downloadAttachment("gmail", { directory: root }, message.attachments[1].id)).result);
  expect(file.filename).toBe("Contract.pdf");
  expect(await readFile(file.path, "utf8")).toBe(bytes.toString());
  expect(requests.filter(({ url }) => url.pathname.includes("/attachments/")).map(({ url }) => url.pathname)).toEqual([
    "/gmail/v1/users/me/messages/message/attachments/token-2-second",
  ]);
});

test("Gmail accepts a legacy opaque attachment token even when metadata now contains a different token", async () => {
  attachmentFixture("gmail", Buffer.from("legacy attachment"));
  const file = downloadedAttachment.parse((await downloadAttachment("gmail", { directory: root }, "older-opaque-token")).result);
  expect(file.filename).toBe("attachment");
  expect(await readFile(file.path, "utf8")).toBe("legacy attachment");
  expect(requests.filter(({ url }) => url.pathname.includes("/attachments/")).map(({ url }) => url.pathname)).toEqual([
    "/gmail/v1/users/me/messages/message/attachments/older-opaque-token",
  ]);
});

test("Gmail refuses an unknown stable MIME part without requesting attachment bytes", async () => {
  attachmentFixture("gmail", Buffer.from("attachment"));
  await expect(downloadAttachment("gmail", { directory: root }, "part:missing")).rejects.toMatchObject({ code: "connector_item_not_found" });
  expect(requests.some(({ url }) => url.pathname.includes("/attachments/"))).toBe(false);
});

test("Outlook reference attachments are rejected before any content download", async () => {
  attachmentFixture("outlook", Buffer.alloc(0));
  const previous = response;
  response = (url, init) => url.hostname === "graph.microsoft.com"
    ? Response.json({ "@odata.type": "#microsoft.graph.referenceAttachment", name: "Link", contentType: "text/plain", size: 1 }) : previous(url, init);
  await expect(downloadAttachment("outlook")).rejects.toMatchObject({ code: "attachment_not_file" });
  expect(requests.some(({ url }) => url.pathname.endsWith("/$value"))).toBe(false);
});

test("attachment HTTP action returns a usable workspace path without file bytes", async () => {
  attachmentFixture("gmail", Buffer.alloc(6 * 1024 * 1024, 93));
  const server = await startServer(config);
  stops.push(() => server.stop());
  const result = await nativeFetch(`http://127.0.0.1:${server.port}/experimental/extensions/call`, {
    method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "x-legalwork-connector-token": connectorRuntimeCapability(config) },
    body: JSON.stringify({ extensionId: "gmail", action: "get_attachment", args: { messageId: "message", attachmentId: "attachment" }, context: { directory: root } }),
  });
  expect(result.status).toBe(200);
  const payload = z.object({ result: downloadedAttachment }).parse(await result.json());
  expect((await stat(payload.result.path)).size).toBe(6 * 1024 * 1024);
  expect(JSON.stringify(payload).length).toBeLessThan(2000);
});

test("Outlook listing accepts unsent drafts with no sender", async () => {
  const result = await outlookAdapter.list(async () => ({ value: [{ id: "draft", from: null, subject: null, receivedDateTime: null, bodyPreview: null }] }), mailListInput.parse({}));
  expect(result.messages[0].from).toBeNull();
  expect(result.messages[0].subject).toBe("");
});

test("HTTP routes and tool calls deny personal account access to collaborators and viewers", async () => {
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  expect((await nativeFetch(`${base}/connectors`)).status).toBe(401);
  for (const token of [config.token, "owt_retired_viewer"]) {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      "x-legalwork-connector-token": token !== config.token ? connectorRuntimeCapability(config) : "invalid-grant" };
    expect((await nativeFetch(`${base}/connectors`, { headers })).status).toBe(401);
    expect((await nativeFetch(`${base}/connectors/outlook-calendar/activation`, { method: "PUT", headers, body: JSON.stringify({ connectionId: connection.id, active: true }) })).status).toBe(401);
    requests.length = 0;
    for (const definition of connectorDefinitions) {
      for (const extensionId of [definition.id, ` \t${definition.id}\n`]) {
        const denied = await nativeFetch(`${base}/experimental/extensions/call`, { method: "POST", headers,
          body: JSON.stringify({ extensionId, action: " status ", access: { personalConnections: true } }) });
        expect(denied.status).toBe(token === config.token ? 403 : 401);
      }
    }
    expect(requests).toHaveLength(0);
  }
  expect((await nativeFetch(`${base}/connectors`, { headers: { "x-legalwork-host-token": config.hostToken } })).status).toBe(200);
  const runtimeHeaders = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "x-legalwork-connector-token": connectorRuntimeCapability(config) };
  const clientHeaders = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const extensionCall = { extensionId: " gmail ", action: "test_connection" };
  expect((await nativeFetch(`${base}/experimental/extensions/call`, { method: "POST", headers: clientHeaders, body: JSON.stringify(extensionCall) })).status).toBe(403);
  const authorizedHeaders: Record<string, string>[] = [runtimeHeaders,
    { "x-legalwork-host-token": config.hostToken, "Content-Type": "application/json" }];
  for (const headers of authorizedHeaders) {
    for (const extensionId of ["gmail", " \tgmail\n"]) {
      expect((await nativeFetch(`${base}/experimental/extensions/call`, { method: "POST", headers,
        body: JSON.stringify({ extensionId, action: " test_connection " }) })).status).toBe(200);
    }
  }
  // The narrow engine grant cannot manage connections or obtain host privileges.
  expect((await nativeFetch(`${base}/connectors`, { headers: runtimeHeaders })).status).toBe(401);
  expect((await nativeFetch(`${base}/connectors/outlook-calendar/activation`, { method: "PUT", headers: runtimeHeaders, body: JSON.stringify({ connectionId: connection.id, active: true }) })).status).toBe(401);
});

test("extension dispatch denies personal connectors without an explicit grant", async () => {
  const env = new EnvService({ path: join(root, "env.json") });
  for (const definition of connectorDefinitions) {
    for (const extensionId of [definition.id, ` \t${definition.id}\n`]) {
      await expect(callExperimentalExtensionAction(config, env, {
        extensionId, action: "status", access: { personalConnections: true },
      })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
  }
  expect(requests).toHaveLength(0);
});

test("authorized HTTP extension calls retain write restrictions after normalization", async () => {
  const server = await startServer(config);
  stops.push(() => server.stop());
  requests.length = 0;
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "x-legalwork-connector-token": connectorRuntimeCapability(config) };
  const call = () => nativeFetch(`${base}/experimental/extensions/call`, { method: "POST", headers,
    body: JSON.stringify({ extensionId: " \tgmail\n", action: " create_draft ", args: { to: ["a@example.com"], subject: "Review", body: "Private draft" } }) });
  const disabled = await call();
  expect(disabled.status).toBe(403);
  expect(await disabled.json()).toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "gmail", { writeAccess: true });
  config.readOnly = true;
  const readOnly = await call();
  expect(readOnly.status).toBe(403);
  expect(await readOnly.json()).toMatchObject({ code: "read_only" });
  expect(requests.filter(({ url }) => url.hostname !== "broker.test" || url.pathname.startsWith("/api/connectors"))).toHaveLength(0);
});

test("Nango capabilities are encrypted and absent from public status and broker URLs", async () => {
  const secret = "private-nango-capability-8f32a19c";
  await writeConnectorConnections(config, localOwner, "gmail", [{ ...connection, nangoConnectionId: secret }]);
  connections = [{ ...connection, id: secret }];
  const status = await connectorStatus(config, "gmail");
  expect(JSON.stringify(status)).not.toContain(secret);
  expect(status.connectors[0].connections[0].id).toBe(connection.id);
  await expect(connectorAccessToken(config, "gmail", secret)).rejects.toMatchObject({ code: "connector_not_connected" });
  await connectorAccessToken(config, "gmail", connection.id);
  expect(requests.every((entry) => !entry.url.toString().includes(secret))).toBe(true);
  expect(requests.some((entry) => String(entry.init?.body).includes(secret))).toBe(true);
  expect((await readFile(join(root, "runtime.sqlite"))).includes(Buffer.from(secret))).toBe(false);
  const path = oauthVaultPath(config);
  expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false);
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.key`)).mode & 0o777).toBe(0o600);
  }
});

test("connection creation fails before any remote request when the OAuth vault cannot be opened", async () => {
  await writeFile(oauthVaultPath(config), "unreadable-vault");
  await expect(createConnectorFlows(config).start("gmail")).rejects.toMatchObject({ code: "storage_signin_unreadable" });
  expect(requests).toHaveLength(0);
});

test("existing plaintext connection metadata migrates to an encrypted secret and a new local handle", async () => {
  config = { ...config, configPath: join(root, "legacy", "server.json") };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "legacy", "runtime.sqlite");
  await bootstrapRuntimeOpencodeConfig(config);
  const db = await openSqlite(join(root, "legacy", "runtime.sqlite"));
  db.exec("CREATE TABLE connector_connections (owner TEXT NOT NULL, connector_id TEXT NOT NULL, connections_json TEXT NOT NULL, PRIMARY KEY (owner, connector_id))");
  db.run("INSERT INTO connector_connections (owner, connector_id, connections_json) VALUES (?, ?, ?)", [localOwner, "gmail", JSON.stringify([connection])]);
  db.close();
  await prepareConnectorStorage(config);
  const migrated = await readConnectorConnections(config, localOwner, "gmail");
  expect(migrated[0].nangoConnectionId).toBe(connection.id);
  expect(migrated[0].id).not.toBe(connection.id);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toEqual(migrated);
  const check = await openSqlite(join(root, "legacy", "runtime.sqlite"));
  const row = check.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_connections'");
  expect(row).toBeUndefined();
  check.close();
  expect((await readFile(oauthVaultPath(config))).includes(Buffer.from(connection.id))).toBe(false);
  expect((await readFile(join(root, "legacy", "runtime.sqlite"))).includes(Buffer.from(connection.id))).toBe(false);
});

test("unreadable encrypted records fail closed before any connection request", async () => {
  const path = oauthVaultPath(config);
  const data = await readFile(path);
  data[data.length - 1] = data.at(-1)! ^ 1;
  await writeFile(path, data);
  await expect(listConnectorConnections(config, "gmail")).rejects.toMatchObject({ code: "storage_signin_unreadable" });
  expect(requests).toHaveLength(0);
});

test("cancelling during vault persistence cannot activate a connection", async () => {
  await writeConnectorConnections(config, localOwner, "gmail", []);
  let checks = 0;
  expect(await persistConnectorConnections(config, localOwner, "gmail", [{ ...connection, nangoConnectionId: "private" }], null,
    () => ++checks === 1)).toBe(false);
  expect(checks).toBe(2);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toEqual([]);
});

test("Nango and file-storage OAuth share the vault without overwriting grants", async () => {
  const vault = new OAuthVault(oauthVaultPath(config));
  const grant = { accessToken: "file-access", refreshToken: "file-refresh", expiresAt: 123 };
  await Promise.all([
    vault.set("file-storage-grant", grant),
    writeConnectorConnections(config, localOwner, "gmail", [{ ...connection, nangoConnectionId: "nango-private" }]),
  ]);
  expect(await vault.get("file-storage-grant")).toEqual(grant);
  expect((await readConnectorConnections(config, localOwner, "gmail"))[0].nangoConnectionId).toBe("nango-private");
  await writeConnectorConnections(config, localOwner, "gmail", []);
  expect(await vault.get("file-storage-grant")).toEqual(grant);
  expect(await readConnectorConnections(config, localOwner, "outlook")).toHaveLength(1);
  await vault.set("file-storage-grant");
  expect(await readConnectorConnections(config, localOwner, "outlook")).toHaveLength(1);
});

test("Nango follows the file-storage vault location override", async () => {
  const priorStore = process.env.LEGALWORK_STORAGE_STORE;
  process.env.LEGALWORK_STORAGE_STORE = join(root, "custom", "file-storage.json");
  try {
    expect(oauthVaultPath(config)).toBe(join(root, "custom", "storage-oauth.vault"));
    await prepareConnectorStorage(config);
    await writeConnectorConnections(config, localOwner, "gmail", [connection]);
    expect(await readConnectorConnections(config, localOwner, "gmail")).toHaveLength(1);
    expect((await stat(oauthVaultPath(config))).isFile()).toBe(true);
  } finally {
    if (priorStore === undefined) delete process.env.LEGALWORK_STORAGE_STORE;
    else process.env.LEGALWORK_STORAGE_STORE = priorStore;
  }
});

test("legacy encrypted records migrate once and preserve their existing local handles", async () => {
  config = { ...config, configPath: join(root, "legacy", "server.json") };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "legacy", "runtime.sqlite");
  await bootstrapRuntimeOpencodeConfig(config);
  const db = await openSqlite(join(root, "legacy", "runtime.sqlite"));
  db.exec("CREATE TABLE connector_connections (owner TEXT NOT NULL, connector_id TEXT NOT NULL, connections_json TEXT NOT NULL, PRIMARY KEY (owner, connector_id))");
  db.run("INSERT INTO connector_connections (owner, connector_id, connections_json) VALUES (?, ?, ?)", [localOwner, "gmail", "encrypted:v1:opaque-old-record"]);
  db.close();
  let decryptions = 0;
  config.decryptLegacyConnectorSecrets = (value) => {
    expect(value).toBe("opaque-old-record"); decryptions++;
    return JSON.stringify([{ ...connection, nangoConnectionId: "old-private-capability" }]);
  };
  await prepareConnectorStorage(config);
  expect((await readConnectorConnections(config, localOwner, "gmail"))[0]).toEqual({ ...connection, nangoConnectionId: "old-private-capability" });
  config.decryptLegacyConnectorSecrets = () => { throw new Error("Must not unlock the old store again"); };
  expect((await readConnectorConnections(config, localOwner, "gmail"))[0].id).toBe(connection.id);
  expect(decryptions).toBe(1);
});

test("a failed legacy unlock preserves the original record and sends no Nango request", async () => {
  config = { ...config, configPath: join(root, "legacy", "server.json") };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "legacy", "runtime.sqlite");
  await bootstrapRuntimeOpencodeConfig(config);
  const db = await openSqlite(join(root, "legacy", "runtime.sqlite"));
  db.exec("CREATE TABLE connector_connections (owner TEXT NOT NULL, connector_id TEXT NOT NULL, connections_json TEXT NOT NULL, PRIMARY KEY (owner, connector_id))");
  db.run("INSERT INTO connector_connections (owner, connector_id, connections_json) VALUES (?, ?, ?)", [localOwner, "gmail", "encrypted:v1:recoverable"]);
  db.close();
  await expect(prepareConnectorStorage(config)).rejects.toMatchObject({ code: "connector_secure_storage_unavailable" });
  expect(requests).toHaveLength(0);
  const check = await openSqlite(join(root, "legacy", "runtime.sqlite"));
  expect(check.get("SELECT connections_json FROM connector_connections WHERE owner = ? AND connector_id = ?", [localOwner, "gmail"])?.connections_json).toBe("encrypted:v1:recoverable");
  check.close();
});

test("disconnect erases the Nango secret from the vault and rejects stale writes", async () => {
  const saved = await readConnectorState(config, localOwner, "gmail");
  await disconnectConnector(config, "gmail", connection.id);
  expect(await persistConnectorConnections(config, localOwner, "gmail", saved.connections, saved.snapshot)).toBe(false);
  expect(await readConnectorConnections(config, localOwner, "gmail")).toEqual([]);
  const vault = new OAuthVault(oauthVaultPath(config));
  expect(await vault.getEntry(JSON.stringify(["nango", localOwner, "gmail"]), z.unknown())).toBeUndefined();
});
