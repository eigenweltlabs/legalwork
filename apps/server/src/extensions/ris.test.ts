import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { risStatus, risSettingsPath, saveRisSettings, callRisAction } from "./ris.js";
import { callExperimentalExtensionAction, listExperimentalExtensionActions } from "./index.js";
import { EnvService } from "../env-file.js";
import { startServer } from "../server.js";
import { resetOrgPolicyRuntimeForTests, scheduleOrgPolicySync } from "../org-policy.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";

const nativeFetch = globalThis.fetch;
const priorPlatform = process.env.EIGENWELT_PLATFORM_URL;
const priorTokenStore = process.env.LEGALWORK_TOKEN_STORE, priorDb = process.env.LEGALWORK_RUNTIME_DB;
let config: ServerConfig, root: string;
const stops: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legalwork-ris-"));
  config = { host: "127.0.0.1", port: 0, token: "local-client", hostToken: "local-host",
    configPath: join(root, "server.json"), workspaces: [], authorizedRoots: [],
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  process.env.EIGENWELT_PLATFORM_URL = "https://policy.test";
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
});
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  globalThis.fetch = nativeFetch;
  if (priorPlatform === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = priorPlatform;
  await resetOrgPolicyRuntimeForTests(config);
  if (priorTokenStore === undefined) delete process.env.LEGALWORK_TOKEN_STORE; else process.env.LEGALWORK_TOKEN_STORE = priorTokenStore;
  if (priorDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB; else process.env.LEGALWORK_RUNTIME_DB = priorDb;
  await rm(root, { recursive: true, force: true });
});

test("is opt-in, needs no provider credentials, and status/discovery never contact RIS", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; throw new Error("unexpected external request"); }, { preconnect: nativeFetch.preconnect });
  expect(await risStatus(config)).toMatchObject({ enabled: false, allowed: true, requiresAuthentication: false });
  expect(listExperimentalExtensionActions("ris")).toHaveLength(8);
  await expect(callRisAction(config, "ris_about", {})).rejects.toMatchObject({ code: "ris_disabled" });
  await saveRisSettings(config, { enabled: true });
  const value = await callExperimentalExtensionAction(config, new EnvService({ path: join(root, "env.json") }), {
    extensionId: "ris", action: "ris_about", args: {},
  });
  expect(value).toMatchObject({ ok: true, extensionId: "ris", action: "ris_about" });
  expect(JSON.parse(await readFile(risSettingsPath(config), "utf8"))).toEqual({ enabled: true });
  expect(calls).toBe(0);
  await saveRisSettings(config, { enabled: false });
  await expect(callRisAction(config, "ris_list_scopes", {})).rejects.toMatchObject({ code: "ris_disabled" });
});

test("fails closed on corrupt settings and refuses changes on a read-only server", async () => {
  await writeFile(risSettingsPath(config), "broken JSON");
  await expect(risStatus(config)).rejects.toMatchObject({ code: "ris_settings_unreadable" });
  config.readOnly = true;
  await expect(saveRisSettings(config, { enabled: true })).rejects.toMatchObject({ code: "read_only" });
});

test("disabling RIS cancels an active request and prevents subsequent upstream calls", async () => {
  await saveRisSettings(config, { enabled: true });
  let entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++; entered();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
    });
  }, { preconnect: nativeFetch.preconnect });
  const pending = callRisAction(config, "ris_search", { corpus: "federal_law", title: "ABGB" });
  const cancelled = pending.then(() => null, (error: unknown) => error);
  await started;
  await saveRisSettings(config, { enabled: false });
  expect(z.object({ code: z.string() }).parse(await cancelled).code).toBe("ris_cancelled");
  await expect(callRisAction(config, "ris_search", { corpus: "federal_law" })).rejects.toMatchObject({ code: "ris_disabled" });
  expect(calls).toBe(1);
});

test("organization policy blocks activation and execution even if locally enabled", async () => {
  await saveRisSettings(config, { enabled: true });
  await writeEigenweltConnection(config, { platformToken: "test-policy", platformURL: "https://policy.test",
    account: { userId: "user", userName: "User", userEmail: "user@example.test", orgId: "firm", orgName: "Firm" } });
  globalThis.fetch = Object.assign(async () => Response.json({ schemaVersion: 1, orgId: "firm", orgName: "Firm", revision: 1, role: "member", updatedAt: null,
    entries: { "extensions.builtIn": { mode: "enforced", value: { ris: false } } } }), { preconnect: nativeFetch.preconnect });
  await scheduleOrgPolicySync(config, { force: true });
  expect(await risStatus(config)).toMatchObject({ enabled: true, allowed: false });
  await expect(callRisAction(config, "ris_about", {})).rejects.toMatchObject({ code: "org_policy_disallowed" });
  await expect(saveRisSettings(config, { enabled: true })).rejects.toMatchObject({ code: "org_policy_disallowed" });
  expect((await saveRisSettings(config, { enabled: false })).enabled).toBe(false);
});

test("HTTP activation requires host access and native action execution respects enablement", async () => {
  const server = await startServer(config); stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const host = { "x-legalwork-host-token": config.hostToken, "content-type": "application/json" };
  const client = { Authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  expect((await nativeFetch(`${base}/integrations/ris`)).status).toBe(401);
  const status = await nativeFetch(`${base}/integrations/ris`, { headers: client });
  expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ enabled: false });
  const update = { method: "PUT", body: JSON.stringify({ enabled: true }) };
  expect((await nativeFetch(`${base}/integrations/ris`, { ...update, headers: client })).status).toBe(401);
  expect((await nativeFetch(`${base}/integrations/ris`, { ...update, headers: host })).status).toBe(200);
  const action = { method: "POST", headers: client, body: JSON.stringify({ extensionId: "ris", action: "ris_list_scopes", args: { field: "applikation" } }) };
  const response = await nativeFetch(`${base}/experimental/extensions/call`, action);
  expect(response.status).toBe(200);
  const output = z.object({ result: z.object({ applikation: z.array(z.string()) }) }).parse(await response.json());
  expect(output.result.applikation).toContain("BrKons"); expect(output.result.applikation).toHaveLength(39);
  await nativeFetch(`${base}/integrations/ris`, { ...update, headers: host, body: JSON.stringify({ enabled: false }) });
  expect((await nativeFetch(`${base}/experimental/extensions/call`, action)).status).toBe(409);
});
