/**
 * Eigenwelt FREE tier — the no-login provider every install gets.
 *
 * Access model: one virtual key PER DEVICE. On first refresh the server
 * POSTs its persisted device id to `${EIGENWELT_PLATFORM_URL}/api/public/free-key`
 * and receives `{apiKey, baseURL, models}` — a rate-limited, budget-capped
 * key minted just for this install. The platform derives the key alias from
 * the device id, so re-posting the same id ROTATES the key (the old one is
 * invalidated). Because of that, the mint happens ONCE: while a cached
 * apiKey exists it is never re-requested; later refreshes only update the
 * model list (and baseURL) via GET `/api/public/free-models`.
 *
 * Usage data for free traffic is logged (testing tier), unlike the paid
 * `eigenwelt` provider (connect flow, zero retention), which stays untouched.
 *
 * Design constraints this module satisfies:
 *  - buildLegalworkRuntimeConfigObject must never block on the network, so
 *    the manifest (key + models) is served from a DISK CACHE under the
 *    server's runtime storage dir. refreshEigenweltFreeManifest() updates
 *    that cache out-of-band (fire-and-forget from cli.ts / embedded.ts) and
 *    reports whether it changed so the caller can rewrite the engine config
 *    file.
 *  - A missing/corrupt cache simply means "no free provider yet"; the next
 *    refresh (or app restart with a reachable platform) mints a key and
 *    heals it.
 *  - Per-device limits live on the KEY itself (LiteLLM per-key rpm/budget),
 *    so no per-request device header is needed — the device id's only job
 *    is identifying this install to the mint endpoint.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import constants from "../../../constants.json" with { type: "json" };

import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/**
 * Base URL of the Eigenwelt platform (overridable for tests/staging).
 * Until the platform app is deployed, the free gateway itself serves the
 * public free-key/free-models endpoints (free-mint sidecar), so the default
 * is the gateway host; flip to the platform host when it ships.
 */
export function eigenweltPlatformUrl(): string {
  return (process.env.EIGENWELT_PLATFORM_URL ?? "https://free-api.eigenweltlabs.com").replace(/\/+$/, "");
}

/**
 * Baked-in mint token the free-key endpoint requires (x-eigenwelt-mint-key).
 * A bot filter, not auth: the release workflows inject the real value into
 * constants.json from the EIGENWELT_FREE_MINT_KEY repo secret before the
 * server builds (the checked-in value is empty — this repo is public). The
 * env var overrides for dev/tests.
 */
export function eigenweltFreeMintKey(): string {
  return process.env.EIGENWELT_FREE_MINT_KEY ?? constants.eigenweltFreeMintKey ?? "";
}

/** A model entry as the platform manifest reports it. */
export type EigenweltManifestModel = {
  id: string;
  name?: string;
  contextLength?: number;
  toolCall?: boolean;
  reasoning?: boolean;
};

/**
 * Map manifest models to the engine's provider `models` block. `limit` MUST
 * carry BOTH context and output: one missing key silently invalidates the
 * whole runtime config in the engine's schema and kills all plugins
 * (verified).
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

/** Provider id of the free, always-available Eigenwelt tier. */
export const EIGENWELT_FREE_PROVIDER_ID = "eigenwelt-free";

/**
 * The engine's built-in OpenCode Zen provider id. It auto-connects
 * anonymously; listing it in `disabled_providers` disables it (checked in
 * both the provider loader and the list handler). We disable it ONLY while
 * our free provider is actually available — otherwise a first launch with
 * the platform unreachable would lose free models entirely.
 */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode";

/** Free-manifest models may carry a description; the engine schema has no
 * such field, so it is accepted here and dropped when building the config. */
export type EigenweltFreeManifestModel = EigenweltManifestModel & { description?: string };

/** Disk-cache shape: the per-device key plus the last known gateway URL and
 * model list. `apiKey` is minted once (free-key) and preserved across model
 * refreshes (free-models). */
export type EigenweltFreeManifest = {
  baseURL: string;
  apiKey: string;
  models: EigenweltFreeManifestModel[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModels(value: unknown): EigenweltFreeManifestModel[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (model): model is EigenweltFreeManifestModel =>
      isRecord(model) && typeof model.id === "string" && model.id.length > 0,
  );
}

function parseEigenweltFreeManifest(value: unknown): EigenweltFreeManifest | null {
  if (!isRecord(value)) return null;
  if (typeof value.baseURL !== "string" || !value.baseURL) return null;
  if (typeof value.apiKey !== "string" || !value.apiKey) return null;
  const models = parseModels(value.models);
  if (!models) return null;
  return { baseURL: value.baseURL, apiKey: value.apiKey, models };
}

/**
 * Mint this device's own free-gateway key: POST the persisted device id to
 * the platform's public free-key endpoint. Returns the full manifest
 * `{apiKey, baseURL, models}`. Throws with a clear message when the platform
 * is unreachable, rate-limits the mint, or returns an invalid payload.
 *
 * WARNING: minting for an already-known device id ROTATES the key on the
 * platform side (old key invalidated) — callers must only mint when no
 * cached key exists.
 */
export async function mintEigenweltFreeDeviceKey(deviceId: string): Promise<EigenweltFreeManifest> {
  const platform = eigenweltPlatformUrl();
  const mintKey = eigenweltFreeMintKey();
  let response: Response;
  try {
    response = await fetch(`${platform}/api/public/free-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Required by the mint endpoint (401 without it) — see
        // eigenweltFreeMintKey. free-models needs no token.
        ...(mintKey ? { "x-eigenwelt-mint-key": mintKey } : {}),
      },
      body: JSON.stringify({ deviceId }),
    });
  } catch {
    throw new Error("Could not reach the Eigenwelt platform.");
  }
  if (!response.ok) {
    throw new Error(`The Eigenwelt platform did not issue a free key (HTTP ${response.status}).`);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  const manifest = parseEigenweltFreeManifest(payload);
  if (!manifest) {
    throw new Error("The Eigenwelt platform returned an invalid free-key payload.");
  }
  return manifest;
}

/**
 * Fetch the platform's free-models manifest (gateway baseURL + model list —
 * no key; keys are per-device via mintEigenweltFreeDeviceKey). Throws with a
 * clear message when the platform is unreachable or the payload is invalid —
 * callers fall back to the disk cache.
 */
export async function fetchEigenweltFreeModels(): Promise<{
  baseURL: string;
  models: EigenweltFreeManifestModel[];
}> {
  const platform = eigenweltPlatformUrl();
  let response: Response;
  try {
    response = await fetch(`${platform}/api/public/free-models`, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Could not reach the Eigenwelt platform.");
  }
  if (!response.ok) {
    throw new Error(`Could not reach the Eigenwelt platform (HTTP ${response.status}).`);
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || typeof payload.baseURL !== "string" || !payload.baseURL) {
    throw new Error("The Eigenwelt platform returned an invalid free-models manifest.");
  }
  const models = parseModels(payload.models);
  if (!models) {
    throw new Error("The Eigenwelt platform returned an invalid free-models manifest.");
  }
  return { baseURL: payload.baseURL, models };
}

/** On-disk cache of this device's free-tier manifest (key + models), so
 * offline restarts still get the free provider. Lives next to the runtime DB. */
export function eigenweltFreeManifestCachePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "eigenwelt-free-manifest.json");
}

/**
 * Read the cached manifest. Missing or corrupt cache files are treated as
 * "no manifest" (null) — never throws.
 */
export async function readCachedEigenweltFreeManifest(config: ServerConfig): Promise<EigenweltFreeManifest | null> {
  try {
    const raw = await readFile(eigenweltFreeManifestCachePath(config), "utf8");
    return parseEigenweltFreeManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function writeCachedEigenweltFreeManifest(config: ServerConfig, manifest: EigenweltFreeManifest): Promise<void> {
  const path = eigenweltFreeManifestCachePath(config);
  await mkdir(dirname(path), { recursive: true });
  // Atomic (temp file + rename) so a concurrent config build never reads a
  // partial cache.
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), "utf8");
  await rename(tmp, path);
}

const FREE_MANIFEST_REFRESH_THROTTLE_MS = 10 * 60 * 1000;
const freeManifestRefreshLastRun = new Map<string, number>();

/** Test-only: clear the refresh throttle so a test can drive several
 * refreshes against the same cache path. */
export function resetEigenweltFreeManifestRefreshThrottleForTests(): void {
  freeManifestRefreshLastRun.clear();
}

/**
 * Refresh the on-disk free-tier cache from the platform.
 *
 * Two modes, decided by the cache:
 *  - no cached key: mint this device's key ONCE via POST /api/public/free-key
 *    (deviceId = the persisted install id) and cache {apiKey, baseURL, models};
 *  - cached key present: NEVER re-mint (the platform rotates — and thereby
 *    invalidates — the key for a known device id); only GET
 *    /api/public/free-models and update models + baseURL around the kept key.
 *
 * Fire-and-forget safe: throttled to one attempt per cache path per 10
 * minutes, never throws, and only writes when the manifest actually changed.
 * Returns true when the cache changed — the caller should then rewrite the
 * engine-visible runtime config file (writeLegalworkRuntimeConfigFile) so
 * the free provider (and the zen disable that rides on it) update.
 *
 * An intentionally-empty model list IS written: the platform is
 * authoritative, and config injection already guards on >= 1 model, so an
 * emptied manifest removes the free provider and re-enables zen.
 */
export async function refreshEigenweltFreeManifest(config: ServerConfig): Promise<boolean> {
  try {
    const path = eigenweltFreeManifestCachePath(config);
    const now = Date.now();
    const last = freeManifestRefreshLastRun.get(path) ?? 0;
    if (now - last < FREE_MANIFEST_REFRESH_THROTTLE_MS) return false;
    freeManifestRefreshLastRun.set(path, now);

    const cached = await readCachedEigenweltFreeManifest(config);

    let manifest: EigenweltFreeManifest;
    try {
      if (cached) {
        // Key exists — refresh only the model catalog (and baseURL).
        const { baseURL, models } = await fetchEigenweltFreeModels();
        manifest = { ...cached, baseURL, models };
      } else {
        // First run (or corrupt cache): mint this device's key.
        manifest = await mintEigenweltFreeDeviceKey(await eigenweltFreeDeviceId(config));
      }
    } catch (error) {
      // Platform unreachable / invalid payload / mint refused — keep serving
      // the cache (or stay without a free provider until the next attempt).
      console.debug(
        `eigenwelt free-manifest refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    if (cached && JSON.stringify(cached) === JSON.stringify(manifest)) return false;
    await writeCachedEigenweltFreeManifest(config, manifest);
    return true;
  } catch (error) {
    console.debug(
      `eigenwelt free-manifest refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

const DEVICE_ID_FILE = "eigenwelt-free-device-id";
const deviceIdByPath = new Map<string, Promise<string>>();

/**
 * Stable per-install id sent to the platform's free-key mint endpoint.
 * A random UUID persisted in the runtime storage dir; memoized per path so
 * it stays stable within a process even if the file write fails.
 */
export function eigenweltFreeDeviceId(config: ServerConfig): Promise<string> {
  const path = join(runtimeStorageDir(config), DEVICE_ID_FILE);
  const existing = deviceIdByPath.get(path);
  if (existing) return existing;
  const promise = loadOrCreateDeviceId(path).catch(() => randomUUID());
  deviceIdByPath.set(path, promise);
  return promise;
}

async function loadOrCreateDeviceId(path: string): Promise<string> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (raw) return raw;
  } catch {
    // Missing file — mint a new id below.
  }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${id}\n`, "utf8");
  return id;
}

/**
 * Build the engine provider block for the free tier. Mirrors the paid
 * provider's shape (npm/name/options/models); buildEigenweltModelsMap
 * guarantees every model carries BOTH limit.context and limit.output — one
 * missing key silently invalidates the whole runtime config in the engine
 * schema and kills all plugins.
 */
export function buildEigenweltFreeProviderBlock(manifest: EigenweltFreeManifest): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Free",
    options: {
      baseURL: manifest.baseURL,
      // This device's own free-gateway key (minted via /api/public/free-key).
      // Rate/budget limits are enforced per key by the gateway. The engine
      // passes provider `options` verbatim to createOpenAICompatible, which
      // ignores an `apiKey` field — the key MUST travel as an Authorization
      // header (options.headers is verified to reach every request).
      headers: { Authorization: `Bearer ${manifest.apiKey}` },
    },
    models: buildEigenweltModelsMap(manifest.models),
  };
}
