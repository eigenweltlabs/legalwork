import { z } from "zod";
import { githubMcpOAuth } from "./connector-config.js";
import { ApiError } from "./errors.js";

const verificationUrl = "https://github.com/login/device";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
const deviceResponse = z.object({
  device_code: z.string().min(1).max(256),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.literal(verificationUrl),
  expires_in: z.number().int().min(1).max(900),
  interval: z.number().int().min(1).max(900),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
  scope: z.string(),
});
const errorResponse = z.object({ error: z.string(), interval: z.number().int().positive().optional() });
type GitHubDevicePoll =
  | { status: "complete"; token: z.infer<typeof tokenResponse> }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "slow_down"; interval?: number }
  | { status: "failed"; message: string };

async function githubOAuthRequest(path: "/login/device/code" | "/login/oauth/access_token", fields: Record<string, string>): Promise<unknown> {
  try {
    const response = await fetch(`https://github.com${path}`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ client_id: githubMcpOAuth.clientId, ...fields }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return await response.json();
  } catch { /* Keep transport details and the response body out of client errors. */ }
  throw new ApiError(502, "github_oauth_unavailable", "GitHub sign-in is unavailable. Try again.");
}

export async function startGitHubDeviceOAuth() {
  const result = deviceResponse.safeParse(await githubOAuthRequest("/login/device/code", { scope: githubMcpOAuth.scope }));
  if (!result.success) throw new ApiError(502, "github_oauth_unavailable", "GitHub sign-in is unavailable. Try again.");
  const data = result.data, created = Date.now();
  return {
    url: data.verification_uri,
    userCode: data.user_code,
    deviceCode: data.device_code,
    interval: data.interval * 1000,
    time: { created, expires: created + data.expires_in * 1000 },
  };
}

export async function pollGitHubDeviceOAuth(deviceCode: string): Promise<GitHubDevicePoll> {
  const body = await githubOAuthRequest("/login/oauth/access_token", { grant_type: deviceGrant, device_code: deviceCode });
  const token = tokenResponse.safeParse(body);
  if (token.success) {
    if (!token.data.scope.split(/[\s,]+/).includes("repo")) {
      return { status: "failed", message: "GitHub did not grant repository access. Start a new sign-in and approve repository access." };
    }
    return { status: "complete", token: token.data };
  }
  const result = errorResponse.safeParse(body);
  switch (result.data?.error) {
    case "authorization_pending": return { status: "pending" };
    case "slow_down": return { status: "slow_down", interval: result.data.interval };
    case "expired_token": return { status: "expired" };
    case "access_denied": return { status: "failed", message: "GitHub authorization was declined." };
    default: return { status: "failed", message: "GitHub could not complete sign-in. Start a new sign-in to try again." };
  }
}
