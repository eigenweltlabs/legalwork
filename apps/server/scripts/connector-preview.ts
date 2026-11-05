// Isolated local fixture: real LegalWork routes, simulated auth broker and provider APIs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../src/server.js";
import { writeEigenweltConnection } from "../src/eigenwelt-connection-store.js";
import type { ServerConfig } from "../src/types.js";
import { writeConnectorConnections } from "../src/connectors/store.js";
import { connectorDefinitions } from "../src/connectors/schema.js";
import { recordConnectorActivation, saveConnectorWriteSetting } from "../src/connectors/settings.js";
import { prepareConnectorEmailDraft, prepareConnectorCalendarDraft, prepareConnectorCalendarUpdate } from "../src/connectors/drafts.js";

import { storageInputSchema, type StorageInput } from "@legalwork/types/file-storage";

const sharedStorage = new Map<string, { id: string; version: number; updatedAt: string; input: StorageInput }>();
const root = await mkdtemp(join(tmpdir(), "legalwork-connector-preview-"));
const showStorage = process.env.LEGALWORK_CONNECTOR_PREVIEW_STORAGE === "1";
const storageSignInRequired = process.env.LEGALWORK_CONNECTOR_PREVIEW_STORAGE_SIGNIN === "1";
const showDrafts = process.env.LEGALWORK_CONNECTOR_PREVIEW_DRAFTS === "1";
const editedDrafts = process.env.LEGALWORK_CONNECTOR_PREVIEW_EDITED_DRAFTS === "1";
const draftMime = new Map<string, string>();
const calendarEvents = new Map<string, Record<string, unknown>>([["fixture-existing-event", { id: "fixture-existing-event", etag: '"fixture-v1"', summary: "Contract review meeting", description: "Review the revised agreement.", location: "Office", start: { dateTime: "2026-10-15T14:00:00+02:00", timeZone: "Europe/Berlin" }, end: { dateTime: "2026-10-15T15:00:00+02:00", timeZone: "Europe/Berlin" }, attendees: [{ email: "client@example.com", responseStatus: "accepted" }], organizer: { email: "fixture@example.com" }, htmlLink: "https://calendar.google.com/calendar/event?eid=fixture" }]]);
const mailboxMime = (provider: string) => (draftMime.get(provider) ?? "").replace(/^Subject:.*$/m, editedDrafts ? "Subject: Reloaded mailbox subject\r" : "$&");
process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
process.env.LEGALWORK_ENV_STORE = join(root, "env.json");
process.env.LEGALWORK_STORAGE_STORE = join(root, "file-storage.json");
process.env.EIGENWELT_PLATFORM_URL = "https://connector-fixture.test";
const config: ServerConfig = { host: "127.0.0.1", port: 44641, token: "fixture-client", hostToken: "fixture-host",
  configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [],
  readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
if (showDrafts || showStorage) { config.workspaces = [{ id: "fixture-project", name: "Synthetic drafts", path: root, preset: "starter", workspaceType: "local" }]; config.authorizedRoots = [root]; }
if (process.env.LEGALWORK_CONNECTOR_PREVIEW_SIGNED_OUT !== "1") {
  await writeEigenweltConnection(config, { platformToken: "fixture-platform-token", platformURL: "https://connector-fixture.test",
    account: { userId: "fixture-user", userName: "Local fixture", userEmail: null, orgId: "fixture-firm", orgName: "Local fixture" } });
}
const nativeFetch = globalThis.fetch;
const connected = new Set<string>();
let startingProvider = "gmail";
const sockets = new Set<FixtureSocket>();
class FixtureSocket extends EventTarget {
  provider: string;
  constructor(url: string) {
    super();
    if (url !== "wss://api.nango.dev/") throw new Error("Unexpected fixture auth transport");
    this.provider = startingProvider; sockets.add(this);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ message_type: "connection_ack", ws_client_id: "fixture-socket" }) })));
  }
  authorize() {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ message_type: "success", provider_config_key: this.provider, connection_id: `${this.provider}-fixture-account` }) }));
  }
  close() { sockets.delete(this); this.dispatchEvent(new Event("close")); }
}
Object.defineProperty(globalThis, "WebSocket", { value: FixtureSocket });
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (showStorage && url.hostname === "www.googleapis.com") {
    const folder = { id: "google-root", name: "My Drive", mimeType: "application/vnd.google-apps.folder", parents: [], version: "1" };
    const company = { ...folder, id: "company-drive", name: "Example firm", driveId: "company-drive" };
    const shared = { ...folder, id: "shared-folder", name: "Shared client documents", parents: ["other-account"], sharedWithMeTime: "2026-10-01T00:00:00Z" };
    const files = [
      { id: "doc-1", name: "Review notes", mimeType: "application/vnd.google-apps.document", parents: [folder.id], version: "1", webViewLink: "https://docs.google.com/document/d/fixture" },
      { id: "pdf-1", name: "Agreement.pdf", mimeType: "application/pdf", size: "12", parents: [folder.id], version: "1" },
      { id: "pdf-2", name: "Agreement.pdf", mimeType: "application/pdf", size: "14", parents: [folder.id], version: "1" },
      { id: "shared-contract", name: "Shared agreement.pdf", mimeType: "application/pdf", size: "14", parents: [shared.id], version: "1" },
      { id: "company-contract", name: "Company agreement.pdf", mimeType: "application/pdf", size: "14", parents: [company.id], driveId: company.id, version: "1" },
    ];
    if (url.pathname.endsWith("/drives")) return Response.json({ drives: [{ id: company.id, name: company.name }] });
    if (url.pathname.endsWith("/files")) {
      const query = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const name = /(?:name|fullText) contains '([^']+)'/.exec(query)?.[1];
      const values = [...files, shared].filter(file => (!parent || file.parents.includes(parent)) && (!name || file.name.toLowerCase().includes(name.toLowerCase())) && (!query.includes("sharedWithMe") || "sharedWithMeTime" in file) && (url.searchParams.get("corpora") !== "drive" || ("driveId" in file && file.driveId === url.searchParams.get("driveId"))) && (url.searchParams.get("corpora") !== "user" || !("driveId" in file)));
      return Response.json({ files: values });
    }
    return Response.json([...files, shared, company].find(file => url.pathname.endsWith(`/${file.id}`)) ?? folder, { headers: { etag: '"fixture-file-version"' } });
  }
  if (showStorage && (url.hostname === "graph.microsoft.com" || url.hostname === "api.onedrive.com")) {
    if (url.pathname.endsWith("/sites")) return Response.json({ value: [{ id: "site-1", displayName: "Example firm", webUrl: "https://fixture.sharepoint.com/sites/example" }] });
    if (url.pathname.endsWith("/drives")) return Response.json({ value: [{ id: "drive-1", name: "Documents", webUrl: "https://fixture.sharepoint.com/Documents" }] });
    if (url.pathname.endsWith("/children")) return Response.json({ value: [{ id: "graph-file", name: "Matter.xlsx", size: 100, file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, parentReference: { id: "graph-root", driveId: "drive-1" }, eTag: '"fixture-version"' }] });
    if (url.pathname.endsWith("/root") || url.pathname.endsWith("/graph-root")) return Response.json({ id: "graph-root", name: "Documents", folder: {}, eTag: '"fixture-version"' });
    return Response.json({ id: "drive-1" });
  }
  if (showDrafts && url.hostname === "gmail.googleapis.com") {
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "fixture@example.com" });
    if (url.pathname.endsWith("/send")) return Response.json({ id: "fixture-sent-message", threadId: "fixture-sent-thread" });
    if (init?.method === "POST") {
      const saved = z.object({ message: z.object({ raw: z.string() }) }).parse(JSON.parse(String(init.body)));
      draftMime.set("gmail", Buffer.from(saved.message.raw, "base64url").toString());
      return Response.json({ id: "fixture-gmail-draft", message: { id: "fixture-gmail-message", threadId: "fixture-gmail-thread" } });
    }
    return Response.json({ message: { id: editedDrafts ? "fixture-gmail-reloaded-message" : "fixture-gmail-message", raw: Buffer.from(mailboxMime("gmail")).toString("base64url") } });
  }
  if (showDrafts && url.hostname === "www.googleapis.com") {
    if (url.pathname.includes("/calendarList/")) return Response.json({ accessRole: "owner", timeZone: "Europe/Berlin", conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] } });
    const id = url.pathname.split("/").at(-1) ?? "";
    const current = calendarEvents.get(id);
    if ((init?.method ?? "GET") === "GET") {
      if (!current) return new Response(null, { status: 404 });
      if (current.conferenceData) current.conferenceData = { createRequest: { status: { statusCode: "success" } }, conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/fixture-meet-link" }] };
      return Response.json(current);
    }
    if (init?.method === "PATCH" && (!current || new Headers(init.headers).get("If-Match") !== current.etag)) return new Response(null, { status: 412 });
    const data = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body ?? "{}")));
    const savedId = init?.method === "PATCH" ? id : `fixture-google-event-${calendarEvents.size}`;
    const saved = { ...current, ...data, id: savedId, etag: '"fixture-v2"', ...(data.conferenceData ? { conferenceData: { createRequest: { status: { statusCode: "pending" } } } } : {}), htmlLink: "https://calendar.google.com/calendar/event?eid=fixture" };
    calendarEvents.set(savedId, saved);
    return Response.json(saved);
  }
  if (showDrafts && url.hostname === "graph.microsoft.com") {
    if (url.pathname.endsWith("/send")) return new Response(null, { status: 202 });
    if (url.pathname.endsWith("/events")) return Response.json({ ...JSON.parse(String(init?.body ?? "{}")), id: "fixture-outlook-event", webLink: "https://outlook.office.com/calendar/item/fixture" });
    if (init?.method === "POST") {
      if (!(init.body instanceof Blob)) throw new Error("Expected Outlook MIME fixture");
      draftMime.set("outlook", Buffer.from(await init.body.text(), "base64").toString());
      return Response.json({ id: "fixture-outlook-draft", changeKey: "fixture-version", webLink: "https://outlook.office.com/mail/item/fixture" });
    }
    if (url.pathname.endsWith("/$value")) return new Response(mailboxMime("outlook"), { headers: { "Content-Type": "message/rfc822" } });
    return Response.json({ isDraft: true, changeKey: editedDrafts ? "fixture-reloaded-version" : "fixture-version" });
  }
  if (url.hostname === "oauth2.googleapis.com" || url.hostname === "login.microsoftonline.com") {
    return Response.json({ access_token: "fixture-direct-token", refresh_token: "fixture-direct-refresh", expires_in: 3600 });
  }
  if (url.hostname === "gmail.googleapis.com") return Response.json({ emailAddress: "fixture@example.com" });
  if (url.hostname === "graph.microsoft.com") {
    if (url.pathname === "/v1.0/me/drive") return Response.json({ id: "fixture-drive", name: "Documents" });
    if (url.pathname === "/v1.0/sites/root") return Response.json({ id: "fixture-site" });
    return Response.json({ value: [] });
  }
  if (showStorage && url.hostname === "connector-fixture.test" && url.pathname.startsWith("/api/storage-connections")) {
    if (url.pathname.endsWith("/sync")) return Response.json({ schemaVersion: 1, orgId: "fixture-firm", canManage: true, connections: [...sharedStorage.values()] });
    if (url.pathname.endsWith("/token")) return Response.json({ accessToken: "fixture-team-storage-token", expiresAt: null });
    if (init?.method === "POST") {
      const value = storageInputSchema.parse(JSON.parse(String(init.body)));
      const id = crypto.randomUUID();
      const clean = { ...value, secrets: {} };
      sharedStorage.set(id, { id, version: 1, updatedAt: new Date().toISOString(), input: clean });
      return Response.json({ connection: { ...clean, id, version: 1, configuredSecrets: [] } });
    }
    return Response.json({ schemaVersion: 1, orgId: "fixture-firm", canManage: true, connections: [...sharedStorage.values()] });
  }
  if (url.hostname !== "connector-fixture.test") return nativeFetch(input, init);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[2] === "outlook-calendar" ? "outlook" : segments[2];
  if (segments.length === 2) return Response.json({ configured: true, providers: showDrafts || showStorage ? connectorDefinitions.map(({ id }) => ({ id })) : [{ id: "gmail" }, { id: "outlook" }] });
  if (segments.at(-1) === "connect" || segments.at(-1) === "reconnect") {
    const body = z.object({ flowId: z.string() }).parse(typeof init?.body === "string" ? JSON.parse(init.body) : {});
    startingProvider = id;
    return Response.json({ sessionToken: "fixture-only", integrationId: id, expiresAt: Date.now() + 5 * 60_000 });
  }
  if (segments.at(-1) === "token") return Response.json({ accessToken: "fixture-mail-token", expiresAt: null });
  if (segments.at(-1) === "disconnect") { connected.delete(id); return Response.json({ ok: true }); }
  return connected.has(id) ? Response.json({ connection: { id: `${id}-fixture-account`, createdAt: new Date().toISOString(), needsReconnect: false } }) : Response.json({}, { status: 404 });
}, { preconnect: nativeFetch.preconnect });
const server = await startServer(config);
if (showStorage) {
  if (storageSignInRequired) {
    const id = "00000000-0000-4000-8000-000000000001";
    sharedStorage.set(id, { id, version: 1, updatedAt: new Date().toISOString(), input: storageInputSchema.parse({
      name: "Company Google Drive", config: { kind: "oauth", provider: "google-drive", root: "", sharingMode: "member" }, readOnly: true, teamInstallation: "automatic",
    }) });
  }
  const owner = JSON.stringify(["https://connector-fixture.test", "fixture-firm", "fixture-user"]);
  for (const provider of connectorDefinitions.filter(item => item.kind === "files")) {
    if (storageSignInRequired && provider.id === "google-drive") continue;
    connected.add(provider.id);
    await writeConnectorConnections(config, owner, provider.id, [{ id: `${provider.id}-fixture-local`, nangoConnectionId: `${provider.id}-fixture-account`, createdAt: null, needsReconnect: false }]);
  }
}
const fixtureDrafts = showDrafts ? await (async () => {
  const owner = JSON.stringify(["https://connector-fixture.test", "fixture-firm", "fixture-user"]);
  for (const id of ["gmail", "outlook", "google-calendar"]) {
    connected.add(id);
    await writeConnectorConnections(config, owner, id, [{ id: `${id}-fixture-local`, nangoConnectionId: `${id}-fixture-account`, createdAt: null, needsReconnect: false }]);
  }
  for (const id of ["gmail", "outlook", "google-calendar", "outlook-calendar"]) await saveConnectorWriteSetting(config, id, { writeAccess: true });
  for (const id of ["outlook", "outlook-calendar"]) await recordConnectorActivation(config, id, "outlook-fixture-local", true);
  const email = { to: ["client@example.com"], subject: "Contract review", body: "Hello,\n\nPlease review the revised agreement before our meeting.\n\nBest regards" };
  const event = { title: "Contract review meeting", start: "2026-10-15T14:00:00+02:00", end: "2026-10-15T15:00:00+02:00", timeZone: "Europe/Berlin", location: "Office", description: "Review the revised agreement.", reminders: [15] };
  return { workspaceId: "fixture-project", gmail: (await prepareConnectorEmailDraft(config, "gmail", email, { directory: root })).draft,
    outlook: (await prepareConnectorEmailDraft(config, "outlook", email, { directory: root })).draft,
    "google-calendar": (await prepareConnectorCalendarDraft(config, "google-calendar", event, { directory: root })).draft,
    "google-calendar-update": (await prepareConnectorCalendarUpdate(config, { eventId: "fixture-existing-event", location: "Meeting room", googleMeet: true }, { directory: root })).draft,
    "outlook-calendar": (await prepareConnectorCalendarDraft(config, "outlook-calendar", event, { directory: root })).draft };
})() : null;
const authorization = Bun.serve({ hostname: "127.0.0.1", port: 44642, async fetch(request) {
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (new URL(request.url).pathname === "/fixture/drafts" && request.method === "GET") return Response.json(fixtureDrafts, { headers });
  const body = z.object({ provider: z.enum(["gmail", "outlook", "google-calendar", "google-drive", "onedrive", "onedrive-personal", "sharepoint-files"]), authUrl: z.string().optional() }).parse(await request.json());
  if (body.authUrl) {
    const auth = new URL(body.authUrl);
    if (auth.hostname === "accounts.google.com" || auth.hostname === "login.microsoftonline.com") {
      const callback = new URL(auth.searchParams.get("redirect_uri")!);
      if (!((callback.hostname === "localhost" || callback.hostname === "127.0.0.1") && callback.protocol === "http:" && callback.port === "53683" && callback.pathname === "/callback")) {
        return new Response("Invalid fixture callback", { status: 400, headers });
      }
      callback.search = new URLSearchParams({ code: "fixture-code", state: auth.searchParams.get("state")! }).toString();
      const result = await nativeFetch(callback);
      return Response.json({ ok: result.ok }, { headers });
    }
  }
  connected.add(body.provider);
  for (const socket of sockets) if (socket.provider === body.provider) socket.authorize();
  return Response.json({ ok: true }, { headers });
} });
// Consent is simulated on a separate port; no test routes are added to the product.
console.log("Connector fixture running: LegalWork 44641, simulated consent 44642.");
const cleanup = async () => { authorization.stop(true); await server.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", cleanup);
process.once("SIGINT", cleanup);
