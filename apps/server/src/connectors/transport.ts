import { ApiError } from "../errors.js";
import { eigenweltPlatformUrl } from "../eigenwelt-auth.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import type { ServerConfig } from "../types.js";

export function ownerKey(account: { orgId: string; userId: string }) {
  return JSON.stringify([eigenweltPlatformUrl(), account.orgId, account.userId]);
}

export async function brokerIdentity(config: ServerConfig) {
  const token = await ensureFreshPlatformToken(config);
  const connection = await readEigenweltConnection(config);
  if (!token || !connection.account) throw new ApiError(403, "connector_signin_required", "Sign in with Eigenwelt to connect an account.");
  return { token, owner: ownerKey(connection.account) };
}

export async function brokerRequest(config: ServerConfig, method: string, path: string, body?: unknown, expectedOwner?: string): Promise<unknown> {
  const identity = await brokerIdentity(config);
  if (expectedOwner && identity.owner !== expectedOwner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
  const request = async (token: string) => {
    try {
      return await fetch(`${eigenweltPlatformUrl()}/api/connectors${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(35_000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError(502, "connector_broker_unreachable", "Could not reach the account connection service. Try again shortly.");
    }
  };
  let response = await request(identity.token);
  if (response.status === 401) {
    await ensureFreshPlatformToken(config, { force: true });
    const refreshed = await brokerIdentity(config);
    if (refreshed.owner !== identity.owner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
    response = await request(refreshed.token);
  }
  if (!response.ok) {
    const codes: Record<number, [string, string]> = {
      401: ["connector_signin_required", "Sign in with Eigenwelt again to connect an account."],
      403: ["connector_access_denied", "Your Eigenwelt account cannot access this connection."],
      404: ["connector_connection_not_found", "Connection not found. Connect the account again."],
      409: ["connector_reconnect_required", "Reconnect this account to restore access."],
      429: ["connector_rate_limited", "Too many connection requests. Try again shortly."],
      503: ["connectors_not_configured", "Account connections are not available yet. Try again later."],
    };
    const [code, message] = codes[response.status] ?? ["connector_broker_failed", "The account connection service could not complete this request."];
    throw new ApiError(response.status >= 500 ? 502 : response.status, code, message);
  }
  if ((await brokerIdentity(config)).owner !== identity.owner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
  try { return await response.json(); }
  catch { throw new ApiError(502, "connector_broker_invalid", "The account connection service returned an invalid response."); }
}
