/**
 * Keeps the Eigenwelt access token fresh by trading the rotating refresh token
 * at the platform's /api/desktop/refresh endpoint. This is the other half of a
 * proper OAuth native-app flow: short-lived access token + long-lived rotating
 * refresh token, with the platform re-checking membership/subscription and
 * returning current entitlements on each refresh (so plan changes go live).
 *
 * All of this happens server-side — the refresh token never leaves the runtime
 * DB after the initial sign-in, and the app only ever sees entitlements.
 */
import {
  eigenweltPlatformUrl,
  parseEigenweltAccountIdentity,
  parseEigenweltEntitlements,
} from "./eigenwelt-auth.js";
import {
  readEigenweltConnection,
  writeEigenweltConnection,
  type EigenweltEntitlementsView,
} from "./eigenwelt-connection-store.js";
import { readEigenweltEntitlementsView } from "./eigenwelt-connection-store.js";
import type { ServerConfig } from "./types.js";

/** Refresh once fewer than this many ms of access-token life remain. */
const REFRESH_SKEW_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Single-flight: concurrent callers for the same workspace share one refresh.
// Critical for rotation — two parallel refreshes with the same token would trip
// the platform's reuse detection and nuke the whole family.
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Return a currently-valid access token for the workspace, refreshing first if
 * it is missing or about to expire. Returns null when the connection is gone
 * (never signed in) or the refresh was rejected (revoked/expired/reused → the
 * connection is cleared and the app must re-authenticate).
 */
export async function ensureFreshPlatformToken(
  config: ServerConfig,
  workspaceId: string,
  options?: { force?: boolean },
): Promise<string | null> {
  const conn = await readEigenweltConnection(config, workspaceId);
  // Legacy sign-in with no refresh token: use whatever access token we have.
  if (!conn.refreshToken) return conn.platformToken;
  // `force` bypasses the skew short-circuit to re-pull entitlements from the
  // platform on demand (the post-checkout poll) — otherwise a still-valid
  // access token would keep serving the pre-purchase (stale) entitlements.
  if (!options?.force) {
    const expiresAt = conn.platformTokenExpiresAt ?? 0;
    if (conn.platformToken && expiresAt - Date.now() > REFRESH_SKEW_MS) {
      return conn.platformToken;
    }
  }
  return refreshOnce(config, workspaceId);
}

function refreshOnce(config: ServerConfig, workspaceId: string): Promise<string | null> {
  const existing = inFlight.get(workspaceId);
  if (existing) return existing;
  const run = doRefresh(config, workspaceId).finally(() => {
    inFlight.delete(workspaceId);
  });
  inFlight.set(workspaceId, run);
  return run;
}

async function doRefresh(config: ServerConfig, workspaceId: string): Promise<string | null> {
  const conn = await readEigenweltConnection(config, workspaceId);
  if (!conn.refreshToken) return conn.platformToken;

  const platform = eigenweltPlatformUrl();
  let response: Response;
  try {
    response = await fetch(`${platform}/api/desktop/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: conn.refreshToken }),
    });
  } catch {
    // Network blip — keep the current token; the caller retries next tick.
    return conn.platformToken;
  }

  if (response.status === 401) {
    // Refresh token revoked / expired / reuse-detected → sign out cleanly.
    await writeEigenweltConnection(config, workspaceId, {
      entitlements: null,
      account: null,
      platformToken: null,
      refreshToken: null,
      accessTokenExpiresAt: null,
    });
    return null;
  }
  if (!response.ok) {
    // 503 or other transient server-side issue — keep the current token.
    return conn.platformToken;
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (
    !isRecord(payload) ||
    typeof payload.platformToken !== "string" ||
    typeof payload.refreshToken !== "string"
  ) {
    return conn.platformToken;
  }

  const entitlements = parseEigenweltEntitlements(payload.entitlements);
  const account = parseEigenweltAccountIdentity(payload.account);
  const expiresAt =
    typeof payload.accessTokenExpiresAt === "number" ? payload.accessTokenExpiresAt : null;
  const platformURL =
    typeof payload.platformURL === "string" && payload.platformURL.trim()
      ? payload.platformURL.replace(/\/+$/, "")
      : undefined;

  await writeEigenweltConnection(config, workspaceId, {
    platformToken: payload.platformToken,
    refreshToken: payload.refreshToken,
    accessTokenExpiresAt: expiresAt,
    // Only overwrite entitlements when the platform sent a well-formed block;
    // never clear a good snapshot because a refresh omitted it.
    ...(entitlements ? { entitlements } : {}),
    ...(account ? { account } : {}),
    ...(platformURL ? { platformURL } : {}),
  });
  return payload.platformToken;
}

/**
 * App-facing entitlements read that opportunistically refreshes first, so the
 * plan/usage the desktop shows is live (bounded by the access-token lifetime).
 */
export async function readFreshEntitlementsView(
  config: ServerConfig,
  workspaceId: string,
  options?: { force?: boolean },
): Promise<EigenweltEntitlementsView> {
  await ensureFreshPlatformToken(config, workspaceId, options);
  return readEigenweltEntitlementsView(config, workspaceId);
}

/**
 * Sign-out: revoke the refresh-token family at the platform (best-effort) and
 * clear the stored connection. Idempotent.
 */
export async function revokeEigenweltConnection(
  config: ServerConfig,
  workspaceId: string,
): Promise<void> {
  const conn = await readEigenweltConnection(config, workspaceId);
  if (conn.refreshToken) {
    try {
      await fetch(`${eigenweltPlatformUrl()}/api/desktop/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: conn.refreshToken }),
      });
    } catch {
      // best-effort: the local clear below still signs this device out.
    }
  }
  await writeEigenweltConnection(config, workspaceId, {
    entitlements: null,
    account: null,
    platformURL: null,
    platformToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
  });
}
