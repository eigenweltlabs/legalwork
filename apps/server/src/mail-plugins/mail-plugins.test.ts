import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailActionSchema, type MailProvider } from "@legalwork/types/mail-plugins";
import { MailPlugins } from "./service.js";
import { mailScopes } from "./oauth.js";
import { mailProviderAction } from "./providers.js";
import { ApprovalService } from "../approvals.js";
import type { SavedMailAccount } from "./vault.js";

const realFetch = globalThis.fetch;
const originalId = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID;
const originalSecret = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET;
const services: MailPlugins[] = [];
const roots: string[] = [];
const fixtureAccount = (provider: MailProvider = "outlook", canWrite = true): SavedMailAccount => ({ id: `${provider}-account`, provider, clientId: provider === "outlook" ? "f7ae407e-0e9f-442d-a7e5-60cf8740992a" : "fixture.apps.googleusercontent.com", email: "lawyer@example.com", name: "Fixture Lawyer", canWrite, scopes: mailScopes(provider, canWrite), accessToken: "fixture-access-token", refreshToken: "fixture-refresh-token", expiresAt: Date.now() + 3600_000, connectedAt: "2026-10-08T12:00:00Z" });
async function fixture(provider: MailProvider = "outlook", canWrite = true) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-mail-plugin-")); roots.push(root);
  const service = new MailPlugins(join(root, "accounts.vault")); services.push(service);
  await service.vault.update((value) => { value.accounts.push(fixtureAccount(provider, canWrite)); value.grants.project = [`${provider}-account`]; });
  return service;
}
function providerFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname === "127.0.0.1" || new URL(url).hostname === "localhost") return realFetch(input, init);
    return handler(url, init);
  }, { preconnect: realFetch.preconnect });
}
const send = () => mailActionSchema.parse({ action: "send", accountId: "outlook-account", requestId: "fixture_send_request_001", to: ["client@example.com"], cc: ["partner@example.com"], bcc: ["archive@example.com"], subject: "Matter update", body: "Exact approved text." });
afterEach(async () => {
  for (const service of services.splice(0)) service.oauth.dispose();
  globalThis.fetch = realFetch;
  if (originalId === undefined) delete process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID; else process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID = originalId;
  if (originalSecret === undefined) delete process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET; else process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET = originalSecret;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("mail credentials and addresses are encrypted and excluded from public status", async () => {
  const service = await fixture();
  const bytes = await readFile(service.vault.path);
  expect(bytes.toString()).not.toContain("fixture-access-token");
  expect(bytes.toString()).not.toContain("lawyer@example.com");
  expect((await stat(service.vault.path)).mode & 0o077).toBe(0);
  const status = await service.oauth.status("outlook", "project");
  expect(status.accounts[0]?.workspaceAccess).toBe(true);
  expect(JSON.stringify(status)).not.toContain("fixture-refresh-token");
  expect((await service.oauth.status("gmail")).accounts).toHaveLength(0);
});

test("Outlook sign-in uses the cross-tenant authority, PKCE, callback path and minimal read scopes", async () => {
  const service = await fixture();
  const flow = await service.oauth.start("outlook", false, "project");
  const auth = new URL(flow.authUrl);
  expect(auth.pathname).toBe("/common/oauth2/v2.0/authorize");
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("scope")).toContain("Mail.Read");
  expect(auth.searchParams.get("scope")).not.toContain("Mail.Send");
  expect(new URL(auth.searchParams.get("redirect_uri")!).pathname).toBe("/oauth/mail/outlook/callback");
  service.oauth.cancel("outlook", flow.flowId);
  expect(service.oauth.flowStatus("outlook", flow.flowId).status).toBe("cancelled");
});

test("wrong callback state cannot consume the flow; a valid callback connects only the granted project", async () => {
  const service = await fixture();
  await service.vault.update((value) => { value.accounts = []; value.grants = {}; });
  let exchanges = 0;
  providerFetch((url, init) => {
    if (url.includes("/token")) { exchanges++; expect(String(init?.body)).toContain("code_verifier="); return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "User.Read Mail.Read" }); }
    return Response.json({ id: "provider-user", displayName: "Fixture", mail: "lawyer@example.com" });
  });
  const flow = await service.oauth.start("outlook", false, "only-this-project");
  const auth = new URL(flow.authUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: "wrong", code: "fixture-code" }).toString();
  expect((await realFetch(callback)).status).toBe(400);
  expect(exchanges).toBe(0);
  expect(service.oauth.flowStatus("outlook", flow.flowId).status).toBe("pending");
  callback.searchParams.set("state", auth.searchParams.get("state")!);
  expect((await realFetch(callback)).status).toBe(200);
  expect(service.oauth.flowStatus("outlook", flow.flowId).status).toBe("connected");
  const saved = await service.vault.read();
  expect(saved.accounts[0]?.canWrite).toBe(false);
  expect(saved.grants["only-this-project"]).toEqual([saved.accounts[0]!.id]);
  expect(saved.grants.project).toBeUndefined();
  expect(exchanges).toBe(1);
});

test("Google callback records actual scopes and refuses a grant without email-read access", async () => {
  process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID = "fixture.apps.googleusercontent.com";
  process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET = "fixture-installed-client-secret";
  const service = await fixture("gmail");
  await service.vault.update((value) => { value.accounts = []; });
  providerFetch(() => Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: "openid email" }));
  const flow = await service.oauth.start("gmail", true, "project");
  const auth = new URL(flow.authUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "fixture-code" }).toString();
  expect((await realFetch(callback)).status).toBe(400);
  expect(service.oauth.flowStatus("gmail", flow.flowId).status).toBe("failed");
  expect((await service.vault.read()).accounts).toHaveLength(0);
});

test("Google installed-app sign-in exchanges PKCE and stores the verified account with actual write permissions", async () => {
  process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID = "fixture.apps.googleusercontent.com";
  process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET = "fixture-installed-client-secret";
  const service = await fixture("gmail");
  await service.vault.update((value) => { value.accounts = []; });
  providerFetch((url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const fields = new URLSearchParams(String(init?.body));
      expect(fields.get("client_secret")).toBe("fixture-installed-client-secret");
      expect(fields.get("code_verifier")?.length).toBeGreaterThan(43);
      return Response.json({ access_token: "google-fixture-access", refresh_token: "google-fixture-refresh", expires_in: 3600, scope: mailScopes("gmail", true).join(" ") });
    }
    return Response.json({ sub: "verified-google-user", email: "lawyer@example.com", email_verified: true, name: "Fixture" });
  });
  const flow = await service.oauth.start("gmail", true, "project");
  const auth = new URL(flow.authUrl);
  expect(auth.searchParams.get("scope")).not.toContain("/auth/drive");
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "fixture-code" }).toString();
  expect((await realFetch(callback)).status).toBe(200);
  const status = await service.oauth.status("gmail", "project");
  expect(status.accounts[0]?.canWrite).toBe(true);
  expect(status.accounts[0]?.workspaceAccess).toBe(true);
  expect(JSON.stringify(status)).not.toContain("google-fixture-access");
});

test("cancelling during token exchange prevents a late callback from creating an account", async () => {
  const service = await fixture();
  await service.vault.update((value) => { value.accounts = []; });
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  providerFetch(async (url) => {
    if (url.includes("/token")) { entered?.(); await new Promise<void>((resolve) => { finish = resolve; }); return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: "User.Read Mail.Read" }); }
    return Response.json({ id: "provider-user", displayName: "Fixture", mail: "lawyer@example.com" });
  });
  const flow = await service.oauth.start("outlook", false, "project");
  const auth = new URL(flow.authUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri")!);
  callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "fixture-code" }).toString();
  const response = realFetch(callback).catch(() => null);
  await started;
  service.oauth.cancel("outlook", flow.flowId);
  finish?.(); await response;
  expect((await service.vault.read()).accounts).toHaveLength(0);
});

test("expired tokens are refreshed once and rotated refresh tokens are persisted", async () => {
  const service = await fixture();
  await service.vault.update((value) => { value.accounts[0]!.expiresAt = 0; });
  let refreshes = 0;
  providerFetch(() => { refreshes++; return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "Mail.ReadWrite Mail.Send" }); });
  const accounts = await Promise.all([service.oauth.access("outlook", "outlook-account"), service.oauth.access("outlook", "outlook-account")]);
  expect(refreshes).toBe(1);
  expect(accounts[0]?.accessToken).toBe("rotated-access");
  expect((await service.vault.read()).accounts[0]?.refreshToken).toBe("rotated-refresh");
});

test("read-only grants cannot draft or send", async () => {
  const service = await fixture("outlook", false);
  let called = false;
  providerFetch(() => { called = true; return new Response(null, { status: 202 }); });
  await expect(service.execute("outlook", send(), async () => {})).rejects.toMatchObject({ code: "mail_write_not_granted" });
  expect(called).toBe(false);
});

test("automatic general approvals still prompt for an explicit email send", async () => {
  let prompted = 0;
  const approvals = new ApprovalService({ mode: "auto", timeoutMs: 1000 }, async (request) => { prompted++; expect(request.summary).toContain("Bcc: archive@example.com"); return "deny"; });
  const service = await fixture();
  let submitted = false;
  providerFetch(() => { submitted = true; return new Response(null, { status: 202 }); });
  await expect(service.execute("outlook", send(), async (summary) => {
    const result = await approvals.requestApproval({ workspaceId: "project", action: "mail.send", summary, paths: [], actor: { type: "remote", scope: "collaborator" } }, undefined, { requireExplicit: true });
    if (!result.allowed) throw new Error("denied");
  })).rejects.toThrow("denied");
  expect(prompted).toBe(1); expect(submitted).toBe(false); approvals.dispose();
});

test("approved email content is sent exactly once across concurrent calls and restart", async () => {
  const service = await fixture();
  let submissions = 0, approvals = 0;
  providerFetch((_url, init) => { submissions++; const value = JSON.parse(String(init?.body)); expect(value.message.body.content).toBe("Exact approved text."); expect(value.message.bccRecipients[0].emailAddress.address).toBe("archive@example.com"); return new Response(null, { status: 202 }); });
  const approve = async (summary: string) => { approvals++; expect(summary).toContain("lawyer@example.com"); expect(summary).toContain("Exact approved text."); };
  await Promise.all([service.execute("outlook", send(), approve), service.execute("outlook", send(), approve)]);
  const restarted = new MailPlugins(service.vault.path); services.push(restarted);
  await restarted.execute("outlook", send(), approve);
  expect(submissions).toBe(1); expect(approvals).toBe(1);
});

test("an uncertain send outcome is persisted and never automatically retried", async () => {
  const service = await fixture();
  let submissions = 0;
  providerFetch(() => { submissions++; throw new Error("connection closed after submission"); });
  await expect(service.execute("outlook", send(), async () => {})).rejects.toMatchObject({ code: "mail_send_uncertain" });
  const restarted = new MailPlugins(service.vault.path); services.push(restarted);
  await expect(restarted.execute("outlook", send(), async () => { throw new Error("must not prompt again"); })).rejects.toMatchObject({ code: "mail_send_uncertain" });
  expect(submissions).toBe(1);
});

test("revoking project access during confirmation blocks the send", async () => {
  const service = await fixture();
  let submissions = 0;
  providerFetch(() => { submissions++; return new Response(null, { status: 202 }); });
  await expect(service.execute("outlook", send(), () => service.vault.update((value) => { value.grants.project = []; }), undefined, "project")).rejects.toMatchObject({ code: "mail_project_access_required" });
  expect(submissions).toBe(0);
});

test("Outlook cursors cannot forward a mailbox token to another host or Graph resource", async () => {
  let called = false;
  providerFetch(() => { called = true; return Response.json({ value: [] }); });
  for (const cursor of ["https://attacker.example/messages", "https://graph.microsoft.com/v1.0/users", "https://graph.microsoft.com/v1.0/me/messages#fragment"]) {
    await expect(mailProviderAction(fixtureAccount(), mailActionSchema.parse({ action: "search", accountId: "outlook-account", query: "matter", cursor }))).rejects.toMatchObject({ code: "mail_cursor_invalid" });
  }
  expect(called).toBe(false);
});

test("Gmail MIME preserves Unicode content and prevents subject/address header injection", async () => {
  const action = mailActionSchema.parse({ action: "draft", accountId: "gmail-account", to: ["client@example.com"], subject: "Übernahmeprüfung", body: "Vertrauliche Prüfung ✓" });
  let raw = "";
  providerFetch((_url, init) => { raw = Buffer.from(JSON.parse(String(init?.body)).message.raw, "base64url").toString(); return Response.json({ id: "draft", message: { id: "message", threadId: "thread" } }); });
  await mailProviderAction(fixtureAccount("gmail"), action);
  expect(raw).toContain(Buffer.from("Übernahmeprüfung").toString("base64"));
  expect(raw).toContain("From: lawyer@example.com");
  expect(raw).toContain(Buffer.from("Vertrauliche Prüfung ✓").toString("base64"));
  expect(mailActionSchema.safeParse({ ...action, subject: "Subject\r\nBcc: attacker@example.com" }).success).toBe(false);
  expect(mailActionSchema.safeParse({ ...action, to: ["client@example.com\r\nBcc: attacker@example.com"] }).success).toBe(false);
});

test("reply-all handles quoted names, preserves the thread and excludes the sending account", async () => {
  let raw = "";
  providerFetch((url, init) => {
    if (url.includes("/messages/")) return Response.json({ id: "message", threadId: "thread", payload: { headers: [
      { name: "From", value: '"Smith, Jane" <jane@example.com>' }, { name: "To", value: '"Poensgen, Chris" <lawyer@example.com>, "Doe, John" <john@example.com>' },
      { name: "Cc", value: "partner@example.com" }, { name: "Subject", value: "Matter update" }, { name: "Message-ID", value: "<original@example.com>" },
    ] } });
    const value = JSON.parse(String(init?.body));
    expect(value.message.threadId).toBe("thread"); raw = Buffer.from(value.message.raw, "base64url").toString();
    return Response.json({ id: "draft", message: { id: "reply", threadId: "thread" } });
  });
  await mailProviderAction(fixtureAccount("gmail"), mailActionSchema.parse({ action: "reply_draft", accountId: "gmail-account", messageId: "message", body: "Reply text.", replyAll: true }));
  expect(raw).toContain("To: jane@example.com"); expect(raw).toContain("john@example.com"); expect(raw).toContain("partner@example.com");
  expect(raw).not.toContain("To: lawyer@example.com"); expect(raw).not.toContain("Bcc:"); expect(raw).toContain("In-Reply-To: <original@example.com>");
});

test("disconnect removes account credentials and every project grant", async () => {
  const service = await fixture();
  await service.vault.update((value) => { value.grants.otherProject = ["outlook-account"]; });
  const status = await service.oauth.disconnect("outlook", "outlook-account");
  expect(status.connected).toBe(false); expect(status.providerRevoked).toBe(false);
  expect((await service.vault.read()).grants).toEqual({ project: [], otherProject: [] });
  await expect(service.oauth.access("outlook", "outlook-account")).rejects.toMatchObject({ code: "mail_not_connected" });
});
