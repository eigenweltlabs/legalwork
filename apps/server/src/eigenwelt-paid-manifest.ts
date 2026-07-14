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
 * Mirrors eigenwelt-free.ts. The key is carried in the provider block's
 * Authorization header (opencode passes provider `options` verbatim to
 * createOpenAICompatible and ignores a bare `apiKey`), never in auth.json.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

function parseManifestModel(value: unknown): EigenweltManifestModel | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null;
  return {
    id: value.id,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.contextLength === "number" ? { contextLength: value.contextLength } : {}),
    ...(typeof value.toolCall === "boolean" ? { toolCall: value.toolCall } : {}),
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
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
 * connected — nothing to refresh). Returns the model count and whether the
 * cache changed; the caller rebuilds the engine config file when it changed.
 * The fetch failure (unreachable gateway) is surfaced to the caller.
 */
export async function refreshEigenweltPaidManifest(
  config: ServerConfig,
): Promise<{ modelCount: number; changed: boolean }> {
  const cached = await readCachedEigenweltPaidManifest(config);
  if (!cached) return { modelCount: 0, changed: false };

  const { baseURL, models } = await fetchEigenweltManifest(); // throws on unreachable
  const next: EigenweltPaidManifest = { ...cached, baseURL, models };
  const changed = JSON.stringify(cached) !== JSON.stringify(next);
  if (changed) await writeCachedEigenweltPaidManifest(config, next);
  return { modelCount: next.models.length, changed };
}

/**
 * Engine provider block for the paid tier — injected into every workspace.
 * The key travels in the Authorization header (see file header); mirrors
 * buildEigenweltFreeProviderBlock.
 */
export function buildEigenweltPaidProviderBlock(manifest: EigenweltPaidManifest): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Eigenwelt Model API",
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
