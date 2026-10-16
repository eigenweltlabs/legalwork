import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createMcpOAuthCallbackBroker } from "../../desktop/electron/mcp-oauth-callback.mjs";

const root = resolve(import.meta.dir, "../../..");
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const targets = process.platform === "darwin" ? [`${arch}-apple-darwin`]
  : process.platform === "win32" ? ["x86_64-pc-windows-msvc.exe"]
    : [`${arch}-unknown-linux-gnu`, `${arch}-unknown-linux-musl`];
const sidecar = process.env.OPENCODE_TEST_BINARY || targets.map(target => join(root, "apps/desktop/resources/sidecars", `opencode-${target}`)).find(existsSync);
if (process.env.OPENCODE_TEST_BINARY && (!sidecar || !existsSync(sidecar))) throw new Error("OPENCODE_TEST_BINARY does not exist");
const describeMaybe = sidecar ? describe : describe.skip;
const name = "mock-refresh";
const statusesSchema = z.record(z.string(), z.object({ status: z.string(), error: z.string().optional() }));
const statsSchema = z.object({ authorizationGrants: z.number(), refreshGrants: z.number(), rejectedRefreshGrants: z.number(), resourceLists: z.number() });
const storedSchema = z.record(z.string(), z.object({ tokens: z.object({ accessToken: z.string(), refreshToken: z.string().optional() }).optional() }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}
function localFetch(input: string | URL, init?: RequestInit) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
}

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await read().catch(() => undefined);
    if (result !== undefined) return result;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function freePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("Missing free port");
  return port;
}

async function fixture(options: Record<string, string> = {}) {
  if (!sidecar) throw new Error("Missing engine binary");
  const temp = mkdtempSync(join(tmpdir(), "legalwork-oauth-refresh-"));
  cleanups.push(() => rmSync(temp, { recursive: true, force: true }));
  const workspaceA = join(temp, "project-a"), workspaceB = join(temp, "project-b");
  const mockPort = freePort(), enginePort = freePort(), callbackPort = freePort();
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const engineUrl = `http://127.0.0.1:${enginePort}`;
  const callbacks = createMcpOAuthCallbackBroker();
  cleanups.push(() => callbacks.close());
  for (const directory of [workspaceA, workspaceB]) {
    mkdirSync(directory);
    writeFileSync(join(directory, "opencode.jsonc"), JSON.stringify({ mcp: { [name]: { type: "remote", url: `${mockUrl}/mcp`, oauth: { callbackPort } } } }));
  }
  const mock = spawn("node", [join(root, "scripts/mock-oauth-mcp-server.mjs")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(mockPort), ISSUER: mockUrl, AUTO_APPROVE: "1",
      DYNAMIC_REGISTRATION: "1", NORMALIZE_LOOPBACK_CALLBACK: "0", CLIENT_ID: "", CLIENT_SECRET: "",
      ACCESS_TOKEN_TTL_SECONDS: "3600", ROTATE_REFRESH_TOKENS: "1", OMIT_REFRESH_TOKEN_ON_REFRESH: "0", REFRESH_DELAY_MS: "0", ...options }, stdio: "ignore",
  });
  cleanups.push(() => stopProcess(mock));
  await waitFor(async () => (await localFetch(`${mockUrl}/health`)).ok ? true : undefined, "mock provider");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_") || key.startsWith("LEGALWORK_")) delete env[key];
  let engine: ChildProcess;
  const startEngine = async () => {
    engine = spawn(sidecar, ["serve", "--hostname", "127.0.0.1", "--port", String(enginePort)], {
      cwd: workspaceA, env: { ...env, XDG_DATA_HOME: join(temp, "data"), XDG_CONFIG_HOME: join(temp, "config"),
        XDG_STATE_HOME: join(temp, "state"), XDG_CACHE_HOME: join(temp, "cache"), OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_TEST_HOME: temp, OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true" }, stdio: "ignore",
    });
    await waitFor(async () => (await localFetch(`${engineUrl}/global/health`)).ok ? true : undefined, "engine");
  };
  cleanups.push(async () => { if (engine) await stopProcess(engine); });
  await startEngine();
  const request = (directory: string, path: string, init?: RequestInit) => {
    const url = new URL(`${engineUrl}${path}`);
    url.searchParams.set("directory", directory);
    return localFetch(url, init);
  };
  const status = async (directory: string) => statusesSchema.parse(await (await request(directory, "/mcp")).json())[name];
  const stats = async () => statsSchema.parse(await (await localFetch(`${mockUrl}/stats`)).json());
  const stored = () => storedSchema.parse(JSON.parse(readFileSync(join(temp, "data/opencode/mcp-auth.json"), "utf8")))[name]?.tokens;
  const resources = async (directory: string) => {
    const response = await request(directory, "/experimental/resource");
    expect(response.ok).toBe(true);
    return z.record(z.string(), z.unknown()).parse(await response.json());
  };
  const expire = async () => { expect((await localFetch(`${mockUrl}/expire`, { method: "POST" })).ok).toBe(true); };
  const signIn = async () => {
    const listener = await callbacks.listen({ redirectUri: `http://127.0.0.1:${callbackPort}/mcp/oauth/callback` });
    const response = await request(workspaceA, `/mcp/${name}/auth`, { method: "POST" });
    expect(response.ok).toBe(true);
    const { authorizationUrl, oauthState } = z.object({ authorizationUrl: z.string(), oauthState: z.string() }).parse(await response.json());
    const waiting = callbacks.wait({ listenerId: listener.listenerId, state: oauthState });
    const approval = await localFetch(authorizationUrl, { redirect: "manual" });
    const location = approval.headers.get("location");
    if (!location) throw new Error("Provider did not return a callback");
    expect((await localFetch(location)).ok).toBe(true);
    const result = await request(workspaceA, `/mcp/${name}/auth/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await waiting) });
    expect(await result.json()).toEqual({ status: "connected" });
  };
  await status(workspaceA);
  await signIn();
  return { workspaceA, workspaceB, status, stats, stored, resources, expire };
}

describeMaybe("MCP token refresh with isolated synthetic credentials", () => {
  beforeAll(() => {
    if (!sidecar) throw new Error("Missing engine binary");
    const expected = z.object({ opencodeVersion: z.string() }).parse(JSON.parse(readFileSync(join(root, "constants.json"), "utf8")));
    const installed = spawnSync(sidecar, ["--version"], { encoding: "utf8" });
    expect(installed.status).toBe(0);
    expect(`v${installed.stdout.trim()}`).toBe(expected.opencodeVersion);
  });

  test("single workspace refreshes a rejected access token and persists its replacement", async () => {
    const f = await fixture({ ACCESS_TOKEN_TTL_SECONDS: "1" });
    const before = f.stored();
    await Bun.sleep(1200);
    expect(Object.keys(await f.resources(f.workspaceA))).toHaveLength(1);
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 0 });
    expect(f.stored()?.accessToken).not.toBe(before?.accessToken);
    expect(f.stored()?.refreshToken).not.toBe(before?.refreshToken);
  }, 60_000);

  test("characterization: concurrent workspace refresh loses one request, then recovers", async () => {
    const f = await fixture({ REFRESH_DELAY_MS: "250" });
    expect(await f.status(f.workspaceB)).toEqual({ status: "connected" });
    await f.expire();
    const results = await Promise.all([f.resources(f.workspaceA), f.resources(f.workspaceB)]);
    // Known defect, not the desired contract: one transport consumes the
    // rotating token before the other refresh completes. Replace these
    // assertions with two successful requests and no rejection when fixed.
    expect(results.map(result => Object.keys(result).length).sort()).toEqual([0, 1]);
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 1, rejectedRefreshGrants: 1 });
    expect(f.stored()?.refreshToken).toBeTruthy();
    expect(await f.status(f.workspaceA)).toEqual({ status: "connected" });
    expect(await f.status(f.workspaceB)).toEqual({ status: "connected" });
    const retries = await Promise.all([f.resources(f.workspaceA), f.resources(f.workspaceB)]);
    expect(retries.map(result => Object.keys(result).length)).toEqual([1, 1]);
  }, 60_000);

  test("a refresh response without refresh_token preserves the previous token", async () => {
    const f = await fixture({ OMIT_REFRESH_TOKEN_ON_REFRESH: "1" });
    const before = f.stored();
    await f.expire();
    expect(Object.keys(await f.resources(f.workspaceA))).toHaveLength(1);
    expect(f.stored()?.refreshToken).toBe(before?.refreshToken);
    await f.expire();
    expect(Object.keys(await f.resources(f.workspaceA))).toHaveLength(1);
    expect(await f.stats()).toMatchObject({ authorizationGrants: 1, refreshGrants: 2 });
  }, 60_000);
});
