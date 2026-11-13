import { bootstrapRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { prepareConnectorStorage } from "./store.js";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { EmailDraftInputSchema, EmailDraftSchema } from "@legalwork/types/email-draft";
import { CalendarEventDraftSchema } from "@legalwork/types/calendar-event-draft";
import type { ServerConfig } from "../types.js";
import { startServer } from "../server.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { writeConnectorConnections } from "./store.js";
import { recordConnectorActivation, saveConnectorWriteSetting } from "./settings.js";
import { prepareConnectorEmailDraft, prepareConnectorCalendarDraft, prepareConnectorCalendarUpdate, deliverConnectorEmailDraft, deliverConnectorCalendarDraft, refreshConnectorCalendarDraft, reloadConnectorEmailDraft } from "./drafts.js";
import { readDraft, saveEmailDraft, readEmailDraftMime } from "../email-drafts/store.js";
import { callConnectorExtensionAction } from "./index.js";
import { connectorRuntimeCapability } from "./capability.js";

const nativeFetch = globalThis.fetch;
const prior = new Map(["EIGENWELT_PLATFORM_URL", "LEGALWORK_RUNTIME_DB", "LEGALWORK_TOKEN_STORE"].map(key => [key, process.env[key]]));
let root: string, config: ServerConfig;
let requests: { url: URL; method: string; body: string; headers: Headers }[];
let googleEvent: Record<string, unknown>, meetAllowed: boolean, calendarRole: string;
let changed = false, failSend = false, failReload = false, editDuringReload = false, gmailMime = "", outlookMime = "";
const stops: (() => Promise<unknown> | unknown)[] = [];
const owner = JSON.stringify(["https://draft-broker.test", "firm", "user"]);
const email = { to: ["client@example.com"], cc: ["team@example.com"], bcc: ["archive@example.com"], subject: "Review Grüße", body: "Please review.", html: "<p>Please review.</p>", attachments: [{ path: "attachment.txt", contentType: "text/plain" }] };
const mailboxMime = (encoded: string, encoding: "base64url" | "base64") => `From: Fixture User <fixture@example.com>\r\n${Buffer.from(encoded, encoding).toString().replace(/^Subject:.*$/m, changed ? "Subject: Changed by another editor\r" : "$&")}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "connected-drafts-"));
  process.env.EIGENWELT_PLATFORM_URL = "https://draft-broker.test";
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  config = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "project", path: root, name: "Fixture project", preset: "starter", workspaceType: "local" }, { id: "other", path: root, name: "Other", preset: "starter", workspaceType: "local" }], authorizedRoots: [root], readOnly: false,
    startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  await writeFile(join(root, "attachment.txt"), "Synthetic attachment");
  await bootstrapRuntimeOpencodeConfig(config);
  await prepareConnectorStorage(config);
  await writeEigenweltConnection(config, { platformToken: "fixture-platform-token", platformURL: "https://draft-broker.test", account: { userId: "user", userName: "Fixture", userEmail: null, orgId: "firm", orgName: "Fixture" } });
  for (const id of ["gmail", "outlook", "google-calendar"]) await writeConnectorConnections(config, owner, id, [{ id: `${id}-account`, nangoConnectionId: `${id}-private`, createdAt: null, needsReconnect: false }]);
  for (const id of ["gmail", "outlook", "google-calendar", "outlook-calendar"]) await saveConnectorWriteSetting(config, id, { writeAccess: true });
  for (const id of ["outlook", "outlook-calendar"]) await recordConnectorActivation(config, id, "outlook-account", true);
  requests = []; changed = false; failSend = false; failReload = false; editDuringReload = false; gmailMime = ""; outlookMime = "";
  meetAllowed = true; calendarRole = "owner";
  googleEvent = { id: "existing-event", etag: '"original-version"', summary: "Original meeting", description: "Original description", location: "Original room", start: { dateTime: "2026-10-14T16:00:00+02:00", timeZone: "Europe/Berlin" }, end: { dateTime: "2026-10-14T17:00:00+02:00", timeZone: "Europe/Berlin" }, attendees: [{ email: "guest@example.com", responseStatus: "accepted" }], organizer: { email: "fixture@example.com" }, reminders: { useDefault: true }, extendedProperties: { private: { fixture: "preserve" } }, htmlLink: "https://calendar.google.com/calendar/event?eid=fixture" };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
    const body = init?.body instanceof Blob ? await init.body.text() : String(init?.body ?? "");
    const method = init?.method ?? "GET";
    requests.push({ url, body, method, headers: new Headers(init?.headers) });
    if (url.hostname === "draft-broker.test") {
      if (url.pathname.endsWith("/token")) return Response.json({ accessToken: "fixture-access", expiresAt: null });
      if (url.pathname.endsWith("/connection/status")) {
        const fields = z.object({ connectionId: z.string() }).parse(JSON.parse(body));
        return Response.json({ connection: { id: fields.connectionId, createdAt: null, needsReconnect: false } });
      }
      throw new Error("Unexpected credential broker request");
    }
    if (url.hostname === "gmail.googleapis.com") {
      if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "fixture@example.com" });
      if (url.pathname.endsWith("/drafts/send")) return failSend ? new Response(null, { status: 500 }) : Response.json({ id: "sent-message", threadId: "sent-thread" });
      if (method === "GET") {
        if (failReload) return new Response(null, { status: 404 });
        return Response.json({ message: { id: changed ? "changed-message" : "gmail-message", raw: Buffer.from(mailboxMime(gmailMime, "base64url")).toString("base64url") } });
      }
      gmailMime = z.object({ message: z.object({ raw: z.string() }) }).parse(JSON.parse(body)).message.raw;
      return Response.json({ id: "gmail-draft", message: { id: "gmail-message", threadId: "gmail-thread" } });
    }
    if (url.hostname === "www.googleapis.com") {
      if (url.pathname.includes("/calendarList/")) return Response.json({ accessRole: calendarRole, timeZone: "Europe/Berlin", conferenceProperties: { allowedConferenceSolutionTypes: meetAllowed ? ["hangoutsMeet"] : [] } });
      if (method === "GET") return Response.json(googleEvent);
      if (method === "PATCH" && (changed || new Headers(init?.headers).get("If-Match") !== googleEvent.etag)) return new Response(null, { status: 412 });
      if (failSend) return new Response(null, { status: 500 });
      const event = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
      for (const field of ["start", "end"]) if (event[field]) event[field] = Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(event[field])).filter(([, value]) => value !== null));
      googleEvent = { ...(method === "PATCH" ? googleEvent : {}), ...event, id: method === "PATCH" ? googleEvent.id : "google-event", etag: '"saved-version"', htmlLink: "https://calendar.google.com/calendar/event?eid=fixture", ...(event.conferenceData ? { conferenceData: { createRequest: { status: { statusCode: "pending" } } } } : {}) };
      return Response.json(googleEvent);
    }
    if (url.hostname === "graph.microsoft.com") {
      if (url.pathname.endsWith("/send")) return failSend ? new Response(null, { status: 500 }) : new Response(null, { status: 202 });
      if (url.pathname.endsWith("/events")) return Response.json({ ...JSON.parse(body), id: "outlook-event", webLink: "https://outlook.office.com/calendar/item/fixture" });
      if (method === "GET") {
        if (failReload) return new Response(null, { status: 404 });
        if (url.pathname.endsWith("/$value")) {
          const mime = mailboxMime(outlookMime, "base64");
          if (editDuringReload) changed = !changed;
          return new Response(mime, { headers: { "Content-Type": "message/rfc822" } });
        }
        return Response.json({ isDraft: true, changeKey: changed ? "changed-version" : "outlook-version" });
      }
      outlookMime = body;
      return Response.json({ id: "outlook-draft", changeKey: "outlook-version", webLink: "https://outlook.office.com/mail/item/fixture" });
    }
    throw new Error("Unexpected provider request");
  }, { preconnect: nativeFetch.preconnect });
});
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  globalThis.fetch = nativeFetch;
  for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
});
const workspace = () => config.workspaces[0];
const prepareMail = async (id = "gmail") => prepareConnectorEmailDraft(config, id, email, { directory: root });

test("connector create actions return the shared editable cards and make no provider or credential request", async () => {
  for (const id of ["gmail", "outlook"] satisfies Array<"gmail" | "outlook">) {
    const result = await callConnectorExtensionAction(config, id, "create_draft", email, { directory: root });
    const draft = EmailDraftSchema.parse(z.object({ draft: z.unknown() }).parse(result.result).draft);
    expect(draft.connectorTarget?.connectorId).toBe(id);
    expect(draft.delivery).toBeUndefined();
    const updated = await saveEmailDraft(root, workspace().id, EmailDraftInputSchema.parse({ ...draft, subject: "Human edit" }), { id: draft.id, revision: draft.revision });
    expect(updated.connectorTarget).toEqual(draft.connectorTarget);
    expect(updated.revision).not.toBe(draft.revision);
  }
  for (const id of ["google-calendar", "outlook-calendar"] satisfies Array<"google-calendar" | "outlook-calendar">) {
    const result = await callConnectorExtensionAction(config, id, "create_event", { title: "Review", start: "2026-10-14T10:00:00+02:00", end: "2026-10-14T11:00:00+02:00" }, { directory: root });
    const draft = CalendarEventDraftSchema.parse(z.object({ draft: z.unknown() }).parse(result.result).draft);
    expect(draft.connectorTarget?.connectorId).toBe(id);
    expect(draft.delivery).toBeUndefined();
  }
  expect(requests).toHaveLength(0);
});

test("extension draft errors explain arguments and corrected requests create Outlook previews", async () => {
  const server = await startServer(config); stops.push(() => server.stop());
  const call = (body: unknown) => nativeFetch(`http://127.0.0.1:${server.port}/experimental/extensions/call`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-LegalWork-Host-Token": "host" }, body: JSON.stringify(body),
  });
  const envelope = { extensionId: "outlook", action: "create_draft", context: { directory: root } };
  const misplaced = await call({ ...envelope, input: email });
  expect(misplaced.status).toBe(400);
  expect(await misplaced.json()).toMatchObject({ code: "invalid_payload", message: expect.stringContaining("args") });
  const missing = await call({ ...envelope, args: {} });
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "invalid_payload", message: expect.stringContaining("args.subject") });
  const corrected = await call({ ...envelope, args: email });
  expect(corrected.status).toBe(200);
  expect(await corrected.json()).toMatchObject({ ok: true, result: { draft: {
    subject: email.subject, body: email.body, to: email.to.join(", "),
    connectorTarget: { connectorId: "outlook", connectionId: "outlook-account" },
  } } });
  expect(requests.filter(request => request.url.hostname === "graph.microsoft.com")).toHaveLength(0);
});

async function draftApi() {
  const server = await startServer(config); stops.push(() => server.stop());
  return (account: string, headers: Record<string, string> = { "X-LegalWork-Host-Token": "host" }) => nativeFetch(`http://127.0.0.1:${server.port}/workspace/project/email-drafts`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...email, to: '"Client, Example" <client@example.com>', cc: email.cc.join(", "), bcc: email.bcc.join(", "), account }),
  });
}

test("ordinary drafts bind to the sole email account without provider requests and preserve every field", async () => {
  await writeConnectorConnections(config, owner, "gmail", []);
  const call = await draftApi();
  const response = await call("auto");
  expect(response.status).toBe(200);
  const { draft } = z.object({ draft: EmailDraftSchema }).parse(await response.json());
  expect(draft).toMatchObject({ connectorTarget: { connectorId: "outlook", connectionId: "outlook-account" },
    to: '"Client, Example" <client@example.com>', subject: email.subject, body: email.body, html: email.html, attachments: email.attachments });
  expect(draft.delivery).toBeUndefined();
  const stored = EmailDraftSchema.parse(await readDraft(root, draft.id));
  expect(stored.connectorTarget).toEqual(draft.connectorTarget);
  expect(requests.filter(({ url }) => !["/api/sync/events", "/api/desktop/policy", "/api/hub"].includes(url.pathname))).toEqual([]);
});

test("multiple mail accounts require a choice; explicit provider and local choices are respected", async () => {
  const call = await draftApi();
  const ambiguous = await call("auto");
  expect(ambiguous.status).toBe(409);
  expect(await ambiguous.json()).toMatchObject({ code: "email_draft_account_required", message: expect.stringContaining("Ask the user") });
  for (const account of ["gmail", "outlook", "local"] satisfies Array<"gmail" | "outlook" | "local">) {
    const response = await call(account);
    expect(response.status).toBe(200);
    const { draft } = z.object({ draft: EmailDraftSchema }).parse(await response.json());
    expect(draft.connectorTarget?.connectorId).toBe(account === "local" ? undefined : account);
    expect(draft.delivery).toBeUndefined();
  }
  expect(requests.filter(({ url }) => !["/api/sync/events", "/api/desktop/policy", "/api/hub"].includes(url.pathname))).toEqual([]);
});

test("no active email account creates a local draft; a calendar-only Outlook connection is not selected", async () => {
  await writeConnectorConnections(config, owner, "gmail", []);
  await recordConnectorActivation(config, "outlook", "outlook-account", false);
  const call = await draftApi();
  const response = await call("auto");
  expect(response.status).toBe(200);
  const { draft } = z.object({ draft: EmailDraftSchema }).parse(await response.json());
  expect(draft.connectorTarget).toBeUndefined();
  const explicit = await call("outlook");
  expect(explicit.status).toBe(409);
  expect(await explicit.json()).toMatchObject({ code: "connector_not_connected" });
  expect(requests.filter(({ url }) => !["/api/sync/events", "/api/desktop/policy", "/api/hub"].includes(url.pathname))).toEqual([]);
});

test("automatic account choice preserves write restrictions and reports expired connections without fallback", async () => {
  await writeConnectorConnections(config, owner, "gmail", []);
  const call = await draftApi();
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: false });
  const disabled = await call("auto");
  expect(disabled.status).toBe(403);
  expect(await disabled.json()).toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await writeConnectorConnections(config, owner, "outlook", [{ id: "outlook-account", nangoConnectionId: "outlook-private", createdAt: null, needsReconnect: true }]);
  const expired = await call("auto");
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ code: "connector_reconnect_required" });
  expect((await call("local")).status).toBe(200);
  expect(requests.filter(({ url }) => !["/api/sync/events", "/api/desktop/policy", "/api/hub"].includes(url.pathname))).toEqual([]);
});

test("automatic draft binding is limited to the owner and managed engine, not shared clients", async () => {
  await writeConnectorConnections(config, owner, "gmail", []);
  const call = await draftApi();
  const client = { Authorization: `Bearer ${config.token}` };
  for (const headers of [client, { ...client, "x-legalwork-connector-token": "forged" }]) {
    expect((await call("auto", headers)).status).toBe(403);
    expect((await call("outlook", headers)).status).toBe(403);
  }
  expect((await call("local", client)).status).toBe(200);
  const managed = await call("auto", { ...client, "x-legalwork-connector-token": connectorRuntimeCapability(config) });
  expect(managed.status).toBe(200);
  expect(await managed.json()).toMatchObject({ draft: { connectorTarget: { connectorId: "outlook" } } });
  expect(requests.filter(({ url }) => !["/api/sync/events", "/api/desktop/policy", "/api/hub"].includes(url.pathname))).toEqual([]);
});

test("saving and sending reuse the rendered MIME including HTML, Cc, Bcc and attachments, and never send twice", async () => {
  for (const id of ["gmail", "outlook"] satisfies Array<"gmail" | "outlook">) {
    const { draft } = await prepareMail(id);
    const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
    expect(saved.draft.delivery?.state).toBe("saved");
    if (id === "gmail") expect(new URL(saved.draft.delivery?.webUrl ?? "").searchParams.get("authuser")).toBe("fixture@example.com");
    expect(requests.filter(item => item.url.pathname.endsWith("/send"))).toHaveLength(id === "gmail" ? 0 : 1);
    const create = requests.slice().reverse().find(item => item.method === "POST" && item.url.hostname !== "draft-broker.test" && !item.url.pathname.endsWith("/send"));
    if (!create) throw new Error("Expected direct provider draft creation");
    const mime = id === "gmail" ? Buffer.from(z.object({ message: z.object({ raw: z.string() }) }).parse(JSON.parse(create.body)).message.raw, "base64url").toString() : Buffer.from(create.body, "base64").toString();
    expect(mime).toContain("multipart/mixed"); expect(mime).toContain("multipart/alternative"); expect(mime).toContain("archive@example.com");
    expect(mime).toContain(Buffer.from("Synthetic attachment").toString("base64"));
    await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "send")).rejects.toMatchObject({ code: "draft_conflict" });
    const attempts = await Promise.allSettled([0, 1].map(() => deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")));
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const sent = EmailDraftSchema.parse(await readDraft(root, draft.id));
    expect(sent.delivery?.state).toBe("sent");
    await expect(deliverConnectorEmailDraft(config, workspace(), sent.id, sent.revision, "send")).rejects.toMatchObject({ code: "connector_draft_sent" });
    await expect(saveEmailDraft(root, workspace().id, EmailDraftInputSchema.parse(sent), { id: sent.id, revision: sent.revision })).rejects.toMatchObject({ code: "connector_draft_closed" });
  }
  expect(requests.filter(item => item.url.hostname === "gmail.googleapis.com" && item.url.pathname.endsWith("/send"))).toHaveLength(1);
  expect(requests.filter(item => item.url.hostname === "graph.microsoft.com" && item.url.pathname.endsWith("/send"))).toHaveLength(1);
  expect(requests.filter(item => item.url.hostname === "draft-broker.test").every(item => !item.body.includes("client@example.com") && !item.body.includes("Please review"))).toBe(true);
});

test("sending directly from a preview saves the draft first, while wrong connectors and stale local exports fail before mutations", async () => {
  const { draft } = await prepareMail();
  await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "send", "outlook")).rejects.toMatchObject({ code: "connector_draft_provider" });
  expect(requests).toHaveLength(0);
  await writeFile(join(root, draft.path), "Changed export");
  await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "send")).rejects.toMatchObject({ code: "connector_draft_changed" });
  expect(requests.every(item => item.url.hostname === "draft-broker.test")).toBe(true);
  const next = await prepareMail();
  const sent = await deliverConnectorEmailDraft(config, workspace(), next.draft.id, next.draft.revision, "send");
  expect(sent.draft.delivery?.state).toBe("sent");
});

test("write settings, independent Outlook activation, and account replacement block delivery before remote requests", async () => {
  const mail = await prepareMail("outlook");
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: false });
  await expect(deliverConnectorEmailDraft(config, workspace(), mail.draft.id, mail.draft.revision, "send")).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await recordConnectorActivation(config, "outlook", "outlook-account", false);
  await expect(deliverConnectorEmailDraft(config, workspace(), mail.draft.id, mail.draft.revision, "save")).rejects.toMatchObject({ code: "connector_inactive" });
  await expect(prepareConnectorEmailDraft(config, "outlook", email, { directory: root })).rejects.toMatchObject({ code: "connector_inactive" });
  await writeConnectorConnections(config, owner, "outlook", [{ id: "replacement", nangoConnectionId: "replacement-private", createdAt: null, needsReconnect: false }]);
  await expect(deliverConnectorEmailDraft(config, workspace(), mail.draft.id, mail.draft.revision, "send")).rejects.toMatchObject({ code: "connector_connection_not_found" });
  expect(requests).toHaveLength(0);
});

test("provider edits stop sends, and an ambiguous send failure persists across reloads without automatic retries", async () => {
  for (const id of ["gmail", "outlook"] satisfies Array<"gmail" | "outlook">) {
    const { draft } = await prepareMail(id);
    const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
    changed = true;
    await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")).rejects.toMatchObject({ code: "connector_draft_changed" });
    changed = false; failSend = true;
    await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")).rejects.toMatchObject({ code: "connector_api_failed" });
    const latest = EmailDraftSchema.parse(await readDraft(root, draft.id));
    expect(latest.delivery?.state).toBe("uncertain");
    const before = requests.length;
    await expect(deliverConnectorEmailDraft({ ...config }, workspace(), draft.id, latest.revision, "send")).rejects.toMatchObject({ code: "connector_delivery_uncertain" });
    expect(requests).toHaveLength(before);
  }
  expect(requests.filter(item => item.url.pathname.endsWith("/send"))).toHaveLength(2);
});

test("reloading a conflicting mailbox draft refreshes reviewed content and version, then a separate send succeeds", async () => {
  for (const id of ["gmail", "outlook"] satisfies Array<"gmail" | "outlook">) {
    changed = false;
    const { draft } = await prepareMail(id);
    const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
    changed = true;
    await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")).rejects.toMatchObject({ code: "connector_draft_changed" });
    const before = requests.length;
    const reloaded = await reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision);
    expect(requests.slice(before).filter(item => item.url.hostname !== "draft-broker.test").every(item => item.method === "GET")).toBe(true);
    expect(reloaded.draft.subject).toBe("Changed by another editor");
    expect(reloaded.draft.from).toBe('"Fixture User" <fixture@example.com>');
    expect(reloaded.draft.to).toBe("client@example.com"); expect(reloaded.draft.cc).toBe("team@example.com"); expect(reloaded.draft.bcc).toBe("archive@example.com");
    expect(reloaded.draft.body.trim()).toBe(email.body); expect(reloaded.draft.html.trim()).toBe(email.html);
    expect(reloaded.draft.revision).not.toBe(saved.draft.revision);
    expect(reloaded.draft.connectorTarget).toEqual(saved.draft.connectorTarget);
    expect(reloaded.draft.delivery?.id).toBe(saved.draft.delivery?.id);
    expect(id === "gmail" ? reloaded.draft.delivery?.messageId : reloaded.draft.delivery?.version).toBe(id === "gmail" ? "changed-message" : "changed-version");
    expect(reloaded.draft.attachments).toHaveLength(1);
    expect(await readFile(join(root, reloaded.draft.attachments[0].path), "utf8")).toBe("Synthetic attachment");
    expect((await readEmailDraftMime(root, reloaded.draft, 25 * 1024 * 1024)).toString()).toBe(mailboxMime(id === "gmail" ? gmailMime : outlookMime, id === "gmail" ? "base64url" : "base64"));
    await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")).rejects.toMatchObject({ code: "draft_conflict" });
    const sent = await deliverConnectorEmailDraft(config, workspace(), draft.id, reloaded.draft.revision, "send");
    expect(sent.draft.delivery?.state).toBe("sent");
  }
  expect(requests.filter(item => item.url.pathname.endsWith("/send"))).toHaveLength(2);
  expect(requests.filter(item => item.url.hostname === "draft-broker.test").every(item => !item.body.includes("Changed by another editor") && !item.body.includes("Synthetic attachment"))).toBe(true);
});

test("failed reloads preserve the local reviewed snapshot and cannot reset uncertain, sent, or unsaved emails", async () => {
  const { draft } = await prepareMail();
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, draft.revision)).rejects.toMatchObject({ code: "connector_draft_not_saved" });
  const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
  const original = await readFile(join(root, draft.path));
  failReload = true;
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_item_not_found" });
  expect(await readDraft(root, draft.id)).toEqual(saved.draft);
  expect(await readFile(join(root, draft.path))).toEqual(original);
  failReload = false; failSend = true;
  await expect(deliverConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision, "send")).rejects.toMatchObject({ code: "connector_api_failed" });
  const uncertain = EmailDraftSchema.parse(await readDraft(root, draft.id));
  const before = requests.length;
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, uncertain.revision)).rejects.toMatchObject({ code: "connector_draft_not_saved" });
  expect(requests).toHaveLength(before);
  failSend = false;
  const next = await prepareMail();
  const sent = await deliverConnectorEmailDraft(config, workspace(), next.draft.id, next.draft.revision, "send");
  const sentCount = requests.length;
  await expect(reloadConnectorEmailDraft(config, workspace(), sent.draft.id, sent.draft.revision)).rejects.toMatchObject({ code: "connector_draft_not_saved" });
  expect(requests).toHaveLength(sentCount);
});

test("Outlook changes during MIME retrieval leave the local draft and version intact", async () => {
  const { draft } = await prepareMail("outlook");
  const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
  changed = true; editDuringReload = true;
  const original = await readFile(join(root, draft.path));
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_draft_changed" });
  expect(await readDraft(root, draft.id)).toEqual(saved.draft);
  expect(await readFile(join(root, draft.path))).toEqual(original);
  expect(requests.filter(item => item.url.pathname.endsWith("/send"))).toHaveLength(0);
});

test("mailbox reload requires the original active account, write setting and current local revision", async () => {
  const { draft } = await prepareMail("outlook");
  const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
  const before = requests.length;
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, draft.revision)).rejects.toMatchObject({ code: "draft_conflict" });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: false });
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await saveConnectorWriteSetting(config, "outlook", { writeAccess: true });
  await recordConnectorActivation(config, "outlook", "outlook-account", false);
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_inactive" });
  await writeConnectorConnections(config, owner, "outlook", [{ id: "replacement", nangoConnectionId: "replacement-private", createdAt: null, needsReconnect: false }]);
  await expect(reloadConnectorEmailDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_connection_not_found" });
  expect(requests).toHaveLength(before);
});

test("reload routes are owner-only, reject extra provider details, and only read the provider draft", async () => {
  const { draft } = await prepareMail();
  const saved = await deliverConnectorEmailDraft(config, workspace(), draft.id, draft.revision, "save");
  const server = await startServer(config); stops.push(() => server.stop());
  const path = `http://127.0.0.1:${server.port}/workspace/project/connector-drafts/email/${draft.id}/reload`;
  const body = JSON.stringify({ revision: saved.draft.revision });
  const headers = { "Content-Type": "application/json", "X-LegalWork-Host-Token": "host" };
  // Server startup also performs unrelated policy/hub sync in the background.
  const draftRequests = () => requests.filter(item => item.url.hostname !== "draft-broker.test" || item.url.pathname.startsWith("/api/connectors/"));
  const before = draftRequests().length;
  expect((await nativeFetch(path, { method: "POST", body })).status).toBe(401);
  expect((await nativeFetch(path, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: "Bearer client" } })).status).toBe(401);
  expect((await nativeFetch(path.replace("/project/", "/other/"), { method: "POST", body, headers })).status).toBe(409);
  expect((await nativeFetch(path, { method: "POST", body: JSON.stringify({ revision: saved.draft.revision, providerId: "untrusted" }), headers })).status).toBe(400);
  config.readOnly = true;
  expect((await nativeFetch(path, { method: "POST", body, headers })).status).toBe(403);
  config.readOnly = false;
  expect(draftRequests()).toHaveLength(before);
  changed = true;
  const result = await nativeFetch(path, { method: "POST", body, headers });
  expect(result.status).toBe(200);
  const reloaded = z.object({ draft: EmailDraftSchema }).parse(await result.json()).draft;
  expect(reloaded.subject).toBe("Changed by another editor");
  expect(reloaded.delivery?.state).toBe("saved");
  expect(draftRequests().slice(before).filter(item => item.url.hostname !== "draft-broker.test").every(item => item.method === "GET")).toBe(true);
});

test("calendar delivery preserves date, time zone, reminders and selected calendar without invitations or duplicate entries", async () => {
  for (const id of ["google-calendar", "outlook-calendar"] satisfies Array<"google-calendar" | "outlook-calendar">) {
    const { draft } = await prepareConnectorCalendarDraft(config, id, { title: "Review", calendarId: "chosen-calendar", start: "2026-10-14", end: "2026-10-15", allDay: true, timeZone: "Europe/Berlin", reminders: [30] }, { directory: root });
    const saved = await deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision);
    expect(saved.draft.delivery?.state).toBe("saved");
    const count = requests.length;
    await deliverConnectorCalendarDraft(config, workspace(), draft.id, saved.draft.revision);
    expect(requests).toHaveLength(count);
    const post = requests.slice().reverse().find(item => item.url.hostname !== "draft-broker.test");
    if (!post) throw new Error("Expected calendar creation");
    expect(post.url.pathname).toContain("chosen-calendar");
    expect(post.body).not.toContain("client@example.com");
    expect(post.body).toContain(id === "google-calendar" ? '"minutes":30' : '"reminderMinutesBeforeStart":30');
    if (id === "outlook-calendar") expect(post.body).toContain('"timeZone":"Europe/Berlin"');
  }
});

test("Google updates review the existing occurrence and PATCH only selected fields without creating or inviting", async () => {
  googleEvent.recurringEventId = "series";
  const result = await callConnectorExtensionAction(config, "google-calendar", "update_event", { eventId: "existing-event", calendarId: "chosen-calendar", location: "New room" }, { directory: root });
  const draft = CalendarEventDraftSchema.parse(z.object({ draft: z.unknown() }).parse(result.result).draft);
  expect(draft.googleCalendar?.update?.recurringEventId).toBe("series");
  expect(draft.attendees).toBe("guest@example.com");
  expect(draft.googleCalendar?.update?.original.location).toBe("Original room");
  expect(requests.filter(item => item.url.hostname === "www.googleapis.com").every(item => item.method === "GET")).toBe(true);
  const saved = await deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision);
  const writes = requests.filter(item => item.url.hostname === "www.googleapis.com" && item.method !== "GET");
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe("PATCH");
  expect(writes[0].url.pathname).toBe("/calendar/v3/calendars/chosen-calendar/events/existing-event");
  expect(writes[0].url.searchParams.get("sendUpdates")).toBe("none");
  expect(writes[0].url.searchParams.get("conferenceDataVersion")).toBe("1");
  expect(writes[0].headers.get("If-Match")).toBe('"original-version"');
  expect(JSON.parse(writes[0].body)).toEqual({ location: "New room" });
  expect(googleEvent.attendees).toEqual([{ email: "guest@example.com", responseStatus: "accepted" }]);
  expect(googleEvent.extendedProperties).toEqual({ private: { fixture: "preserve" } });
  await deliverConnectorCalendarDraft(config, workspace(), draft.id, saved.draft.revision);
  expect(requests.filter(item => item.url.hostname === "www.googleapis.com" && item.method !== "GET")).toHaveLength(1);
  expect(requests.filter(item => item.url.hostname === "draft-broker.test").every(item => !item.body.includes("Original description") && !item.body.includes("guest@example.com") && !item.body.includes("New room"))).toBe(true);
  expect(requests.some(item => item.url.hostname === "graph.microsoft.com" || item.url.hostname === "gmail.googleapis.com")).toBe(false);
});

test("stale Google event versions reject the edit and do not retry or create an event", async () => {
  const { draft } = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", title: "New title" }, { directory: root });
  changed = true;
  await expect(deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision)).rejects.toMatchObject({ code: "connector_calendar_changed" });
  const stored = CalendarEventDraftSchema.parse(await readDraft(root, draft.id, "calendar"));
  expect(stored.delivery).toBeUndefined();
  expect(stored.googleCalendar?.update?.etag).toBe('"original-version"');
  expect(requests.filter(item => item.url.hostname === "www.googleapis.com" && item.method !== "GET").map(item => item.method)).toEqual(["PATCH"]);
});

test("Google rejects series edits, read-only calendars, unsupported Meet, and Outlook-only update attempts", async () => {
  googleEvent.recurrence = ["RRULE:FREQ=WEEKLY"];
  await expect(prepareConnectorCalendarUpdate(config, { eventId: "existing-event", title: "New title" }, { directory: root })).rejects.toMatchObject({ code: "connector_calendar_series" });
  delete googleEvent.recurrence;
  calendarRole = "reader";
  await expect(prepareConnectorCalendarUpdate(config, { eventId: "existing-event", title: "New title" }, { directory: root })).rejects.toMatchObject({ code: "connector_calendar_read_only" });
  calendarRole = "owner"; meetAllowed = false;
  await expect(prepareConnectorCalendarUpdate(config, { eventId: "existing-event", googleMeet: true }, { directory: root })).rejects.toMatchObject({ code: "connector_meet_unavailable" });
  await expect(prepareConnectorCalendarDraft(config, "google-calendar", { title: "Meet", start: "2026-10-14", end: "2026-10-15", allDay: true, googleMeet: true }, { directory: root })).rejects.toMatchObject({ code: "connector_meet_unavailable" });
  await expect(callConnectorExtensionAction(config, "outlook-calendar", "update_event", { eventId: "existing-event" }, { directory: root })).rejects.toMatchObject({ code: "connector_action_not_found" });
  expect(requests.filter(item => item.url.hostname === "www.googleapis.com" && item.method !== "GET")).toHaveLength(0);
});

test("updates preserve existing Meet links and add a new Meet once with pending, success and failure status", async () => {
  googleEvent.hangoutLink = "https://meet.google.com/aaa-bbbb-ccc";
  const existing = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", description: "New note" }, { directory: root });
  expect(existing.draft.googleCalendar?.conference.url).toBe("https://meet.google.com/aaa-bbbb-ccc");
  const retained = await deliverConnectorCalendarDraft(config, workspace(), existing.draft.id, existing.draft.revision);
  expect(retained.draft.googleCalendar?.conference.url).toBe("https://meet.google.com/aaa-bbbb-ccc");
  expect(JSON.parse(requests.find(item => item.method === "PATCH")?.body ?? "{}")).toEqual({ description: "New note" });
  delete googleEvent.hangoutLink;
  const { draft } = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", googleMeet: true }, { directory: root });
  const pending = await deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision);
  expect(pending.draft.delivery?.state).toBe("saved");
  expect(pending.draft.googleCalendar?.conference.status).toBe("pending");
  const meetWrite = requests.filter(item => item.method === "PATCH").at(-1);
  expect(JSON.parse(meetWrite?.body ?? "{}")).toEqual({ conferenceData: { createRequest: { requestId: draft.googleCalendar?.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } });
  const writeCount = requests.filter(item => item.method === "PATCH").length;
  await deliverConnectorCalendarDraft(config, workspace(), draft.id, pending.draft.revision);
  const stillPending = await refreshConnectorCalendarDraft(config, workspace(), draft.id, pending.draft.revision);
  expect(stillPending.draft.googleCalendar?.conference.status).toBe("pending");
  googleEvent.conferenceData = { createRequest: { status: { statusCode: "success" } }, conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/new-meet-url" }] };
  const success = await refreshConnectorCalendarDraft(config, workspace(), draft.id, stillPending.draft.revision);
  expect(success.draft.googleCalendar?.conference.url).toBe("https://meet.google.com/new-meet-url");
  googleEvent.conferenceData = { createRequest: { status: { statusCode: "failure" } } };
  const failure = await refreshConnectorCalendarDraft(config, workspace(), draft.id, success.draft.revision);
  expect(failure.draft.googleCalendar?.conference.status).toBe("failure");
  expect(failure.draft.delivery?.state).toBe("saved");
  expect(requests.filter(item => item.method === "PATCH")).toHaveLength(writeCount);
});

test("new Meet creation uses a unique persisted request ID and ambiguous writes cannot repeat", async () => {
  const input = { title: "Meet", start: "2026-10-14T10:00:00+02:00", end: "2026-10-14T11:00:00+02:00", googleMeet: true };
  const first = await prepareConnectorCalendarDraft(config, "google-calendar", input, { directory: root });
  const second = await prepareConnectorCalendarDraft(config, "google-calendar", input, { directory: root });
  expect(first.draft.googleCalendar?.requestId).not.toBe(second.draft.googleCalendar?.requestId);
  const saved = await deliverConnectorCalendarDraft(config, workspace(), first.draft.id, first.draft.revision);
  expect(saved.draft.googleCalendar?.conference.status).toBe("pending");
  const post = requests.find(item => item.url.hostname === "www.googleapis.com" && item.method === "POST");
  expect(JSON.parse(post?.body ?? "{}").conferenceData.createRequest.requestId).toBe(first.draft.googleCalendar?.requestId);
  failSend = true;
  await expect(deliverConnectorCalendarDraft(config, workspace(), second.draft.id, second.draft.revision)).rejects.toMatchObject({ code: "connector_api_failed" });
  const uncertain = CalendarEventDraftSchema.parse(await readDraft(root, second.draft.id, "calendar"));
  expect(uncertain.delivery?.state).toBe("uncertain");
  const count = requests.length;
  await expect(deliverConnectorCalendarDraft(config, workspace(), second.draft.id, uncertain.revision)).rejects.toMatchObject({ code: "connector_delivery_uncertain" });
  expect(requests).toHaveLength(count);
});

test("update schedules respect offsets and clear old timed fields when converting to all-day", async () => {
  const timed = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", start: "2026-10-14T16:00:00-04:00", end: "2026-10-14T17:00:00-04:00", timeZone: "America/New_York" }, { directory: root });
  await deliverConnectorCalendarDraft(config, workspace(), timed.draft.id, timed.draft.revision);
  const patch = JSON.parse(requests.find(item => item.method === "PATCH")?.body ?? "{}");
  expect(patch.start).toEqual({ date: null, dateTime: "2026-10-14T20:00:00.000Z", timeZone: "America/New_York" });
  const allDay = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", start: "2026-10-14", end: "2026-10-15", allDay: true }, { directory: root });
  await deliverConnectorCalendarDraft(config, workspace(), allDay.draft.id, allDay.draft.revision);
  const allDayPatch = JSON.parse(requests.filter(item => item.method === "PATCH").at(-1)?.body ?? "{}");
  expect(allDayPatch.start).toEqual({ date: "2026-10-14", dateTime: null, timeZone: null });
  expect(allDayPatch.end).toEqual({ date: "2026-10-15", dateTime: null, timeZone: null });
});

test("Calendar update and Meet refresh recheck write settings, account ownership and local revision", async () => {
  const { draft } = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", googleMeet: true }, { directory: root });
  requests.length = 0;
  await saveConnectorWriteSetting(config, "google-calendar", { writeAccess: false });
  await expect(deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision)).rejects.toMatchObject({ code: "connector_writes_disabled" });
  await expect(prepareConnectorCalendarUpdate(config, { eventId: "existing-event" }, { directory: root })).rejects.toMatchObject({ code: "connector_writes_disabled" });
  expect(requests).toHaveLength(0);
  await saveConnectorWriteSetting(config, "google-calendar", { writeAccess: true });
  const saved = await deliverConnectorCalendarDraft(config, workspace(), draft.id, draft.revision);
  requests.length = 0;
  await expect(refreshConnectorCalendarDraft(config, workspace(), draft.id, draft.revision)).rejects.toMatchObject({ code: "draft_conflict" });
  config.readOnly = true;
  await expect(refreshConnectorCalendarDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "read_only" });
  config.readOnly = false;
  await writeConnectorConnections(config, owner, "google-calendar", [{ id: "replacement", nangoConnectionId: "replacement-private", createdAt: null, needsReconnect: false }]);
  await expect(refreshConnectorCalendarDraft(config, workspace(), draft.id, saved.draft.revision)).rejects.toMatchObject({ code: "connector_connection_not_found" });
  expect(requests).toHaveLength(0);
});

test("Calendar review saves keep trusted update metadata and refresh routes require the host owner", async () => {
  const { draft } = await prepareConnectorCalendarUpdate(config, { eventId: "existing-event", googleMeet: true }, { directory: root });
  const server = await startServer(config); stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}/workspace/project`;
  const headers = { "Content-Type": "application/json", "X-LegalWork-Host-Token": "host" };
  const local = await nativeFetch(`${base}/calendar-drafts/${draft.id}`, { method: "PUT", headers: { ...headers, Authorization: "Bearer client" }, body: JSON.stringify({ ...draft, location: "Human edit", googleCalendar: { ...draft.googleCalendar, update: { eventId: "other-event", etag: "untrusted" } } }) });
  expect(local.status).toBe(200);
  const reviewed = z.object({ draft: CalendarEventDraftSchema }).parse(await local.json()).draft;
  expect(reviewed.googleCalendar).toEqual(draft.googleCalendar);
  const saved = await deliverConnectorCalendarDraft(config, workspace(), draft.id, reviewed.revision);
  const body = JSON.stringify({ revision: saved.draft.revision });
  const path = `${base}/connector-drafts/calendar/${draft.id}/refresh`;
  requests.length = 0;
  expect((await nativeFetch(path, { method: "POST", body })).status).toBe(401);
  expect((await nativeFetch(path, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: "Bearer client" } })).status).toBe(401);
  expect(requests).toHaveLength(0);
  expect((await nativeFetch(path, { method: "POST", body, headers })).status).toBe(200);
  expect(requests.filter(item => item.url.hostname === "www.googleapis.com").every(item => item.method === "GET")).toBe(true);
});

test("delivery routes require host ownership, validate revisions and workspace, and honor read-only mode", async () => {
  const { draft } = await prepareMail();
  const server = await startServer(config); stops.push(() => server.stop());
  const path = `http://127.0.0.1:${server.port}/workspace/project/connector-drafts/email/${draft.id}/deliver`;
  const body = JSON.stringify({ revision: draft.revision, operation: "send" });
  const headers = { "Content-Type": "application/json", "X-LegalWork-Host-Token": "host" };
  expect((await nativeFetch(path, { method: "POST", body })).status).toBe(401);
  expect((await nativeFetch(path, { method: "POST", body, headers: { "Content-Type": "application/json", Authorization: "Bearer client" } })).status).toBe(401);
  expect((await nativeFetch(path.replace("/project/", "/other/"), { method: "POST", body, headers })).status).toBe(404);
  expect((await nativeFetch(path, { method: "POST", body: JSON.stringify({ revision: "invalid", operation: "send" }), headers })).status).toBe(400);
  config.readOnly = true;
  expect((await nativeFetch(path, { method: "POST", body, headers })).status).toBe(403);
  config.readOnly = false;
  const result = await nativeFetch(path, { method: "POST", body, headers });
  expect(result.status).toBe(200);
  expect(z.object({ draft: EmailDraftSchema }).parse(await result.json()).draft.delivery?.state).toBe("sent");
  expect((await readFile(join(root, draft.path), "utf8"))).toContain("X-Unsent: 1");
});
