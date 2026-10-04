import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

/** Fixed upstream and path: the desktop never receives a platform credential. */
export async function eigenweltUsageRequest(config: ServerConfig, body?: unknown): Promise<unknown> {
  const token = await ensureFreshPlatformToken(config);
  if (!token) throw new ApiError(401, "sign_in_required", "Sign in with Eigenwelt first.");
  let response: Response;
  try {
    response = await fetch(`${eigenweltPlatformUrl()}/api/usage-control`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new ApiError(502, "usage_unavailable", "Usage controls are temporarily unavailable."); }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new ApiError(response.status, "usage_request_failed", detail);
  }
  return response.json();
}
