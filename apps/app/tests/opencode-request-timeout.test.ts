import { describe, expect, test } from "bun:test";

import { createClient, resolveRequestTimeoutMs } from "../src/app/lib/opencode";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

/** Native HTTP protocol fixtures; no inference or real-agent parity claims.
 * Delayed responses deliberately exceed the former ten-second read window.
 */
describe("OpenCode request timeouts", () => {
  const base = "http://127.0.0.1:5421/workspace/ws_1/opencode";

  test("provider OAuth gets the sign-in window, not the default", () => {
    expect(resolveRequestTimeoutMs(`${base}/api/integration/digitalocean/connect/oauth/attempt`, 10_000)).toBe(5 * 60_000);
    expect(resolveRequestTimeoutMs(`${base}/api/integration/openai/connect/oauth?location%5Bdirectory%5D=%2Fws`, 10_000)).toBe(5 * 60_000);
  });

  test("metadata reads allow cold engine bootstrap while writes stay bounded", () => {
    for (const route of ["model", "provider", "integration", "agent", "skill", "command", "plugin", "mcp", "session", "experimental/config"]) {
      expect(resolveRequestTimeoutMs(`${base}/api/${route}`, 10_000)).toBe(90_000);
    }
    expect(resolveRequestTimeoutMs(new Request(`${base}/api/experimental/config`, { method: "PATCH" }), 10_000)).toBe(10_000);
  });
});

test("a queued prompt waits for the full turn while transcript reads stay bounded", () => {
  const url = "http://localhost:5421/w/ws_1/opencode/api/session/ses_1/prompt";
  expect(resolveRequestTimeoutMs(new Request(url, { method: "POST" }), 10_000)).toBe(0);
  expect(resolveRequestTimeoutMs(new Request(url.replace("/prompt","/message")), 10_000)).toBe(10_000);
});

test("direct engine recovery allows OneDrive hydration without slowing ordinary reads", () => {
  const url = "http://localhost:5421/workspace/ws_1/opencode/api/location/reload?location%5Bdirectory%5D=C%3A%5COneDrive";
  expect(resolveRequestTimeoutMs(new Request(url, { method: "POST" }), 10_000)).toBe(90_000);
  expect(resolveRequestTimeoutMs(url, 120_000)).toBe(120_000);
  expect(resolveRequestTimeoutMs("http://localhost:5421/api/info", 10_000)).toBe(10_000);
});

test("cold provider and session reads survive the former deadlines without retrying", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, idleTimeout: 20, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    await Bun.sleep(13_000);
    return Response.json(path.endsWith("/sessions") ? { items: [] } : {location:{directory:"/fixture"},data:[]});
  } });
  try {
    const engine = createClient(String(server.url));
    const api = createLegalworkServerClient({ baseUrl: String(server.url) });
    const [providers, sessions] = await Promise.all([
      engine.provider.list(),
      api.listSessions("ws_cold"),
    ]);
    expect(providers.data).toEqual([]);
    expect(sessions.items).toEqual([]);
    expect(paths.sort()).toEqual(["/api/provider", "/workspace/ws_cold/sessions"]);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("caller cancellation reaches the transport and is not reported as a timeout", async () => {
  const server = Bun.serve({ port: 0, async fetch() {
    await Bun.sleep(250);
    return Response.json({location:{directory:"/fixture"},data:[]});
  } });
  const controller = new AbortController();
  try {
    const pending = createClient(String(server.url)).provider.list({}, { signal: controller.signal });
    controller.abort(new Error("Left the workspace"));
    await expect(pending).rejects.toThrow("Left the workspace");
  } finally {
    server.stop(true);
  }
});

test("connector discovery, registration, storage and native connection survive their existing handshake window", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, idleTimeout: 20, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    await Bun.sleep(11_000);
    if(path === "/api/experimental/mcp/research/connect")return new Response(null,{status:204});
    if (path.endsWith("/probe")) return Response.json({ url: "https://example.com/mcp", reachable: true, auth: "oauth", steps: [] });
    if (path.endsWith("/register-client")) return Response.json({ registered: true, client: { clientId: "test-client" } });
    return Response.json({ items: [{ name: "research", config: { type: "remote", url: "https://example.com/mcp", oauth: {} } }] });
  } });
  try {
    const engine = createClient(String(server.url));
    const api = createLegalworkServerClient({ baseUrl: String(server.url) });
    const payload = { url: "https://example.com/mcp" };
    const [probe, registered, saved, added] = await Promise.all([
      api.probeMcp("ws_test", payload),
      api.registerMcpClient("ws_test", payload),
      api.addMcp("ws_test", { name: "research", config: { type: "remote", ...payload, oauth: {} } }),
      engine.mcp.connect({server:"research",location:{directory:"/fixture"}}),
    ]);
    expect(probe.auth).toBe("oauth");
    expect(registered.registered).toBe(true);
    expect(saved.items.map(item => item.name)).toEqual(["research"]);
    expect(added).toBeUndefined();
    expect(paths.sort()).toEqual(["/api/experimental/mcp/research/connect", "/workspace/ws_test/mcp", "/workspace/ws_test/mcp/probe", "/workspace/ws_test/mcp/register-client"]);
  } finally {
    server.stop(true);
  }
}, 20_000);
