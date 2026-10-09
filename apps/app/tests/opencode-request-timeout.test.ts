import { describe, expect, test } from "bun:test";

import { createClient, resolveRequestTimeoutMs } from "../src/app/lib/opencode";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

/**
 * Provider OAuth ("Login with DigitalOcean", "ChatGPT Pro/Plus") long-polls
 * /provider/{id}/oauth/callback until the user finishes signing in. The old
 * pattern (/provider/oauth/) never matched that route, so the poll was cut
 * after 10 s; the retry then reloaded the engine, which drops the pending
 * sign-in, and every later poll failed with ProviderAuthOauthMissing.
 */
describe("OpenCode request timeouts", () => {
  const base = "http://127.0.0.1:5421/workspace/ws_1/opencode";

  test("provider OAuth gets the sign-in window, not the default", () => {
    expect(resolveRequestTimeoutMs(`${base}/provider/digitalocean/oauth/callback`, 10_000)).toBe(5 * 60_000);
    expect(resolveRequestTimeoutMs(`${base}/provider/openai/oauth/authorize?directory=%2Fws`, 10_000)).toBe(5 * 60_000);
  });

  test("metadata reads allow cold engine bootstrap while writes stay bounded", () => {
    for (const route of ["provider?directory=%2Fws", "provider/auth", "config", "config/providers", "mcp", "session"]) {
      expect(resolveRequestTimeoutMs(`${base}/${route}`, 10_000)).toBe(90_000);
    }
    expect(resolveRequestTimeoutMs(new Request(`${base}/config`, { method: "PATCH" }), 10_000)).toBe(10_000);
  });
});

test("a queued prompt waits for the full turn while transcript reads stay bounded", () => {
  const url = "http://localhost:5421/w/ws_1/opencode/session/ses_1/message?directory=%2Fproject";
  expect(resolveRequestTimeoutMs(new Request(url, { method: "POST" }), 10_000)).toBe(0);
  expect(resolveRequestTimeoutMs(new Request(url), 10_000)).toBe(10_000);
});

test("direct engine recovery allows OneDrive hydration without slowing ordinary reads", () => {
  const url = "http://localhost:5421/workspace/ws_1/opencode/instance/dispose?directory=C%3A%5COneDrive";
  expect(resolveRequestTimeoutMs(new Request(url, { method: "POST" }), 10_000)).toBe(90_000);
  expect(resolveRequestTimeoutMs(url, 120_000)).toBe(120_000);
  expect(resolveRequestTimeoutMs("http://localhost:5421/global/health", 10_000)).toBe(10_000);
});

test("cold provider and session reads survive the former deadlines without retrying", async () => {
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, idleTimeout: 20, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    await Bun.sleep(13_000);
    return Response.json(path.endsWith("/sessions") ? { items: [] } : { all: [], connected: [], default: {} });
  } });
  try {
    const engine = createClient(String(server.url));
    const api = createLegalworkServerClient({ baseUrl: String(server.url) });
    const [providers, sessions] = await Promise.all([
      engine.provider.list({}, { throwOnError: true }),
      api.listSessions("ws_cold"),
    ]);
    expect(providers.data?.all).toEqual([]);
    expect(sessions.items).toEqual([]);
    expect(paths.sort()).toEqual(["/provider", "/workspace/ws_cold/sessions"]);
  } finally {
    server.stop(true);
  }
}, 20_000);

test("caller cancellation reaches the transport and is not reported as a timeout", async () => {
  const server = Bun.serve({ port: 0, async fetch() {
    await Bun.sleep(250);
    return Response.json({ all: [], connected: [], default: {} });
  } });
  const controller = new AbortController();
  try {
    const pending = createClient(String(server.url)).provider.list({}, { signal: controller.signal, throwOnError: true });
    controller.abort(new Error("Left the workspace"));
    await expect(pending).rejects.toThrow("Left the workspace");
  } finally {
    server.stop(true);
  }
});
