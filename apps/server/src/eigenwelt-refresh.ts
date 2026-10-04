/** Desktop refresh recovery. The request ID is saved before sending and kept
 * until the rotated credentials are saved, so retries survive sleep/restarts. */
import {
  eigenweltPlatformUrl, parseEigenweltAccountIdentity, parseEigenweltEntitlements,
  validateEigenweltPlatformUrl,
} from "./eigenwelt-auth.js";
import {
  claimEigenweltRefreshRequest, readEigenweltConnection, readEigenweltEntitlementsView,
  runtimeDbPath, withEigenweltConnectionLock, writeEigenweltConnection,
  writeEigenweltConnectionIfCurrent,
  type EigenweltConnection, type EigenweltEntitlementsView, type RefreshSnapshot,
} from "./eigenwelt-connection-store.js";
import {
  applyEigenweltPaidManifestModels, applyEigenweltSystemOne,
  clearCachedEigenweltPaidManifest, parseManifestModels,
} from "./eigenwelt-paid-manifest.js";
import type { ServerConfig } from "./types.js";

const REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const inFlight = new Map<string, { refreshToken: string; run: Promise<string | null> }>();

export async function ensureFreshPlatformToken(config: ServerConfig,
  options?: { force?: boolean }): Promise<string | null> {
  const conn = await readEigenweltConnection(config);
  if (!conn.refreshToken) return conn.platformToken;
  if (!options?.force && !conn.refreshRequestId && conn.platformToken &&
    (conn.platformTokenExpiresAt ?? 0) - Date.now() > REFRESH_SKEW_MS) return conn.platformToken;
  const path = runtimeDbPath(config);
  const existing = inFlight.get(path);
  if (existing?.refreshToken === conn.refreshToken) return existing.run;
  const run = doRefresh(config, conn).finally(() => {
    if (inFlight.get(path)?.run === run) inFlight.delete(path);
  });
  inFlight.set(path, { refreshToken: conn.refreshToken, run });
  return run;
}

async function latestToken(config: ServerConfig): Promise<string | null> {
  return (await readEigenweltConnection(config)).platformToken;
}
async function retryLater(config: ServerConfig, expected: RefreshSnapshot, reason: string): Promise<string | null> {
  console.warn(`[eigenwelt-refresh] reconnecting: ${reason}`);
  await writeEigenweltConnectionIfCurrent(config, { refreshError: reason }, expected);
  return latestToken(config);
}
const rejectionCodes = new Set([
  "refresh_token_invalid", "refresh_token_reuse", "refresh_token_expired",
  "refresh_token_revoked", "refresh_token_superseded", "refresh_token_membership", "refresh_token_organization",
]);

async function doRefresh(config: ServerConfig, conn: EigenweltConnection): Promise<string | null> {
  if (!conn.refreshToken) return latestToken(config);
  const requestId = await claimEigenweltRefreshRequest(config, conn.refreshToken);
  if (!requestId) return latestToken(config);
  const expected = { refreshToken: conn.refreshToken, refreshRequestId: requestId };
  let response: Response;
  let payload: unknown;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(`${eigenweltPlatformUrl()}/api/desktop/refresh`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: conn.refreshToken, requestId }),
      signal,
    });
    // The timeout also covers a response whose body never finishes.
    try { payload = await response.json(); }
    catch (error) {
      if (signal.aborted) throw error;
      payload = null;
    }
  } catch {
    return retryLater(config, expected, "network_or_timeout");
  }
  if (response.status === 401) {
    const reason = isRecord(payload) && typeof payload.code === "string" && rejectionCodes.has(payload.code)
      ? payload.code : "refresh_rejected";
    await withEigenweltConnectionLock(config, async () => {
      const cleared = await writeEigenweltConnectionIfCurrent(config, {
        entitlements: null, account: null, platformToken: null, refreshToken: null,
        accessTokenExpiresAt: null,
      }, expected);
      if (cleared) {
        console.warn(`[eigenwelt-refresh] signed out: ${reason}`);
        await clearCachedEigenweltPaidManifest(config);
      }
    });
    return latestToken(config);
  }
  if (!response.ok) return retryLater(config, expected, `http_${response.status}`);
  if (!isRecord(payload) || typeof payload.platformToken !== "string" || !payload.platformToken ||
    typeof payload.refreshToken !== "string" || !payload.refreshToken ||
    typeof payload.accessTokenExpiresAt !== "number" || !Number.isSafeInteger(payload.accessTokenExpiresAt) ||
    payload.accessTokenExpiresAt <= 0) return retryLater(config, expected, "invalid_response");

  const entitlements = parseEigenweltEntitlements(payload.entitlements);
  const account = parseEigenweltAccountIdentity(payload.account);
  let platformURL: string | undefined;
  if (typeof payload.platformURL === "string" && payload.platformURL) {
    try { platformURL = validateEigenweltPlatformUrl(payload.platformURL); }
    catch { console.warn("[eigenwelt-refresh] ignored untrusted platform URL"); }
  }
  // Narrow before the async closure, without asserting/casting the payload.
  const platformToken = payload.platformToken;
  const refreshToken = payload.refreshToken;
  const expiresAt = payload.accessTokenExpiresAt;
  const models = payload.models;
  const systemOne = payload.systemOne;
  await withEigenweltConnectionLock(config, async () => {
    const saved = await writeEigenweltConnectionIfCurrent(config, {
      platformToken, refreshToken, accessTokenExpiresAt: expiresAt,
      refreshRequestId: null, refreshError: null,
      ...(entitlements ? { entitlements } : {}), ...(account ? { account } : {}),
      ...(platformURL ? { platformURL } : {}),
    }, expected);
    if (!saved) return;
    if (Array.isArray(models)) {
      await applyEigenweltPaidManifestModels(config, parseManifestModels(models)).catch(() => undefined);
    }
    await applyEigenweltSystemOne(config, systemOne).catch(() => undefined);
  });
  return latestToken(config);
}

export async function readFreshEntitlementsView(config: ServerConfig,
  options?: { force?: boolean }): Promise<EigenweltEntitlementsView> {
  try { await ensureFreshPlatformToken(config, options); }
  catch {
    // A failed local save leaves the persisted request ID available for retry.
    console.warn("[eigenwelt-refresh] refresh storage unavailable");
  }
  return readEigenweltEntitlementsView(config);
}

/** Clear locally first; a slow remote revoke must not erase a later sign-in. */
export async function revokeEigenweltConnection(config: ServerConfig): Promise<void> {
  const conn = await withEigenweltConnectionLock(config, async () => {
    const current = await readEigenweltConnection(config);
    await writeEigenweltConnection(config, {
      entitlements: null, account: null, platformURL: null, platformToken: null,
      refreshToken: null, accessTokenExpiresAt: null,
    });
    await clearCachedEigenweltPaidManifest(config);
    return current;
  });
  if (conn.refreshToken) {
    try {
      const response = await fetch(`${eigenweltPlatformUrl()}/api/desktop/revoke`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: conn.refreshToken }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      console.warn("[eigenwelt-refresh] remote sign-out unavailable");
    }
  }
}
