/**
 * Server-side "Sign in with Eigenwelt" + platform model manifest.
 *
 * The LegalWork server (a long-lived node process) owns the whole OAuth
 * dance so the desktop app never sees Clerk configuration and the engine
 * needs no auth plugin:
 *
 *   1. startEigenweltSignIn() binds a loopback port from a fixed,
 *      pre-registered list, generates PKCE verifier+challenge and a random
 *      `state`, and returns the platform interstitial URL
 *      (https://platform.eigenweltlabs.com/desktop/connect) for the app to open.
 *   2. The interstitial runs under the user's normal web session: sign-in if
 *      needed, firm (organization) picker, then redirect to Clerk's
 *      /oauth/authorize with our challenge and redirect_uri
 *      http://127.0.0.1:<port>/callback.
 *   3. The loopback catches the authorization code and forwards
 *      {state, code, verifier, port} to the platform's exchange endpoint,
 *      which performs the Clerk token exchange server-side and mints a
 *      durable per-(user, org) virtual key plus the current model manifest.
 *   4. The app long-polls waitForEigenweltSignIn() and, on success, writes
 *      the provider block into the per-workspace runtime config and stores
 *      the key in the engine auth store.
 *
 * fetchEigenweltManifest() backs the "Paste an API key" path (and the
 * periodic model refresh): it returns the gateway baseURL and model list
 * from the platform's public manifest endpoint.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  readRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** Pre-registered as exact redirect URIs on the Clerk OAuth application —
 * loopback ports cannot be random. Keep in sync with the platform. */
export const EIGENWELT_LOOPBACK_PORTS = [43117, 43118, 43119] as const;

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;

export function eigenweltPlatformUrl(): string {
  return (process.env.EIGENWELT_PLATFORM_URL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "");
}

/**
 * Accept only the configured Eigenwelt platform origin. The OAuth payload is
 * relayed through the app before persistence, so treating its URL as arbitrary
 * would turn later server-side hub calls into an SSRF primitive.
 */
export function validateEigenweltPlatformUrl(value: string): string {
  const configured = eigenweltPlatformUrl();
  let expected: URL;
  let candidate: URL;
  try {
    expected = new URL(configured);
    candidate = new URL(value.trim());
  } catch {
    throw new Error("Invalid Eigenwelt platform URL.");
  }
  const expectedPath = expected.pathname.replace(/\/+$/, "") || "/";
  const candidatePath = candidate.pathname.replace(/\/+$/, "") || "/";
  if (
    candidate.origin !== expected.origin ||
    candidatePath !== expectedPath ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash
  ) {
    throw new Error("The Eigenwelt platform URL does not match this LegalWork installation.");
  }
  return configured;
}

export type EigenweltManifestModel = {
  id: string;
  name?: string;
  contextLength?: number;
  toolCall?: boolean;
  reasoning?: boolean;
};

/** Per-firm daily usage snapshot from the platform (cents, plus a percentage). */
export type EigenweltUsage = {
  dailyAllowanceCents: number;
  dailyRemainingCents: number;
  /** Share of today's allowance consumed, 0–100 (server-computed). */
  dailyUsedPercent: number;
  extraUsageEnabled: boolean;
  prepaidBalanceCents: number;
};

/**
 * Subscription entitlements the platform attaches to the exchange payload.
 * OPTIONAL end to end: an older platform omits it, so every consumer must
 * treat "no entitlements" as the free/legacy tier and not break.
 */
export type EigenweltEntitlements = {
  plan: "plus" | "pro" | null;
  subscriptionStatus: string | null;
  features: string[];
  seats: number;
  usage: EigenweltUsage;
};

export type EigenweltAccountIdentity = {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  orgId: string;
  orgName: string;
};

/**
 * Active-subscription check. The platform emits the `premium_models` feature
 * ONLY when the org isEntitled (plan plus/pro with an active/trialing/past_due
 * status), so this is the authoritative "has an active sub" signal — stricter
 * than merely being signed in. Used to gate the paid Eigenwelt provider.
 */
export function eigenweltHasPremiumModels(
  entitlements: EigenweltEntitlements | null | undefined,
): boolean {
  return entitlements?.features.includes("premium_models") ?? false;
}

export type EigenweltSignInPayload = {
  apiKey: string;
  baseURL: string;
  orgId?: string;
  orgName?: string;
  account?: EigenweltAccountIdentity;
  models: EigenweltManifestModel[];
  /** Present only when the platform ships subscription data (parse tolerantly). */
  entitlements?: EigenweltEntitlements;
  /** Short-lived Bearer for the platform hub APIs (~15 min). Secret. */
  platformToken?: string;
  /** Epoch millis when `platformToken` expires; the server refreshes before then. */
  accessTokenExpiresAt?: number;
  /** Long-lived rotating refresh token (secret) — server-side only after sign-in. */
  refreshToken?: string;
  /** Platform origin for hub/billing links, e.g. https://platform.eigenweltlabs.com. */
  platformURL?: string;
};

export type EigenweltManifest = {
  baseURL: string;
  models: EigenweltManifestModel[];
};

type SignInSession = {
  result: Promise<EigenweltSignInPayload>;
};

const sessions = new Map<string, SignInSession>();

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

const CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Eigenwelt — connected</title>
<style>body{font-family:system-ui,sans-serif;background:#fefefe;color:#0e0a07;display:grid;place-items:center;min-height:90vh}main{text-align:center}h1{font-weight:500;letter-spacing:-0.04em}p{color:rgba(14,10,7,.55)}</style>
</head><body><main><h1>You're connected.</h1><p>Return to LegalWork — this tab can be closed.</p></main></body></html>`;

const ENTITLEMENT_FEATURES = new Set([
  "admin_hub",
  "settings_presets",
  "org_management",
  "premium_models",
]);

function toFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Defensively parse the OPTIONAL `entitlements` block from the exchange
 * payload. Returns undefined when the field is absent or too malformed to
 * trust — callers treat that as the free/legacy tier. Never throws.
 */
export function parseEigenweltEntitlements(value: unknown): EigenweltEntitlements | undefined {
  if (!isRecord(value)) return undefined;
  const plan = value.plan === "plus" || value.plan === "pro" ? value.plan : null;
  const subscriptionStatus = typeof value.subscriptionStatus === "string" ? value.subscriptionStatus : null;
  const features = Array.isArray(value.features)
    ? [...new Set(value.features.filter((f): f is string => typeof f === "string" && ENTITLEMENT_FEATURES.has(f)))]
    : [];
  const usageRaw = isRecord(value.usage) ? value.usage : {};
  const dailyAllowanceCents = toFiniteNumber(usageRaw.dailyAllowanceCents);
  const dailyRemainingCents = toFiniteNumber(usageRaw.dailyRemainingCents);
  // Prefer the server-computed percentage; derive it from cents as a fallback
  // for older platforms that don't send `dailyUsedPercent` yet.
  const derivedUsedPercent =
    dailyAllowanceCents === 0
      ? 0
      : ((dailyAllowanceCents - dailyRemainingCents) / dailyAllowanceCents) * 100;
  const dailyUsedPercent = Math.max(
    0,
    Math.min(100, Math.round(toFiniteNumber(usageRaw.dailyUsedPercent, derivedUsedPercent))),
  );
  return {
    plan,
    subscriptionStatus,
    features,
    seats: toFiniteNumber(value.seats),
    usage: {
      dailyAllowanceCents,
      dailyRemainingCents,
      dailyUsedPercent,
      extraUsageEnabled: usageRaw.extraUsageEnabled === true,
      prepaidBalanceCents: toFiniteNumber(usageRaw.prepaidBalanceCents),
    },
  };
}

export function parseEigenweltAccountIdentity(value: unknown): EigenweltAccountIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const userId = typeof value.userId === "string" ? value.userId.trim() : "";
  const orgId = typeof value.orgId === "string" ? value.orgId.trim() : "";
  const orgName = typeof value.orgName === "string" ? value.orgName.trim() : "";
  if (!userId || !orgId || !orgName) return undefined;
  return {
    userId,
    userName: typeof value.userName === "string" && value.userName.trim() ? value.userName.trim() : null,
    userEmail: typeof value.userEmail === "string" && value.userEmail.trim() ? value.userEmail.trim() : null,
    orgId,
    orgName,
  };
}

async function bindLoopback(
  handler: (req: IncomingMessage, res: ServerResponse, port: number) => void,
): Promise<{ server: Server; port: number }> {
  for (const port of EIGENWELT_LOOPBACK_PORTS) {
    const server = await new Promise<Server | null>((resolve) => {
      const candidate = createServer((req, res) => handler(req, res, port));
      candidate.once("error", () => resolve(null));
      candidate.listen(port, "127.0.0.1", () => resolve(candidate));
    });
    if (server) return { server, port };
  }
  throw new Error(
    `Sign-in ports are busy (${EIGENWELT_LOOPBACK_PORTS.join(", ")}). Close other LegalWork sign-in attempts and retry.`,
  );
}

/**
 * Begin a sign-in: bind the loopback, register an in-memory session, and
 * return the interstitial URL for the app to open in the user's browser.
 * The session resolves once the browser callback lands and the platform
 * exchange succeeds; a 10-minute timeout tears down the loopback.
 */
export async function startEigenweltSignIn(): Promise<{ sessionId: string; authorizeUrl: string }> {
  const platform = eigenweltPlatformUrl();
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(24));
  const sessionId = base64url(randomBytes(18));

  let resolvePayload!: (payload: EigenweltSignInPayload) => void;
  let rejectPayload!: (error: Error) => void;
  const result = new Promise<EigenweltSignInPayload>((resolve, reject) => {
    resolvePayload = resolve;
    rejectPayload = reject;
  });
  // A failed flow may settle while nobody is long-polling; keep the rejection
  // from surfacing as an unhandled rejection (pollers still receive it).
  result.catch(() => undefined);

  let settled = false;
  let teardown = () => {};
  const settleOk = (payload: EigenweltSignInPayload) => {
    if (settled) return;
    settled = true;
    resolvePayload(payload);
  };
  const settleErr = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectPayload(error);
  };

  const exchange = async (code: string, port: number) => {
    try {
      const response = await fetch(`${platform}/api/desktop/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, code, verifier, port }),
      });
      if (!response.ok) {
        settleErr(
          new Error(`Eigenwelt sign-in failed: the platform rejected the code exchange (HTTP ${response.status}).`),
        );
        return;
      }
      const payload = (await response.json()) as Partial<EigenweltSignInPayload>;
      if (!payload.apiKey || !payload.baseURL || !Array.isArray(payload.models)) {
        settleErr(new Error("Eigenwelt sign-in failed: the platform returned an incomplete payload."));
        return;
      }
      // Reconstruct explicitly so a legacy payload (no entitlements/platform*)
      // is delivered byte-for-byte, and the optional subscription fields are
      // normalized (never partially-formed) when the platform does send them.
      const delivered: EigenweltSignInPayload = {
        apiKey: payload.apiKey,
        baseURL: payload.baseURL,
        models: payload.models,
        ...(payload.orgId ? { orgId: payload.orgId } : {}),
        ...(payload.orgName ? { orgName: payload.orgName } : {}),
      };
      const entitlements = parseEigenweltEntitlements(payload.entitlements);
      if (entitlements) delivered.entitlements = entitlements;
      const account = parseEigenweltAccountIdentity(payload.account);
      if (account) delivered.account = account;
      if (typeof payload.platformToken === "string" && payload.platformToken.trim()) {
        delivered.platformToken = payload.platformToken;
      }
      if (typeof payload.accessTokenExpiresAt === "number" && payload.accessTokenExpiresAt > 0) {
        delivered.accessTokenExpiresAt = payload.accessTokenExpiresAt;
      }
      if (typeof payload.refreshToken === "string" && payload.refreshToken.trim()) {
        delivered.refreshToken = payload.refreshToken;
      }
      if (typeof payload.platformURL === "string" && payload.platformURL.trim()) {
        delivered.platformURL = payload.platformURL.replace(/\/+$/, "");
      }
      settleOk(delivered);
    } catch {
      settleErr(new Error("Eigenwelt sign-in failed: could not reach the Eigenwelt platform for the code exchange."));
    } finally {
      teardown();
    }
  };

  const { server, port } = await bindLoopback((req, res, boundPort) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const receivedState = url.searchParams.get("state");
    if (!code || receivedState !== state) {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid callback.");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(CALLBACK_HTML);
    void exchange(code, boundPort);
  });

  const timeout = setTimeout(() => {
    settleErr(new Error("Eigenwelt sign-in timed out. Start the sign-in again."));
    teardown();
  }, SIGN_IN_TIMEOUT_MS);
  timeout.unref?.();
  teardown = () => {
    clearTimeout(timeout);
    server.close();
  };

  sessions.set(sessionId, { result });

  const authorizeUrl = new URL(`${platform}/desktop/connect`);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("port", String(port));
  authorizeUrl.searchParams.set("code_challenge", challenge);

  return { sessionId, authorizeUrl: authorizeUrl.toString() };
}

/**
 * Long-poll a sign-in session. Resolves early with the exchange payload when
 * the browser flow completes, returns `{pending: true}` after `timeoutMs` so
 * the client can re-poll, and rejects with a clear message on failure.
 * Sessions are single-consume: once the payload (or failure) is delivered,
 * the session is gone.
 */
export async function waitForEigenweltSignIn(
  sessionId: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<EigenweltSignInPayload | { pending: true }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown or already-completed Eigenwelt sign-in session. Start the sign-in again.");
  }

  const pendingSentinel = Symbol("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      session.result,
      new Promise<typeof pendingSentinel>((resolve) => {
        timer = setTimeout(() => resolve(pendingSentinel), timeoutMs);
      }),
    ]);
    if (raced === pendingSentinel) return { pending: true };
    sessions.delete(sessionId);
    return raced;
  } catch (error) {
    sessions.delete(sessionId);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fetch the platform's public model manifest (gateway baseURL + model list).
 * Backs the "Paste an API key" path, where no exchange delivers the models.
 */
export async function fetchEigenweltManifest(): Promise<EigenweltManifest> {
  const platform = eigenweltPlatformUrl();
  let response: Response;
  try {
    response = await fetch(`${platform}/api/public/models`, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Could not reach the Eigenwelt platform.");
  }
  if (!response.ok) {
    throw new Error(`Could not reach the Eigenwelt platform (HTTP ${response.status}).`);
  }
  const payload = (await response.json().catch(() => null)) as
    | { baseURL?: unknown; models?: unknown }
    | null;
  if (!payload || typeof payload.baseURL !== "string" || !payload.baseURL || !Array.isArray(payload.models)) {
    throw new Error("The Eigenwelt platform returned an invalid models manifest.");
  }
  return { baseURL: payload.baseURL, models: payload.models as EigenweltManifestModel[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map manifest models to the engine's provider `models` block. Mirrors the
 * app's buildEigenweltProviderBlock — keep both in sync. `limit` MUST carry
 * BOTH context and output: one missing key invalidates the whole runtime
 * config in the engine's schema (verified).
 */
export function buildEigenweltModelsMap(models: EigenweltManifestModel[]): Record<string, unknown> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        name: model.name ?? model.id,
        tool_call: model.toolCall ?? true,
        reasoning: model.reasoning ?? false,
        limit: { context: model.contextLength ?? 128_000, output: 16_384 },
      },
    ]),
  );
}

const MODEL_REFRESH_THROTTLE_MS = 10 * 60 * 1000;
const modelRefreshLastRun = new Map<string, number>();

/**
 * Refresh the eigenwelt provider's model list from the platform manifest so
 * models added on the gateway appear on the next app start without
 * re-connecting. No-op when the workspace has no eigenwelt provider block.
 *
 * Fire-and-forget safe: throttled to one attempt per workspace per 10
 * minutes, never throws, and only writes the runtime config when the models
 * map actually changed (an unconditional write would rewrite the runtime
 * config file on every start). Preserves the stored npm/name/options.
 */
export async function refreshEigenweltProviderModels(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  try {
    const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
    const providers = isRecord(runtime.provider) ? runtime.provider : {};
    const eigenwelt = isRecord(providers.eigenwelt) ? providers.eigenwelt : null;
    if (!eigenwelt) return false;

    const now = Date.now();
    const last = modelRefreshLastRun.get(workspaceId) ?? 0;
    if (now - last < MODEL_REFRESH_THROTTLE_MS) return false;
    modelRefreshLastRun.set(workspaceId, now);

    let manifest: EigenweltManifest;
    try {
      manifest = await fetchEigenweltManifest();
    } catch (error) {
      console.debug(
        `eigenwelt model refresh skipped (${workspaceId}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    if (!manifest.models.length) return false;

    const nextModels = buildEigenweltModelsMap(manifest.models);
    const currentModels = isRecord(eigenwelt.models) ? eigenwelt.models : {};
    if (JSON.stringify(currentModels) === JSON.stringify(nextModels)) return false;

    await writeRuntimeOpencodeConfig(config, workspaceId, (current) => {
      const currentProviders = isRecord(current.provider) ? current.provider : {};
      const currentEigenwelt = isRecord(currentProviders.eigenwelt) ? currentProviders.eigenwelt : null;
      // Disconnected while we were fetching — leave the config alone.
      if (!currentEigenwelt) return current;
      return {
        ...current,
        provider: {
          ...currentProviders,
          eigenwelt: { ...currentEigenwelt, models: nextModels },
        },
      };
    });
    return true;
  } catch (error) {
    console.debug(
      `eigenwelt model refresh failed (${workspaceId}): ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
