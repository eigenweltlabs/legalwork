import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { MailPlugins } from "./service.js";
import { localMailEngineToken } from "./access.js";
import { legalworkMailTools } from "../opencode-plugins/legalwork-mail-plugin-tools.js";

const priorEnv = { ...process.env };
const realFetch = globalThis.fetch;
let root: string, base: string, config: ServerConfig, plugins: MailPlugins;
let server: Awaited<ReturnType<typeof startServer>>;
let prompts = 0, posts = 0, allow = true;
let viewerToken = "";
const api = (method: string, path: string, body?: unknown, access: "host" | "engine" | "shared" | "viewer" = "engine") => realFetch(base + path, {
  method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${access === "viewer" ? viewerToken : config.token}`,
    ...(access === "host" ? { "X-LegalWork-Host-Token": config.hostToken } : {}), ...(access === "engine" ? { "X-LegalWork-Mail-Token": localMailEngineToken(config) } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-mail-route-"));
  await mkdir(join(root, "other"));
  for (const key of ["LEGALWORK_TOKEN_STORE", "LEGALWORK_RUNTIME_DB", "LEGALWORK_ENV_STORE", "LEGALWORK_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) process.env[key] = join(root, key);
  config = { host: "127.0.0.1", port: 0, token: "mail-client-fixture", hostToken: "mail-host-fixture", configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 3000 }, corsOrigins: [],
    workspaces: [{ id: "project", name: "Project", path: root, preset: "default", workspaceType: "local" }, { id: "other", name: "Other", path: join(root, "other"), preset: "default", workspaceType: "local" }], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    requestHostApproval: async (request) => { prompts++; expect(request.action).toBe("mail.send"); expect(request.summary).toContain("Exact route-approved email."); return allow ? "allow" : "deny"; },
  };
  plugins = new MailPlugins(join(root, "extensions", "mail-plugins", "accounts.vault"));
  await plugins.vault.update((value) => {
    value.accounts.push({ id: "outlook-account", provider: "outlook", clientId: "f7ae407e-0e9f-442d-a7e5-60cf8740992a", email: "lawyer@example.com", name: "Fixture", canWrite: true, connectedAt: new Date().toISOString(), scopes: ["Mail.ReadWrite", "Mail.Send"], accessToken: "provider-access-fixture", refreshToken: "provider-refresh-fixture", expiresAt: Date.now() + 3600_000 });
    value.grants.project = ["outlook-account"];
  });
  server = await startServer(config); base = `http://127.0.0.1:${server.port}`;
  const viewer = await api("POST", "/tokens", { scope: "viewer", label: "mail-fixture" }, "host");
  viewerToken = z.object({ token: z.string() }).parse(await viewer.json()).token;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin === "https://graph.microsoft.com") {
      if (url.endsWith("/sendMail")) { posts++; return new Response(null, { status: 202 }); }
      if (url.includes("/attachments/")) return Response.json({ "@odata.type": "#microsoft.graph.fileAttachment", id: "attachment", name: "../matter.pdf", contentType: "application/pdf", contentBytes: Buffer.from("fixture-attachment").toString("base64") });
      return Response.json({ value: [{ id: "message", subject: "Matter", from: { emailAddress: { address: "client@example.com" } } }] });
    }
    return realFetch(input, init);
  }, { preconnect: realFetch.preconnect });
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await server?.stop();
  for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
  await rm(root, { recursive: true, force: true });
});

test("only host credentials can manage email connections", async () => {
  expect((await api("GET", "/mail-plugins/outlook/status", undefined, "shared")).status).toBe(401);
  const response = await api("GET", "/mail-plugins/outlook/status?workspaceId=project", undefined, "host");
  expect(response.status).toBe(200);
  const text = await response.text(); expect(text).toContain("lawyer@example.com"); expect(text).not.toContain("provider-access-fixture");
  expect((await api("POST", "/mail-plugins/outlook/connect", { canWrite: true, workspaceId: "project" }, "shared")).status).toBe(401);
});

test("shared and viewer clients cannot read personal email or enumerate accounts", async () => {
  expect((await api("GET", "/workspace/project/mail-plugins/accounts", undefined, "shared")).status).toBe(403);
  expect((await api("GET", "/workspace/project/mail-plugins/accounts", undefined, "viewer")).status).toBe(403);
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", { action: "search", accountId: "outlook-account", query: "matter" }, "shared")).status).toBe(403);
});

test("the local agent sees only accounts granted to its current project", async () => {
  const first = await api("GET", "/workspace/project/mail-plugins/accounts");
  expect(first.status).toBe(200); expect(await first.text()).toContain("lawyer@example.com");
  const other = await api("GET", "/workspace/other/mail-plugins/accounts");
  expect(other.status).toBe(200); expect(await other.text()).not.toContain("lawyer@example.com");
  expect((await api("POST", "/workspace/other/mail-plugins/outlook/actions", { action: "search", accountId: "outlook-account", query: "matter" })).status).toBe(403);
});

test("host removal of a project grant blocks subsequent email tools", async () => {
  const endpoint = "/mail-plugins/outlook/accounts/outlook-account/access";
  expect((await api("POST", endpoint, { workspaceId: "project", enabled: false }, "host")).status).toBe(200);
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", { action: "search", accountId: "outlook-account", query: "matter" })).status).toBe(403);
  expect((await api("POST", endpoint, { workspaceId: "project", enabled: true }, "shared")).status).toBe(401);
  expect((await api("POST", endpoint, { workspaceId: "project", enabled: true }, "host")).status).toBe(200);
});

test("malformed arguments and unsupported providers return an actionable 400", async () => {
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", { action: "send", accountId: "outlook-account", to: ["client@example.com\r\nBcc:other@example.com"] })).status).toBe(400);
  expect((await api("GET", "/mail-plugins/unsupported/status", undefined, "host")).status).toBe(400);
});

test("attachments become bounded local working files without binary model output", async () => {
  const response = await api("POST", "/workspace/project/mail-plugins/outlook/actions", { action: "attachment", accountId: "outlook-account", messageId: "message", attachmentId: "attachment" });
  expect(response.status).toBe(200);
  const value = z.object({ result: z.object({ path: z.string(), filename: z.string(), bytes: z.number() }) }).parse(await response.json());
  expect(value.result.path.startsWith(await realpath(root))).toBe(true);
  expect(value.result.filename).not.toContain("/");
  expect(await readFile(value.result.path, "utf8")).toBe("fixture-attachment");
});

test("HTTP sending requires native approval even when the server has automatic approvals", async () => {
  const body = { action: "send", accountId: "outlook-account", requestId: "fixture_route_send_001", to: ["client@example.com"], subject: "Matter", body: "Exact route-approved email." };
  allow = false;
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", body)).status).toBe(403);
  expect(posts).toBe(0);
  allow = true;
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", body)).status).toBe(200);
  expect((await api("POST", "/workspace/project/mail-plugins/outlook/actions", body)).status).toBe(200);
  expect(prompts).toBe(2); expect(posts).toBe(1);
});

test("the installed agent tool invokes the real workspace API with its mail-only capability", async () => {
  process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = config.token; process.env.LEGALWORK_MAIL_PLUGIN_TOKEN = localMailEngineToken(config);
  const context = { directory: root, sessionID: "fixture-session", messageID: "fixture-message" };
  const result = await legalworkMailTools.mail_search.execute({ provider: "outlook", accountId: "outlook-account", query: "matter" }, context);
  expect(JSON.parse(result).ok).toBe(true); expect(result).toContain("Matter");
  delete process.env.LEGALWORK_MAIL_PLUGIN_TOKEN;
  expect(await legalworkMailTools.mail_search.execute({ provider: "outlook", accountId: "outlook-account", query: "matter" }, context)).toContain("only to the local");
});
