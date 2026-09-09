import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { startServer, type StartedServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { MailServiceError, type MailService, type MailServiceStatus } from "./service-interface.js";

const auth = { "x-legalwork-host-token": "synthetic-mail-host" };
let directory = "";
const running: StartedServer[] = [];
const envNames = ["LEGALWORK_ENV_STORE", "LEGALWORK_TOKEN_STORE", "XDG_DATA_HOME"];
const originalEnv = new Map(envNames.map(name => [name, process.env[name]]));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "legalwork-mail-api-"));
  process.env.LEGALWORK_ENV_STORE = join(directory, "env.json");
  process.env.LEGALWORK_TOKEN_STORE = join(directory, "tokens.json");
  process.env.XDG_DATA_HOME = join(directory, "data");
});
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
  for (const name of envNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(directory, { recursive: true, force: true });
});
function mockService() {
  let state: MailServiceStatus["state"] = "locked";
  let calls = 0;
  let stops = 0;
  const service: MailService = {
    status() { return { protocolVersion: 1, state, syncSupported: false }; },
    async unlock() { calls++; state = "ready"; },
    async lock() { calls++; state = "locked"; },
    async listAccounts(page) { calls++; return { items: [{ id: page.after ?? "local", provider: "graph", displayName: "Synthetic" }], nextCursor: null }; },
    async listFolders(id) {
      calls++;
      if (id !== "local") throw new MailServiceError("not_found");
      return { items: [], nextCursor: null };
    },
    async stop() { stops++; state = "stopped"; },
  };
  return { service, calls: () => calls, stops: () => stops };
}
async function boot(service?: MailService, host = "127.0.0.1") {
  const config: ServerConfig = {
    host, port: 0, token: "synthetic-mail-collaborator", hostToken: auth["x-legalwork-host-token"],
    configPath: join(directory, "server.json"), approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config, { mail: service });
  running.push(server);
  return { server, base: `http://127.0.0.1:${server.port}/mail/v1`, root: `http://127.0.0.1:${server.port}` };
}

test("mail routes are absent by default and when sharing binds all interfaces", async () => {
  const absent = await boot();
  expect((await fetch(`${absent.base}/status`, { headers: auth })).status).toBe(404);
  const mock = mockService();
  const shared = await boot(mock.service, "0.0.0.0");
  expect((await fetch(`${shared.base}/status`, { headers: auth })).status).toBe(404);
  expect(mock.calls()).toBe(0);
});
test("only host-token auth can access mail; all remote bearer scopes are denied", async () => {
  const mock = mockService();
  const { root, base } = await boot(mock.service);
  expect((await fetch(`${base}/accounts`)).status).toBe(401);
  for (const scope of ["owner", "collaborator", "viewer"]) {
    const issued = await fetch(`${root}/tokens`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ scope, label: "mail isolation test" }) });
    expect(issued.status).toBe(201);
    const { token } = z.object({ token: z.string() }).parse(await issued.json());
    expect((await fetch(`${base}/accounts`, { headers: { authorization: `Bearer ${token}`, "x-legalwork-client-id": "desktop-local" } })).status).toBe(401);
  }
  expect(mock.calls()).toBe(0);
  const allowed = await fetch(`${base}/accounts`, { headers: auth });
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await allowed.json())).not.toContain("owner_id");
});
test("request bodies, owner overrides and malformed pagination cannot reach mail service", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  for (const query of ["ownerId=other", "limit=0", "limit=101", "limit=1&limit=2", "after=", "limit=1e1"]) {
    expect((await fetch(`${base}/accounts?${query}`, { headers: auth })).status).toBe(400);
  }
  const body = await fetch(`${base}/unlock`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"ownerId":"other"}' });
  expect(body.status).toBe(400);
  expect(mock.calls()).toBe(0);
});
test("lock/unlock and bounded pagination flow through injected service; account errors are indistinguishable", async () => {
  const mock = mockService();
  const { base } = await boot(mock.service);
  for (const [operation, state] of [["unlock", "ready"], ["lock", "locked"]]) {
    const response = await fetch(`${base}/${operation}`, { method: "POST", headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: 1, state, syncSupported: false });
  }
  expect((await fetch(`${base}/accounts?limit=1&after=next`, { headers: auth })).status).toBe(200);
  const missing = await fetch(`${base}/accounts/missing/folders`, { headers: auth });
  const foreign = await fetch(`${base}/accounts/foreign-owner/folders`, { headers: auth });
  expect(missing.status).toBe(404);
  expect(foreign.status).toBe(404);
  expect(await missing.json()).toEqual(await foreign.json());
});
test("native/keychain errors are redacted and server shutdown stops the service", async () => {
  const mock = mockService();
  const { base, server } = await boot(mock.service);
  for (const error of [new Error("secret-token private-path mailbox-content"), new ApiError(500, "private", "mail-content", { token: "private-token" })]) {
    mock.service.unlock = async () => { throw error; };
    const response = await fetch(`${base}/unlock`, { method: "POST", headers: auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "mail_unavailable", message: "Mail storage is unavailable" });
  }
  await server.stop();
  running.splice(running.indexOf(server), 1);
  expect(mock.stops()).toBe(1);
});
