/**
 * Global (account-level) manifest for the PAID Eigenwelt Model API provider.
 *
 * Eigenwelt is a firm account, not a per-workspace model provider — so its
 * gateway URL + key + model list live in ONE disk cache and the provider is
 * injected into EVERY workspace's engine config (see legalwork-runtime-config's
 * buildLegalworkRuntimeConfigObject), exactly like the free tier. Signing in
 * writes the cache; "Refresh models" and background refresh update the model
 * list around the kept key; signing out clears it.
 *
 * The key is carried in the provider block's
 * Authorization header (opencode passes provider `options` verbatim to
 * createOpenAICompatible and ignores a bare `apiKey`), never in auth.json.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  buildEigenweltModelsMap,
  fetchEigenweltManifest,
  type EigenweltManifestModel,
} from "./eigenwelt-auth.js";
import { EIGENWELT_ANALYTICS_ID_HEADER, launchAnalyticsId } from "./launch-analytics-id.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** Provider id of the connected (paid) Eigenwelt Model API. Keep in sync with
 *  the app's EIGENWELT_PROVIDER_ID. */
export const EIGENWELT_PROVIDER_ID = "eigenwelt";

export type EigenweltPaidManifest = {
  baseURL: string;
  apiKey: string;
  models: EigenweltManifestModel[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseManifestModel(value: unknown): EigenweltManifestModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  const description = optionalText(value.description);
  const region = optionalText(value.region);
  const hostedIn = optionalText(value.hostedIn);
  const upstreamModel = optionalText(value.upstreamModel);
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(description ? { description } : {}),
    ...(typeof value.contextLength === "number" ? { contextLength: value.contextLength } : {}),
    ...(typeof value.toolCall === "boolean" ? { toolCall: value.toolCall } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(region ? { region } : {}),
    ...(hostedIn ? { hostedIn } : {}),
    ...(upstreamModel ? { upstreamModel } : {}),
  };
}

export function parseManifestModels(value: unknown): EigenweltManifestModel[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseManifestModel).filter((m): m is EigenweltManifestModel => m !== null);
}

function parsePaidManifest(value: unknown): EigenweltPaidManifest | null {
  if (!isRecord(value)) return null;
  if (typeof value.baseURL !== "string" || !value.baseURL) return null;
  if (typeof value.apiKey !== "string" || !value.apiKey) return null;
  return { baseURL: value.baseURL, apiKey: value.apiKey, models: parseManifestModels(value.models) };
}

export function eigenweltPaidManifestCachePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "eigenwelt-manifest.json");
}

/** Read the cached paid manifest; missing/corrupt -> null (never throws). */
export async function readCachedEigenweltPaidManifest(
  config: ServerConfig,
): Promise<EigenweltPaidManifest | null> {
  try {
    const raw = await readFile(eigenweltPaidManifestCachePath(config), "utf8");
    return parsePaidManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

/** Persist the paid manifest (atomic temp+rename so a config build never reads a partial file). */
export async function writeCachedEigenweltPaidManifest(
  config: ServerConfig,
  manifest: EigenweltPaidManifest,
): Promise<void> {
  const path = eigenweltPaidManifestCachePath(config);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), "utf8");
  await rename(tmp, path);
}

/** Remove the cache (sign-out) — the provider then drops from every workspace. */
export async function clearCachedEigenweltPaidManifest(config: ServerConfig): Promise<void> {
  await rm(eigenweltPaidManifestCachePath(config), { force: true });
}

/**
 * Refresh the model list around the kept key (the manual "Refresh models"
 * button + background refresh). No-op when there is no cached manifest (not
 * connected — nothing to refresh). With the firm's desktop access token the
 * list is the firm's own (admin on/off applied); without one it is the
 * public catalog. Returns the model count and whether the cache changed; the
 * caller rebuilds the engine config file when it changed. The fetch failure
 * (unreachable gateway, dead token) is surfaced to the caller.
 */
export async function refreshEigenweltPaidManifest(
  config: ServerConfig,
  options?: { platformToken?: string | null },
): Promise<{ modelCount: number; changed: boolean }> {
  const cached = await readCachedEigenweltPaidManifest(config);
  if (!cached) return { modelCount: 0, changed: false };

  const { baseURL, models } = await fetchEigenweltManifest(options); // throws on unreachable
  const next: EigenweltPaidManifest = { ...cached, baseURL, models };
  const changed = JSON.stringify(cached) !== JSON.stringify(next);
  if (changed) await writeCachedEigenweltPaidManifest(config, next);
  return { modelCount: next.models.length, changed };
}

/**
 * Replace the cached model list with one the platform delivered on its own
 * (the token refresh payload carries the firm's current list). No-op when
 * not connected. Returns whether the cache changed.
 */
export async function applyEigenweltPaidManifestModels(
  config: ServerConfig,
  models: EigenweltManifestModel[],
): Promise<boolean> {
  const cached = await readCachedEigenweltPaidManifest(config);
  if (!cached) return false;
  if (JSON.stringify(cached.models) === JSON.stringify(models)) return false;
  await writeCachedEigenweltPaidManifest(config, { ...cached, models });
  return true;
}

/**
 * Fingerprint of the served model list, so the app can tell a poll that
 * changed the models (reload the engine's providers) from one that did not.
 * Order-independent; null when not connected.
 */
export function eigenweltPaidManifestRevision(manifest: EigenweltPaidManifest | null): string | null {
  if (!manifest) return null;
  const models = [...manifest.models].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha1").update(JSON.stringify(models)).digest("hex").slice(0, 16);
}

/**
 * Engine provider block for the paid tier — injected into every workspace.
 * The key travels in the Authorization header (see file header); mirrors
 * the standard OpenAI-compatible provider block shape.
 */
export function buildEigenweltPaidProviderBlock(manifest: EigenweltPaidManifest): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Subscription",
    options: {
      baseURL: manifest.baseURL,
      headers: {
        Authorization: `Bearer ${manifest.apiKey}`,
        [EIGENWELT_ANALYTICS_ID_HEADER]: launchAnalyticsId(),
      },
    },
    models: buildEigenweltModelsMap(manifest.models),
  };
}
