import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { githubMcpOAuth } from "@legalwork/types/connector-config";
import { pollGitHubDeviceOAuth, startGitHubDeviceOAuth } from "./github-mcp-oauth.js";

const verification = {
  device_code: "private-device-code",
  user_code: "TEST-CODE",
  verification_uri: "https://github.com/login/device",
  expires_in: 899,
  interval: 5,
};

afterEach(() => mock.restore());

test("GitHub issues a device authorization to LegalWork's public client without a secret", async () => {
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(verification));
  const attempt = await startGitHubDeviceOAuth();
  const [url, init] = request.mock.calls[0];
  expect(url).toBe("https://github.com/login/device/code");
  expect(init?.redirect).toBe("error");
  expect(String(init?.body)).toBe(new URLSearchParams({ client_id: githubMcpOAuth.clientId, scope: "public_repo offline_access" }).toString());
  expect(attempt).toMatchObject({ url: verification.verification_uri, userCode: "TEST-CODE", deviceCode: "private-device-code", interval: 5000 });
  expect(attempt.time.expires - attempt.time.created).toBe(899_000);
});

test("GitHub provider URLs and payloads cannot redirect device sign-in or leak details", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...verification, verification_uri: "https://example.invalid/login" }));
  await expect(startGitHubDeviceOAuth()).rejects.toThrow("GitHub sign-in is unavailable");
});

test("GitHub polling handles pending approval, rate limits, denied access and expiring OAuth tokens", async () => {
  const request = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }))
    .mockResolvedValueOnce(Response.json({ error: "slow_down", interval: 10 }))
    .mockResolvedValueOnce(Response.json({ error: "access_denied" }))
    .mockResolvedValueOnce(Response.json({ access_token: "test-access", refresh_token: "test-refresh", token_type: "bearer", expires_in: 28_800, scope: "public_repo" }));
  expect(await pollGitHubDeviceOAuth(verification.device_code)).toEqual({ status: "pending" });
  expect(await pollGitHubDeviceOAuth(verification.device_code)).toEqual({ status: "slow_down", interval: 10 });
  expect(await pollGitHubDeviceOAuth(verification.device_code)).toEqual({ status: "failed", message: "GitHub authorization was declined." });
  expect(await pollGitHubDeviceOAuth(verification.device_code)).toMatchObject({ status: "complete", token: { refresh_token: "test-refresh", expires_in: 28_800 } });
  const [url, init] = request.mock.calls[0];
  expect(url).toBe("https://github.com/login/oauth/access_token");
  expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
    client_id: githubMcpOAuth.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: verification.device_code,
  });
});
