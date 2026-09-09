import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import { exchangeMailOAuthCode, listenMailOAuthLoopback, startMailOAuth, type MailOAuthFlow, type MailOAuthSettings, type OAuthFetch } from "./oauth.js";
const gmail: MailOAuthSettings = { provider: "gmail", applicationType: "desktop", clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: GMAIL_MAIL_SCOPES, pkceMethod: "S256" };
const graph: MailOAuthSettings = { provider: "graph", applicationType: "desktop", clientId: "11111111-2222-3333-4444-555555555555", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", registeredRedirectUri: "http://localhost/mail/callback", scopes: GRAPH_MAIL_SCOPES, pkceMethod: "S256" };
const flows: MailOAuthFlow[] = [];
const success = () => Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: "Mail.ReadWrite Mail.Send", id_token: "unverified.synthetic.id" });
async function start(settings = gmail, options: Parameters<typeof startMailOAuth>[1] = {}) {
  const flow = await startMailOAuth(settings, { fetch: async () => success(), ...options }); flows.push(flow); return flow;
}
afterEach(async () => { await Promise.all(flows.splice(0).map((flow) => flow.cancel())); });
function state(flow: MailOAuthFlow): string { return new URL(flow.authorizationUrl).searchParams.get("state") ?? ""; }
function callback(flow: MailOAuthFlow, query: string, options: { host?: string; path?: string; method?: string; ipv6?: boolean } = {}): Promise<{ status: number; text: string }> {
  const redirect = new URL(flow.redirectUri);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: options.ipv6 ? "::1" : "127.0.0.1", port: redirect.port, method: options.method ?? "GET",
      path: `${options.path ?? redirect.pathname}?${query}`, headers: { Host: options.host ?? redirect.host }, agent: false }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk.toString(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    });
    req.on("error", reject); req.setTimeout(1500, () => req.destroy(new Error("test_timeout"))); req.end();
  });
}
const verifier = "A".repeat(43);
function exchange(fetch: OAuthFetch, settings = gmail, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  return exchangeMailOAuthCode({ settings, code: "synthetic-code", verifier,
    redirectUri: settings.provider === "gmail" ? "http://127.0.0.1:43123/" : "http://localhost:43123/mail/callback", fetch, ...extra });
}

test("fresh cryptographic state and S256 verifier are bound to one Google exchange", async () => {
  let calls = 0;
  let body = new URLSearchParams();
  const flow = await start(gmail, { fetch: async (url, options) => {
    calls++; expect(url).toBe("https://oauth2.googleapis.com/token"); expect(options.redirect).toBe("error");
    expect(options.method).toBe("POST"); expect(typeof options.body).toBe("string");
    body = new URLSearchParams(typeof options.body === "string" ? options.body : ""); return success();
  } });
  const second = await start();
  const auth = new URL(flow.authorizationUrl);
  expect(auth.origin).toBe("https://accounts.google.com");
  expect(state(flow)).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(state(flow)).not.toBe(state(second));
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("access_type")).toBe("offline");
  expect(auth.searchParams.has("client_secret")).toBe(false);
  expect(flow.authorizationUrl).not.toContain("synthetic-secret");
  const page = await callback(flow, `state=${state(flow)}&code=synthetic-code`);
  expect(page.status).toBe(200); expect(page.text).not.toContain("synthetic-code");
  const tokens = await flow.result;
  expect(tokens.accessToken).toBe("synthetic-access"); expect(tokens.unverifiedIdToken).toBe("unverified.synthetic.id");
  expect(body.get("redirect_uri")).toBe(flow.redirectUri); expect(body.get("client_secret")).toBe("synthetic-secret");
  expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")).toBe(auth.searchParams.get("code_challenge") ?? "");
  expect(calls).toBe(1);
  await flow.cancel();
  await expect(callback(flow, `state=${state(flow)}&code=again`)).rejects.toThrow();
});
test("strict host/path/method/state rejects spoofing without consuming valid state", async () => {
  let calls = 0;
  const flow = await start(gmail, { fetch: async () => { calls++; return success(); } });
  const query = `state=${state(flow)}&code=synthetic-code`;
  for (const options of [{ host: "attacker.invalid" }, { path: "/oauth/google-workspace/callback" }, { method: "POST" }]) expect((await callback(flow, query, options)).status).toBe(400);
  for (const invalid of ["state=wrong&error=access_denied", `state=${state(flow)}&state=${state(flow)}&code=code`, `state=${state(flow)}&code=one&code=two`, `state=${state(flow)}&code=one&error=denied`, `state=${state(flow)}&code=one&access_token=forbidden`]) expect((await callback(flow, invalid)).status).toBe(400);
  for (const rawPath of ["/x/../", "/%2e/"]) {
    const redirect = new URL(flow.redirectUri);
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(redirect.port), "127.0.0.1", () => socket.write(`GET ${rawPath}?${query} HTTP/1.1\r\nHost: ${redirect.host}\r\nConnection: close\r\n\r\n`));
      let text = ""; socket.on("data", (chunk) => { text += chunk.toString(); }); socket.on("end", () => resolve(text)); socket.on("error", reject);
    });
    expect(rawResponse.startsWith("HTTP/1.1 400")).toBe(true);
  }
  expect(calls).toBe(0);
  expect((await callback(flow, query)).status).toBe(200); await flow.result; expect(calls).toBe(1);
});
test("valid-state denial is one-use and browser response never reflects provider details", async () => {
  let calls = 0;
  const flow = await start(gmail, { fetch: async () => { calls++; return success(); } });
  const page = await callback(flow, `state=${state(flow)}&error=access_denied&error_description=private-secret%3Cscript%3E`);
  expect(page.status).toBe(200); expect(page.text).not.toContain("private-secret"); expect(page.text).not.toContain("script");
  await expect(flow.result).rejects.toThrow("mail_oauth_denied"); expect(calls).toBe(0);
});
test("simultaneous valid callbacks cannot exchange twice", async () => {
  let complete: (response: Response) => void = () => {};
  let calls = 0;
  const response = new Promise<Response>((resolve) => { complete = resolve; });
  const flow = await start(gmail, { fetch: async () => { calls++; return response; } });
  await Promise.allSettled([callback(flow, `state=${state(flow)}&code=one`), callback(flow, `state=${state(flow)}&code=two`)]);
  expect(calls).toBe(1); complete(success()); await flow.result;
});
test("Graph registered localhost redirect accepts both loopback address families", async () => {
  for (const ipv6 of [false, true]) {
    const flow = await start(graph, { fetch: async (url, options) => {
      expect(url).toBe(`https://login.microsoftonline.com/${graph.provider === "graph" ? graph.tenantId : ""}/oauth2/v2.0/token`);
      const body = new URLSearchParams(typeof options.body === "string" ? options.body : ""); expect(body.has("client_secret")).toBe(false); return success();
    } });
    expect(new URL(flow.redirectUri).hostname).toBe("localhost"); expect(new URL(flow.redirectUri).pathname).toBe("/mail/callback");
    expect(new URL(flow.authorizationUrl).searchParams.get("response_mode")).toBe("query");
    if (ipv6 && !flow.loopbackFamilies.includes("ipv6")) { await flow.cancel(); continue; }
    expect((await callback(flow, `state=${state(flow)}&code=synthetic-code`, { ipv6 })).status).toBe(200); await flow.result;
  }
});
test("Graph retries occupied dual-bind ports and intentionally falls back on disabled IPv6", async () => {
  let v4Attempts = 0;
  let v6Attempts = 0;
  const retried = await start(graph, { listen: async (server, host, port) => {
    if (host === "127.0.0.1") v4Attempts++;
    if (host === "::1" && ++v6Attempts === 1) throw Object.assign(new Error("synthetic bind"), { code: "EADDRINUSE" });
    return listenMailOAuthLoopback(server, host, port);
  } });
  expect(v4Attempts).toBe(2); expect(v6Attempts).toBe(2); await retried.cancel();
  for (const code of ["EAFNOSUPPORT", "EPROTONOSUPPORT", "EADDRNOTAVAIL"]) {
    const flow = await start(graph, { listen: async (server, host, port) => {
      if (host === "::1") throw Object.assign(new Error("synthetic IPv6 disabled"), { code });
      return listenMailOAuthLoopback(server, host, port);
    } });
    expect(flow.loopbackFamilies).toEqual(["ipv4"]);
    expect((await callback(flow, `state=${state(flow)}&code=synthetic-code`)).status).toBe(200); await flow.result;
  }
});
test("expiration and cancellation close listeners and abort in-flight exchange", async () => {
  const expired = await start(gmail, { lifetimeMs: 30 });
  await expect(expired.result).rejects.toThrow("expired"); await expired.cancel();
  await expect(callback(expired, `state=${state(expired)}&code=code`)).rejects.toThrow();
  let signal: AbortSignal | null | undefined;
  const flow = await start(gmail, { fetch: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  await callback(flow, `state=${state(flow)}&code=code`); await flow.cancel();
  await expect(flow.result).rejects.toThrow("cancelled"); expect(signal?.aborted).toBe(true);
});
test("external abort cancels pending flow and pre-aborted flow binds nothing", async () => {
  const controller = new AbortController();
  const flow = await start(gmail, { signal: controller.signal }); controller.abort();
  await expect(flow.result).rejects.toThrow("cancelled"); await flow.cancel();
  await expect(startMailOAuth(gmail, { signal: controller.signal })).rejects.toThrow("cancelled");
});
test("token exchange rejects redirects, status/provider errors and malformed response without reflecting them", async () => {
  const bad = [() => new Response("private-secret", { status: 302, headers: { Location: "https://attacker.invalid" } }),
    () => Response.json({ error: "private-secret", error_description: "secret" }, { status: 400 }),
    () => new Response("private-secret", { headers: { "content-type": "application/json" } }),
    () => Response.json({ access_token: "secret", token_type: "Bearer", expires_in: 0 }),
    () => Response.json({ access_token: "secret", token_type: "Bearer", expires_in: "3600" }),
    () => Response.json({ access_token: "secret", token_type: "MAC", expires_in: 3600 }),
    () => Response.json({ access_token: "secret", token_type: "Bearer", expires_in: 3600, refresh_token: 123 }),
    () => new Response("x".repeat(70000), { headers: { "content-type": "application/json" } })];
  for (const response of bad) {
    try { await exchange(async () => response()); throw new Error("expected_failure"); }
    catch (error) { expect(error instanceof Error && error.message.startsWith("mail_oauth_")).toBe(true); expect(String(error)).not.toContain("private-secret"); }
  }
});
test("fetch/body hangs time out even when injected transport ignores abort", async () => {
  await expect(exchange(async () => new Promise(() => {}), gmail, { timeoutMs: 20 })).rejects.toThrow("exchange_timeout");
  await expect(exchange(async () => new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/json" } }), gmail, { timeoutMs: 20 })).rejects.toThrow("exchange_timeout");
  const controller = new AbortController();
  const pending = exchange(async () => new Promise(() => {}), gmail, { signal: controller.signal }); controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
});
test("missing optional grants/refresh/identity stay absent rather than being assumed", async () => {
  const tokens = await exchange(async () => Response.json({ access_token: "synthetic-access", token_type: "bearer", expires_in: 60 }));
  expect(tokens.grantedScopes).toBeNull(); expect(tokens.refreshToken).toBeNull(); expect(tokens.unverifiedIdToken).toBeNull();
  expect(tokens.expiresAt).toBeGreaterThan(Date.now()); expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 60000);
});
test("unapproved scope upgrade and alternate Graph callback configuration fail before binding", async () => {
  await expect(startMailOAuth({ ...gmail, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] })).rejects.toThrow("configuration_invalid");
  if (graph.provider !== "graph") throw new Error("fixture_invalid");
  await expect(startMailOAuth({ ...graph, registeredRedirectUri: "http://localhost/other" })).rejects.toThrow("configuration_invalid");
  await expect(startMailOAuth({ ...graph, tenantId: "common" })).rejects.toThrow("configuration_invalid");
});

test("built OAuth foundation passes actual Node callback smoke tests", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node executable required for OAuth integration tests");
  const server = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "legalwork-oauth-node-"));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await symlink(join(server, "node_modules"), join(directory, "node_modules"));
    execFileSync("pnpm", ["exec", "tsc", "--outDir", directory, "--rootDir", "src", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--types", "bun-types,node", "src/mail/providers/oauth.ts"], { cwd: server, timeout: 30000, stdio: "pipe" });
    const testPath = join(directory, "mail/providers/oauth.node-test.mjs");
    await copyFile(fileURLToPath(new URL("./oauth.node-test.mjs", import.meta.url)), testPath);
    const output = execFileSync(node, ["--test", testPath], { encoding: "utf8", timeout: 15000, stdio: "pipe" });
    expect(output).toContain("tests 3");
    expect(output).toContain("fail 0");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45000);
