import { describe, expect, test } from "bun:test";

import { resolveRequestTimeoutMs } from "../src/app/lib/opencode";

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

  test("other provider requests keep the default", () => {
    expect(resolveRequestTimeoutMs(`${base}/provider?directory=%2Fws`, 10_000)).toBe(10_000);
    expect(resolveRequestTimeoutMs(`${base}/provider/auth`, 10_000)).toBe(10_000);
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
  expect(resolveRequestTimeoutMs("http://localhost:5421/provider", 10_000)).toBe(10_000);
});
