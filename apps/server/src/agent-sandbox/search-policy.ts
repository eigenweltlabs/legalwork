import { z } from "zod";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { eigenweltHasPremiumModels } from "../eigenwelt-auth.js";
import { eigenweltConnectionPlatformUrl } from "../eigenwelt-endpoints.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";

const policy = z.object({ enabled: z.boolean() });

/** Account policy, independent of the chat's chosen model provider. No query is sent. */
export async function webSearchPolicy(config: ServerConfig): Promise<{ enabled: boolean }> {
  const connection = await readEigenweltConnection(config);
  if (!eigenweltHasPremiumModels(connection.entitlements)) return { enabled: true };
  try {
    const token = await ensureFreshPlatformToken(config);
    if (!token) throw new Error("No platform token");
    const current = await readEigenweltConnection(config);
    if (current.account?.orgId !== connection.account?.orgId || current.account?.userId !== connection.account?.userId) {
      throw new Error("Account changed");
    }
    if (!eigenweltHasPremiumModels(current.entitlements)) return { enabled: true };
    const response = await fetch(`${eigenweltConnectionPlatformUrl(current)}/api/desktop/web-search`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Policy unavailable");
    const result = policy.parse(await response.json());
    const latest = await readEigenweltConnection(config);
    if (latest.account?.orgId !== current.account?.orgId || latest.account?.userId !== current.account?.userId || latest.platformToken !== token) {
      throw new Error("Account changed");
    }
    return result;
  } catch {
    throw new ApiError(503, "web_search_policy_unavailable", "The firm's web search setting could not be checked. Search is unavailable until LegalWork reconnects to the platform.");
  }
}
